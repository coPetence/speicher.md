/**
 * Discover and register repos from configured forges, rename repos, validate PRs
 *
 * Registration walks forge installations and their repos, persisting rows in
 * `installations` and `repos`.  A repo already known is updated, one that does
 * not exist is created.  For git-type forges an explicit config list determines
 * which repo IDs to sync; repos not listed are stored but not synced
 *
 * Not run on every request, triggered by a scheduler or admin API
 */

import { promises as fs } from 'node:fs';

import { Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';

import { groupReach } from '../auth/directory/lookup';
import { TwoAudienceError } from '../common/errors';
import { Logger, rootLogger } from '../common/logger';
import { parsePrincipal } from '../common/principals';
import { makeTempDir } from '../common/temp-dir';
import { slugify } from '../common/slug';
import { ConfigService } from '../config/config.service';
import { RoutingService } from '../content-reader/routing';
import { Installation, Repo, RepoSlugHistory, initModels } from '../db/models';
import { getSequelize } from '../db/sequelize';
import { ForgeDriver, RemoteInstallation, RemoteRepo } from '../forge/driver';
import { ForgeRegistry } from '../forge/registry';
import { DirectoryLookup } from '../ingest/grants';
import { IngestService } from '../ingest/ingest.service';
import { checkoutIncludedFiles } from '../ingest/select';
import { WalkResult, walkRepo } from '../ingest/walk/walk';

export interface RepoRowChanges {
  registered: string[];
  removed: string[];
}

interface ListedRepos {
  installation: Installation | null;
  repos: RemoteRepo[];
}

const NO_CHANGES: RepoRowChanges = { registered: [], removed: [] };

// An archived repo is removed, as on its webhook, so it counts as unlisted until it is unarchived
async function currentRepos(driver: ForgeDriver, installationId: string): Promise<RemoteRepo[]> {
  return (await driver.listRepos(installationId)).filter((remote) => !remote.archived);
}

@Injectable()
export class RegistrationService {
  private readonly log: Logger = rootLogger.child('registration');

  constructor(
    private readonly config: ConfigService,
    private readonly forges: ForgeRegistry,
    private readonly routing: RoutingService,
    private readonly ingest: IngestService,
  ) {
    initModels();
  }

  /** IDs of all repos belonging to a tenant */
  async allRepoIds(tenantId: string): Promise<string[]> {
    const rows = await getSequelize().query<{ id: string }>(
      `SELECT id FROM repos WHERE tenant_id = :tenantId`,
      { type: QueryTypes.SELECT, replacements: { tenantId } },
    );
    return rows.map((r) => r.id);
  }

  /**
   * syncInstallationAndRepoRows creates or updates the installation rows of one forge, then the repository rows of
   * each installation that is not suspended. Before it writes them, it removes the repos no installation lists
   * anymore, e.g. deleted on GitHub, so a repo created again under the name of one of them is registered in the same
   * run. A forge without installations, such as a plain `git` remote, has only its repository rows written.
   *
   * @param tenantId the tenant
   * @param forgeKey the forge's short id
   */
  async syncInstallationAndRepoRows(tenantId: string, forgeKey: string): Promise<RepoRowChanges> {
    const driver = this.forges.driver(forgeKey);
    if (!driver) return NO_CHANGES;

    if (!driver.hasInstallations) {
      return this.syncRepoRowsForInstallation(tenantId, null, forgeKey);
    }

    const forge = await this.forges.forgeRowByKey(tenantId, forgeKey);
    if (!forge) return NO_CHANGES;

    const installations = await driver.listInstallations();
    this.log.info('listed installations', { forge: forgeKey, count: installations.length });
    const listings: ListedRepos[] = [];
    for (const remote of installations) {
      const installation = await this.recordInstallation(tenantId, forge.id, remote);

      if (remote.suspended) {
        this.log.info('skipping a suspended installation', {
          forge: forgeKey,
          namespace: remote.namespace,
        });
        continue;
      }
      listings.push({ installation, repos: await currentRepos(driver, remote.installationId) });
    }

    const removed = await this.removeUnlisted(tenantId, forge.id, listings);
    const registered: string[] = [];
    for (const listing of listings) {
      registered.push(...(await this.writeRepoRows(tenantId, forge.id, forgeKey, listing)));
    }
    return { registered, removed };
  }

  /** Upsert an installation row, preserving an existing suspended_at on conflict */
  private async recordInstallation(
    tenantId: string,
    forgeId: string,
    remote: RemoteInstallation,
  ): Promise<Installation | null> {
    await getSequelize().query(
      `INSERT INTO installations
         (tenant_id, forge_id, forge_installation_id, namespace, namespace_id, account_type, suspended_at)
       VALUES (:tenantId, :forgeId, :installationId, :namespace, :namespaceId, :accountType,
               CASE WHEN :suspended::boolean THEN now() ELSE NULL END)
       ON CONFLICT (tenant_id, forge_id, forge_installation_id) DO UPDATE SET
         namespace = EXCLUDED.namespace,
         namespace_id = EXCLUDED.namespace_id,
         account_type = EXCLUDED.account_type,
         suspended_at = CASE
           WHEN :suspended::boolean THEN COALESCE(installations.suspended_at, now())
           ELSE NULL
         END`,
      {
        type: QueryTypes.INSERT,
        replacements: {
          tenantId,
          forgeId,
          installationId: remote.installationId,
          namespace: remote.namespace,
          namespaceId: remote.namespaceId || null,
          accountType: remote.accountType,
          suspended: remote.suspended,
        },
      },
    );
    return Installation.findOne({
      where: {
        tenant_id: tenantId,
        forge_id: forgeId,
        forge_installation_id: remote.installationId,
      },
    });
  }

  /**
   * syncRepoRowsForInstallation lists the repositories one GitHub App installation can read, removes the repos of the
   * installation it no longer lists, and creates or updates the rows of the others.
   *
   * @param tenantId the tenant
   * @param forgeInstallationId the installation on the forge, or null for a forge without installations
   * @param forgeKey the forge's short id
   */
  async syncRepoRowsForInstallation(
    tenantId: string,
    forgeInstallationId: string | null,
    forgeKey: string,
  ): Promise<RepoRowChanges> {
    const driver = this.forges.driver(forgeKey);
    if (!driver) return NO_CHANGES;
    const forge = await this.forges.forgeRowByKey(tenantId, forgeKey);
    if (!forge) return NO_CHANGES;

    const installation = forgeInstallationId
      ? await this.installationRow(tenantId, forge.id, forgeKey, driver, forgeInstallationId)
      : null;
    if (forgeInstallationId && !installation) return NO_CHANGES;

    const listing = { installation, repos: await currentRepos(driver, forgeInstallationId ?? '') };

    const removed = installation
      ? await this.removeUnlisted(tenantId, forge.id, [listing], installation.id)
      : [];
    return { registered: await this.writeRepoRows(tenantId, forge.id, forgeKey, listing), removed };
  }

  /**
   * removeUnlisted removes the repos of a forge that its installations no longer list, and returns their ids. The
   * repos of a suspended installation are kept.
   *
   * @param tenantId the tenant
   * @param forgeId the forge's row
   * @param listings what the installations list
   * @param installationId the installation's row, to look at its repos only
   */
  private async removeUnlisted(
    tenantId: string,
    forgeId: string,
    listings: ListedRepos[],
    installationId?: string,
  ): Promise<string[]> {
    const listed = new Set(listings.flatMap((listing) => listing.repos.map((r) => r.forgeRepoId)));
    const rows = await getSequelize().query<{ id: string; forge_repo_id: string }>(
      `SELECT r.id, r.forge_repo_id FROM repos r
         JOIN installations i ON i.id = r.installation_id
        WHERE r.tenant_id = :tenantId AND r.forge_id = :forgeId AND i.suspended_at IS NULL
          ${installationId ? 'AND r.installation_id = :installationId' : ''}`,
      { type: QueryTypes.SELECT, replacements: { tenantId, forgeId, installationId } },
    );
    const unlisted = rows.filter((row) => !listed.has(row.forge_repo_id)).map((row) => row.id);
    for (const repoId of unlisted) {
      await this.ingest.removeRepo(repoId);
      this.log.info('removed a repo its installation no longer lists', { repo_id: repoId });
    }
    return unlisted;
  }

  // Creates or updates the rows of the listed repos, and returns the ids of the ones it created
  private async writeRepoRows(
    tenantId: string,
    forgeId: string,
    forgeKey: string,
    { installation, repos }: ListedRepos,
  ): Promise<string[]> {
    const registered: string[] = [];
    for (const remote of repos) {
      const slug = slugify(remote.name);
      const existing = await Repo.findOne({
        where: { tenant_id: tenantId, forge_id: forgeId, forge_repo_id: remote.forgeRepoId },
      });

      try {
        await this.routing.assertFirstSegmentFree(
          tenantId,
          forgeKey,
          remote.namespace,
          slug,
          existing?.id,
        );
      } catch (err) {
        if (err instanceof TwoAudienceError) {
          // Slug collision between two repo routes that share a first path segment
          this.log.error('first-segment collision at registration', {
            detail: err.adminMessage,
          });
          continue;
        }
        throw err;
      }

      const pollIntervalMs = this.config.pollIntervalMs(forgeKey, remote.forgeRepoId);

      if (existing) {
        // Refresh metadata on every scan so renames and branch changes are picked up
        if (slug !== existing.slug) await this.renameRepo(tenantId, existing.id, remote.name);
        await existing.update({
          namespace: remote.namespace,
          namespace_id: remote.namespaceId,
          // Preserve an explicit branch set by the user when the remote has none
          branch: remote.defaultBranch || existing.branch,
          installation_id: installation?.id ?? existing.installation_id,
          poll_interval_ms: pollIntervalMs,
          updated_at: new Date(),
        });
        continue;
      }

      const created = await Repo.create({
        tenant_id: tenantId,
        forge_id: forgeId,
        installation_id: installation?.id ?? null,
        forge_repo_id: remote.forgeRepoId,
        namespace: remote.namespace,
        namespace_id: remote.namespaceId,
        slug,
        branch: remote.defaultBranch,
        poll_interval_ms: pollIntervalMs,
      });
      registered.push(created.id);
      this.log.info('registered repo', { namespace: remote.namespace, slug });
    }
    return registered;
  }

  /** Resolve an installation row, fetching from the forge if not yet stored */
  private async installationRow(
    tenantId: string,
    forgeId: string,
    forgeKey: string,
    driver: ForgeDriver,
    forgeInstallationId: string,
  ): Promise<Installation | null> {
    const stored = await Installation.findOne({
      where: { tenant_id: tenantId, forge_id: forgeId, forge_installation_id: forgeInstallationId },
    });
    if (stored) return stored;
    if (!driver.hasInstallations) return null;

    const remote = (await driver.listInstallations()).find(
      (candidate) => candidate.installationId === forgeInstallationId,
    );
    if (!remote) {
      this.log.warn('the forge does not list this installation', {
        forge: forgeKey,
        installation_id: forgeInstallationId,
      });
      return null;
    }
    return this.recordInstallation(tenantId, forgeId, remote);
  }

  /** IDs of repos not in the git forge's explicit config list (not synced) */
  async unconfiguredRepoIds(tenantId: string, forgeKey: string): Promise<string[]> {
    if (this.config.forge(forgeKey)?.type !== 'git') return [];
    const configured = new Set(this.config.gitRepos(forgeKey).map((repo) => repo.id));

    const rows = await getSequelize().query<{ id: string; forge_repo_id: string }>(
      `SELECT r.id, r.forge_repo_id FROM repos r
         JOIN forges f ON f.id = r.forge_id
        WHERE r.tenant_id = :tenantId AND f.key = :forgeKey`,
      { type: QueryTypes.SELECT, replacements: { tenantId, forgeKey } },
    );
    return rows.filter((row) => !configured.has(row.forge_repo_id)).map((row) => row.id);
  }

  /** Update a repo's slug and propagate the change to slug history and documents */
  async renameRepo(tenantId: string, repoId: string, newName: string): Promise<void> {
    const repo = await Repo.findByPk(repoId);
    if (!repo) return;
    const newSlug = slugify(newName);
    if (newSlug === repo.slug) return;

    const forge = await getSequelize().query<{ key: string }>(
      `SELECT key FROM forges WHERE id = :forgeId`,
      { type: QueryTypes.SELECT, replacements: { forgeId: repo.forge_id } },
    );
    const forgeKey = forge[0]?.key ?? '';

    try {
      await this.routing.assertFirstSegmentFree(
        tenantId,
        forgeKey,
        repo.namespace,
        newSlug,
        repo.id,
      );
    } catch (err) {
      if (err instanceof TwoAudienceError) {
        this.log.error('rename refused', { detail: err.adminMessage });
        return;
      }
      throw err;
    }

    await getSequelize().transaction(async (tx) => {
      // Retire any stale slug-history entry from a repo already using this slug
      const [retired] = await getSequelize().query<{ id: string; old_slug: string }>(
        `UPDATE repo_slug_history SET retired_at = now(), retired_by_repo_id = :repoId
          WHERE tenant_id = :tenantId AND namespace = :namespace AND old_slug = :newSlug
            AND retired_at IS NULL
          RETURNING id, old_slug`,
        {
          transaction: tx,
          type: QueryTypes.SELECT,
          replacements: { tenantId, namespace: repo.namespace, newSlug, repoId: repo.id },
        },
      );
      if (retired) {
        this.log.warn('retired a slug-history redirect claimed by a live repo', {
          slug: retired.old_slug,
          namespace: repo.namespace,
        });
      }

      await RepoSlugHistory.create(
        {
          tenant_id: tenantId,
          repo_id: repo.id,
          namespace: repo.namespace,
          old_slug: repo.slug,
        },
        { transaction: tx },
      );
      await Repo.update(
        { slug: newSlug, updated_at: new Date() },
        { where: { id: repo.id }, transaction: tx },
      );
      // Keep document routes in sync with the new slug
      for (const table of ['documents']) {
        await getSequelize().query(
          `UPDATE ${table} SET repo_slug = :newSlug WHERE repo_id = :repoId`,
          { transaction: tx, type: QueryTypes.UPDATE, replacements: { newSlug, repoId: repo.id } },
        );
      }
    });

    this.log.info('repo renamed', { from: repo.slug, to: newSlug });
  }

  /** Check a PR's config by cloning, walking the tree, and posting a commit status */
  async validatePullRequest(repoId: string, sha: string): Promise<void> {
    const repo = await Repo.findByPk(repoId);
    if (!repo) return;
    const driver = await this.forges.driverForRepo(repo);
    const remote = await this.forges.remoteRepoFor(repo);
    if (!driver || !remote) return;

    const workingTree = await makeTempDir(`pr-${remote.forgeRepoId}`);
    try {
      const directory = await this.forges.directoryFor(driver.key);
      let walk: WalkResult | undefined;
      await driver.checkout(remote, sha, workingTree, async (tree) => {
        await checkoutIncludedFiles(tree, this.config);
        walk = await walkRepo({
          workingTree,
          config: this.config,
          repo: { namespace: repo.namespace, slug: repo.slug },
          // Directory lookups are only available when the forge is backed by one
          directory,
          commit: tree,
        });
      });
      if (!walk) throw new Error(`checking out ${sha} did not walk it`);
      const rejections = walk.findings.rejections;

      await driver.reportCheck(remote, sha, {
        conclusion: rejections.length === 0 ? 'success' : 'failure',
        title:
          rejections.length === 0
            ? 'Configuration valid'
            : `speicher.md — ${rejections.length} problem(s)`,
        summary: await this.checkSummary(directory, walk.findings.toAuthorText(), walk),
      });
    } catch (err) {
      await driver.reportCheck(remote, sha, {
        conclusion: 'failure',
        title: 'Validation error',
        // Full error is sensitive; only admin sees the log
        summary:
          'Validation could not be completed due to an internal error. The error ' +
          'details have been logged for the administrator.',
      });
      this.log.error('pull-request validation failed', { error: (err as Error).message });
    } finally {
      await fs.rm(workingTree, { recursive: true, force: true });
    }
  }

  private checkSummary(
    directory: DirectoryLookup | undefined,
    findingsText: string,
    walk: { documents: { principals: string[] }[]; assets: unknown[] },
  ): Promise<string> {
    return checkSummary(this.config, directory, findingsText, walk);
  }
}

/** Build the human-readable summary posted as a PR check report */
export async function checkSummary(
  config: ConfigService,
  // Undefined when no directory provider is configured for this forge
  directory: DirectoryLookup | undefined,
  findingsText: string,
  walk: { documents: { principals: string[] }[]; assets: unknown[] },
): Promise<string> {
  const lines: string[] = [];
  if (findingsText) lines.push(findingsText, '');
  lines.push(
    `${walk.documents.length} page(s) and ${walk.assets.length} asset(s) would be ingested.`,
  );

  const hasDirectory = config.providerShortIds.some((id) => {
    const provider = config.provider(id);
    return provider !== undefined && 'directory' in provider && provider.directory !== undefined;
  });
  if (!hasDirectory) {
    lines.push(
      '',
      'Group sizes are not shown: no auth provider has a `directory` block, so the ' +
        'number of readers a grant reaches cannot be resolved.',
    );
    return lines.join('\n');
  }

  const named = new Set<string>();
  for (const document of walk.documents) {
    for (const principal of document.principals) {
      const parsed = parsePrincipal(principal);
      if (parsed?.kind === 'group') named.add(parsed.name);
    }
  }

  const reach = await groupReach(config, directory, [...named].sort());
  if (reach.length > 0) {
    lines.push('', 'Access in this change reaches:');
    for (const group of reach) {
      // Null size means the directory provider could not resolve membership
      lines.push(
        group.size === null
          ? `- \`${group.name}\` — size unknown`
          : `- \`${group.name}\` — up to ${group.size} reader(s)`,
      );
      if (group.directoryUrl) lines.push(`  ${group.directoryUrl}`);
    }
  }
  return lines.join('\n');
}

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
import { join } from 'node:path';

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
import { ForgeDriver, RemoteInstallation } from '../forge/driver';
import { ForgeRegistry } from '../forge/registry';
import { DirectoryLookup } from '../ingest/grants';
import { walkRepo } from '../ingest/walk/walk';
import { MIRROR_ROOT } from './sync.service';

@Injectable()
export class RegistrationService {
  private readonly log: Logger = rootLogger.child('registration');

  constructor(
    private readonly config: ConfigService,
    private readonly forges: ForgeRegistry,
    private readonly routing: RoutingService,
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
   * Create or update the installation rows of one forge, then the repository rows of
   * each installation that is not suspended. A forge without installations, such as a
   * plain `git` remote, has only its repository rows written. Returns the ids of the
   * repos it registered.
   */
  async syncInstallationAndRepoRows(tenantId: string, forgeKey: string): Promise<string[]> {
    const driver = this.forges.driver(forgeKey);
    if (!driver) return [];

    if (!driver.hasInstallations) {
      return this.syncRepoRowsForInstallation(tenantId, null, forgeKey);
    }

    const forge = await this.forges.forgeRowByKey(tenantId, forgeKey);
    if (!forge) return [];

    const installations = await driver.listInstallations();
    this.log.info('listed installations', { forge: forgeKey, count: installations.length });
    const registered: string[] = [];
    for (const remote of installations) {
      await this.recordInstallation(tenantId, forge.id, remote);

      if (remote.suspended) {
        this.log.info('skipping a suspended installation', {
          forge: forgeKey,
          namespace: remote.namespace,
        });
        continue;
      }
      registered.push(
        ...(await this.syncRepoRowsForInstallation(tenantId, remote.installationId, forgeKey)),
      );
    }
    return registered;
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
   * List the repositories one GitHub App installation can read and create or update their rows.
   * Returns the ids of the repos it registered.
   */
  async syncRepoRowsForInstallation(
    tenantId: string,
    forgeInstallationId: string | null,
    forgeKey: string,
  ): Promise<string[]> {
    const driver = this.forges.driver(forgeKey);
    if (!driver) return [];
    const forge = await this.forges.forgeRowByKey(tenantId, forgeKey);
    if (!forge) return [];

    const installation = forgeInstallationId
      ? await this.installationRow(tenantId, forge.id, forgeKey, driver, forgeInstallationId)
      : null;
    if (forgeInstallationId && !installation) return [];

    const repos = await driver.listRepos(forgeInstallationId ?? '');
    const registered: string[] = [];
    for (const remote of repos) {
      const slug = slugify(remote.name);
      const existing = await Repo.findOne({
        where: { tenant_id: tenantId, forge_id: forge.id, forge_repo_id: remote.forgeRepoId },
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
        forge_id: forge.id,
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

    const mirrorDir = join(MIRROR_ROOT, driver.key, `${remote.forgeRepoId}.git`);
    await driver.fetchInto(remote, mirrorDir);

    const workingTree = await makeTempDir(`pr-${remote.forgeRepoId}`);
    try {
      await driver.checkout(mirrorDir, sha, workingTree);
      const directory = await this.forges.directoryFor(driver.key);
      const walk = await walkRepo({
        workingTree,
        config: this.config,
        repo: { namespace: repo.namespace, slug: repo.slug },
        // Directory lookups are only available when the forge is backed by one
        directory,
      });
      const rejections = walk.findings.rejections;

      await driver.reportCheck(remote, sha, {
        conclusion: rejections.length === 0 ? 'success' : 'failure',
        title:
          rejections.length === 0
            ? 'Configuration valid'
            : `speicher — ${rejections.length} problem(s)`,
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

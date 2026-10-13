/**
 * URL routing for repository pages
 *
 * Segments after the tenant prefix are matched against repos in one of four
 * schemes: explicit forge with namespace, explicit forge in its default namespace,
 * primary forge with namespace, or primary forge in its default namespace.  The
 * first match wins.  If no match, tries a rename lookup and returns a redirect to
 * the current slug
 *
 * A repo whose forge+namespace combination claims the first path segment
 * cannot be created with a slug that is reserved, equals a non-primary forge
 * id, matches another namespace's slug, or duplicates an existing repo
 */
import { Injectable } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';

import { TwoAudienceError } from '../common/errors';
import { isReservedSegment, slugify } from '../common/slug';
import { ConfigService } from '../config/config.service';
import { getSequelize } from '../db/sequelize';

export interface ResolvedRoute {
  repoId: string;
  namespace: string;
  repoSlug: string;
  forgeKey: string;

  slugPath: string;

  redirectTo?: string; // Set when the repo is matched via slug history
}

export interface RepoRow {
  id: string;
  namespace: string;
  slug: string;
  forge_key: string;
  forge_is_primary: boolean;
  forge_default_repository_owner: string | null;
}

export function repoRefOf(route: ResolvedRoute): {
  namespace: string;
  slug: string;
  forge_key: string;
} {
  return { namespace: route.namespace, slug: route.repoSlug, forge_key: route.forgeKey };
}

@Injectable()
export class RoutingService {
  constructor(
    private readonly config: ConfigService,
    private readonly sequelize: Sequelize = getSequelize(),
  ) {}

  async resolve(tenantId: string, segments: string[]): Promise<ResolvedRoute | null> {
    if (segments.length === 0) return null;

    if (isReservedSegment(segments[0])) return null;

    const candidates = this.candidateSplits(segments);
    for (const candidate of candidates) {
      const repo = await this.findRepo(
        tenantId,
        candidate.forgeKey,
        candidate.namespace,
        candidate.slug,
      );
      if (repo) {
        return {
          repoId: repo.id,
          namespace: repo.namespace,
          repoSlug: repo.slug,
          forgeKey: repo.forge_key,
          slugPath: candidate.rest.join('/'),
        };
      }
    }

    // Fallback: renamed repo via slug history, with a redirect
    for (const candidate of candidates) {
      const renamed = await this.findRenamedRepo(tenantId, candidate.namespace, candidate.slug);
      if (renamed) {
        return {
          repoId: renamed.id,
          namespace: renamed.namespace,
          repoSlug: renamed.slug,
          forgeKey: renamed.forge_key,
          slugPath: candidate.rest.join('/'),
          redirectTo: this.publicPathFor(renamed, candidate.rest.join('/')),
        };
      }
    }

    return null;
  }

  /**
   * Enumerate possible interpretations of path segments by descending
   * specificity
   */
  private candidateSplits(
    segments: string[],
  ): { forgeKey: string; namespace: string | null; slug: string; rest: string[] }[] {
    const out: { forgeKey: string; namespace: string | null; slug: string; rest: string[] }[] = [];
    const primary = this.config.primaryForgeId;

    if (primary === null) return out;

    if (this.config.forge(segments[0]) && segments[0] !== primary) {
      if (segments.length >= 3) {
        out.push({
          forgeKey: segments[0],
          namespace: segments[1],
          slug: segments[2],
          rest: segments.slice(3),
        });
      }

      // A non-primary forge leaves its default repository owner out as well, after its id
      const forgeOwner = this.config.defaultRepositoryOwnerFor(segments[0]);
      if (forgeOwner !== undefined && segments.length >= 2) {
        out.push({
          forgeKey: segments[0],
          namespace: slugify(forgeOwner),
          slug: segments[1],
          rest: segments.slice(2),
        });
      }
    }

    if (segments.length >= 2) {
      out.push({
        forgeKey: primary,
        namespace: segments[0],
        slug: segments[1],
        rest: segments.slice(2),
      });
    }

    const defaultOwner = this.config.defaultRepositoryOwnerFor(primary);
    if (defaultOwner !== undefined) {
      out.push({
        forgeKey: primary,
        namespace: slugify(defaultOwner),
        slug: segments[0],
        rest: segments.slice(1),
      });
    }

    return out;
  }

  /** `namespace` is a URL segment, so it is compared against the slug of the stored one */
  private async findRepo(
    tenantId: string,
    forgeKey: string,
    namespace: string | null,
    slug: string,
  ): Promise<RepoRow | null> {
    if (namespace === null) return null;
    const rows = await this.sequelize.query<RepoRow>(
      `SELECT r.id, r.namespace, r.slug, f.key AS forge_key,
              f.is_primary AS forge_is_primary, f.default_repository_owner AS forge_default_repository_owner
         FROM repos r JOIN forges f ON f.id = r.forge_id
        WHERE r.tenant_id = :tenantId AND f.key = :forgeKey AND r.slug = :slug`,
      { type: QueryTypes.SELECT, replacements: { tenantId, forgeKey, slug } },
    );
    return rows.find((row) => slugify(row.namespace) === namespace) ?? null;
  }

  /** Look up the most recent active rename for a (namespace, oldSlug) pair */
  private async findRenamedRepo(
    tenantId: string,
    namespace: string | null,
    oldSlug: string,
  ): Promise<RepoRow | null> {
    if (namespace === null) return null;
    const rows = await this.sequelize.query<RepoRow & { old_namespace: string }>(
      `SELECT r.id, r.namespace, r.slug, f.key AS forge_key,
              f.is_primary AS forge_is_primary, f.default_repository_owner AS forge_default_repository_owner,
              h.namespace AS old_namespace
         FROM repo_slug_history h
         JOIN repos r ON r.id = h.repo_id
         JOIN forges f ON f.id = r.forge_id
        WHERE h.tenant_id = :tenantId AND h.old_slug = :oldSlug AND h.retired_at IS NULL
        ORDER BY h.created_at DESC`,
      { type: QueryTypes.SELECT, replacements: { tenantId, oldSlug } },
    );
    return rows.find((row) => slugify(row.old_namespace) === namespace) ?? null;
  }

  /** Public URL prefix for a repo, accounting for forge and default repository owner */
  publicBaseFor(repo: { namespace: string; slug: string; forge_key: string }): string {
    const parts: string[] = [];
    if (repo.forge_key !== this.config.primaryForgeId) parts.push(repo.forge_key);
    const defaultOwner = this.config.defaultRepositoryOwnerFor(repo.forge_key);
    if (defaultOwner === undefined || slugify(repo.namespace) !== slugify(defaultOwner)) {
      parts.push(slugify(repo.namespace));
    }
    parts.push(repo.slug);
    return `/${parts.join('/')}`;
  }

  /** Public URL for a repo with a slugPath (may be empty, representing the root) */
  publicPathFor(
    repo: { namespace: string; slug: string; forge_key: string },
    slugPath: string,
  ): string {
    const base = this.publicBaseFor(repo);
    return slugPath === '' ? `${base}/` : `${base}/${slugPath}`;
  }

  /**
   * assertFirstSegmentFree checks that a repository does not claim a URL segment that
   * is already used. On the primary forge this is the first segment, which also must
   * not be reserved or a forge id. On any other forge it is the segment after the
   * forge id. A repository of the default repository owner claims its own slug; any
   * other repository claims the slug of its owner. It throws a `TwoAudienceError` if
   * the segment is taken.
   *
   * @param tenantId the tenant the repository belongs to
   * @param forgeKey the forge the repository is on
   * @param namespace the user or organization that owns the repository
   * @param slug the repository's URL slug
   * @param excludeRepoId the repository itself, when it is already registered
   */
  async assertFirstSegmentFree(
    tenantId: string,
    forgeKey: string,
    namespace: string,
    slug: string,
    excludeRepoId?: string,
  ): Promise<void> {
    const primary = forgeKey === this.config.primaryForgeId;
    const defaultOwner = this.config.defaultRepositoryOwnerFor(forgeKey);
    const defaultOwnerSlug = defaultOwner === undefined ? undefined : slugify(defaultOwner);
    const isDefaultOwner = slugify(namespace) === defaultOwnerSlug;
    const segment = isDefaultOwner ? slug : slugify(namespace);
    const claimant = isDefaultOwner
      ? `repo slug "${slug}" of the default repository owner ${namespace}`
      : `repository owner "${namespace}"`;

    if (primary && isReservedSegment(segment)) {
      throw new TwoAudienceError(
        `"${segment}" is a reserved name. Choose another, or ask an administrator which segment is free.`,
        `${claimant} (forge ${forgeKey}) lands on the reserved first segment "${segment}"`,
      );
    }

    if (primary && this.config.forge(segment) && segment !== this.config.primaryForgeId) {
      throw new TwoAudienceError(
        `"${segment}" is already claimed. Choose another name, or ask an administrator which segment is free.`,
        `${claimant} collides with forge id "${segment}"`,
      );
    }

    if (!isDefaultOwner) {
      if (defaultOwnerSlug === undefined) return;
      const taken = await this.sequelize.query<{ id: string; namespace: string }>(
        `SELECT r.id, r.namespace FROM repos r JOIN forges f ON f.id = r.forge_id
          WHERE r.tenant_id = :tenantId AND f.key = :forgeKey AND r.slug = :segment`,
        { type: QueryTypes.SELECT, replacements: { tenantId, forgeKey, segment } },
      );
      const repo = taken.find((row) => slugify(row.namespace) === defaultOwnerSlug);
      if (repo) {
        throw new TwoAudienceError(
          `"${segment}" is already claimed. Ask an administrator which segment is free.`,
          `${claimant} collides with repo "${segment}" of the default repository owner (repo id ${repo.id})`,
        );
      }
      return;
    }

    const owners = await this.sequelize.query<{ namespace: string }>(
      `SELECT DISTINCT r.namespace FROM repos r JOIN forges f ON f.id = r.forge_id
        WHERE r.tenant_id = :tenantId AND f.key = :forgeKey`,
      { type: QueryTypes.SELECT, replacements: { tenantId, forgeKey } },
    );
    const owner = owners.find(
      (row) => slugify(row.namespace) !== defaultOwnerSlug && slugify(row.namespace) === slug,
    );
    if (owner) {
      throw new TwoAudienceError(
        `"${slug}" is already claimed. Choose another name, or ask an administrator which segment is free.`,
        `${claimant} collides with repository owner "${owner.namespace}" on forge ${forgeKey}`,
      );
    }

    const rows = (
      await this.sequelize.query<{ id: string; namespace: string; slug: string }>(
        `SELECT r.id, r.namespace, r.slug FROM repos r JOIN forges f ON f.id = r.forge_id
          WHERE r.tenant_id = :tenantId AND f.key = :forgeKey AND r.slug = :slug
            AND (:excludeRepoId::uuid IS NULL OR r.id <> :excludeRepoId::uuid)`,
        {
          type: QueryTypes.SELECT,
          replacements: { tenantId, forgeKey, slug, excludeRepoId: excludeRepoId ?? null },
        },
      )
    ).filter((row) => slugify(row.namespace) === slugify(namespace));
    if (rows.length > 0) {
      throw new TwoAudienceError(
        `"${slug}" is already claimed. Choose another name, or ask an administrator which segment is free.`,
        `repo slug "${slug}" is already registered in namespace ${namespace} (forge ${forgeKey}, repo id ${rows[0].id})`,
      );
    }
  }
}

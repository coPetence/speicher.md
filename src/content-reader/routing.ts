/**
 * Resolve repository URLs by forge, namespace and slug; redirect old slugs
 * Prefer explicit forge and namespace segments over defaults
 */
import { Injectable } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';

import { TwoAudienceError } from '../common/errors';

import { isReservedSegment, slugify } from '../common/slug';
import { ConfigService } from '../config/config.service';
import { getSequelize } from '../db/sequelize';

/** URL segment conflict codes */
export type RoutingCode =
  | 'routing.segment-reserved'
  | 'routing.segment-is-forge'
  | 'routing.segment-is-repo'
  | 'routing.segment-is-owner'
  | 'routing.slug-registered';

/** Reserved or claimed segment; holder identifies the claimant */
export class SegmentClaimedError extends TwoAudienceError<RoutingCode> {
  constructor(
    code: RoutingCode,
    readonly holder: string | null,
    publicMessage: string,
    adminMessage: string,
  ) {
    super(code, publicMessage, adminMessage);
  }
}

export interface ResolvedRoute {
  repoId: string;
  namespace: string;
  repoSlug: string;
  forgeKey: string;

  slugPath: string;

  redirectTo?: string; // Redirect target for an old slug
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

    // Fall back to slug history and redirect
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

  /** Build route candidates, most specific first */
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

      // Try forge/slug with the default owner
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

  /** Match the namespace URL segment against the stored namespace's slug */
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

  /** Find the latest active rename for a namespace and old slug */
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

  /** Build the repo URL prefix, omitting the primary forge and default owner */
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

  /** Build the repo URL; an empty slugPath selects the root */
  publicPathFor(
    repo: { namespace: string; slug: string; forge_key: string },
    slugPath: string,
  ): string {
    const base = this.publicBaseFor(repo);
    return slugPath === '' ? `${base}/` : `${base}/${slugPath}`;
  }

  /**
   * Reject segment conflicts: default-owner repos claim their slug, others their owner
   * Check after the forge prefix; reserved names and forge IDs apply only to the primary forge
   * excludeRepoId skips the current repo in duplicate checks
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
      throw new SegmentClaimedError(
        'routing.segment-reserved',
        null,
        `"${segment}" is a reserved name. Choose another, or ask an administrator which segment is free.`,
        `${claimant} (forge ${forgeKey}) lands on the reserved first segment "${segment}"`,
      );
    }

    if (primary && this.config.forge(segment) && segment !== this.config.primaryForgeId) {
      throw new SegmentClaimedError(
        'routing.segment-is-forge',
        segment,
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
        throw new SegmentClaimedError(
          'routing.segment-is-repo',
          segment,
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
      throw new SegmentClaimedError(
        'routing.segment-is-owner',
        owner.namespace,
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
      throw new SegmentClaimedError(
        'routing.slug-registered',
        namespace,
        `"${slug}" is already claimed. Choose another name, or ask an administrator which segment is free.`,
        `repo slug "${slug}" is already registered in namespace ${namespace} (forge ${forgeKey}, repo id ${rows[0].id})`,
      );
    }
  }
}

import { CascadeLevel } from '../authz/explain';
import { PUBLIC_PRINCIPAL, Principal, intersectPrincipals } from '../common/principals';
import { ConfigService } from '../config/config.service';
import { SpeicherConfig, normalizeAccess } from '../config/types';
import { FindingList } from './findings';
import { GrantContext, ResolvedGrants, resolveAccessBlock } from './grants';

/**
 * # Merge semantics
 *
 * | Strategy    | Fields                      | Behaviour                                    |
 * | ----------- | --------------------------- | -------------------------------------------- |
 * | `override`  | `display.cover`             | Nearest ancestor wins                        |
 * | `append`    | `sync.exclude`              | Accumulates — add exclusions, never remove    |
 * | `replace`   | `sync.include`              | Child replaces wholesale                     |
 * | `intersect` | `access`                    | Each level intersects with its parent         |
 * | `and`       | `retrieval.indexable`       | `true -> false` allowed; `false -> true` ignored |
 *
 * Restrictions accumulate in every direction. That single property is what makes
 * delegating config to repos safe — and it is why `fold` has no branch that can
 * produce a superset of its input.
 *
 * `display.title` is deliberately *not* inherited. It names the level that
 * declares it: a folder's title, or the repo's. Cascading it would title every
 * page in `commercial/` "Commercial", where a page's title comes from its
 * frontmatter, then its H1, then the de-slugged filename.
 */
/**
 * An inherited cover carries the directory it was written in.
 *
 * `cover` is resolved relative to the directory containing the config that
 * declared it — and it inherits. Those two facts together mean the base directory
 * has to travel with the value: a repo-root `cover: cover.png` inherited into
 * `docs/commercial/` still means the file beside the root config, not
 * `docs/commercial/cover.png`.
 */
export interface InheritedCover {
  path: string;
  /** Repo-relative directory of the config that declared it. */
  baseDir: string;
}

export interface ResolvedConfig {
  /** The effective read set. Never larger than the parent's. */
  principals: Principal[];
  indexable: boolean;
  include: string[];
  exclude: string[];
  /** `undefined` = not set anywhere; `null` = explicitly "show none". */
  cover: InheritedCover | null | undefined;
  /** Declared at this exact level only. */
  ownTitle: string | undefined;
  chain: CascadeLevel[];
  droppedGrants: { principal: string; reason: string }[];
  /** Minimum `until` seen anywhere in the chain, for `next_grant_review_at`. */
  nextExpiry: Date | null;
}

export function instanceRoot(config: ConfigService): ResolvedConfig {
  return {
    // The repo root has no parent, so its `access` reads as the grant rather than
    // as an intersection. `NO_PARENT` is that absence, made explicit.
    principals: NO_PARENT,
    indexable: config.indexableDefault,
    include: [...config.syncDefaults.include],
    exclude: [...config.syncDefaults.exclude],
    cover: config.instance.defaults?.display?.cover
      ? { path: config.instance.defaults.display.cover, baseDir: '' }
      : undefined,
    ownTitle: undefined,
    chain: [
      {
        source: '<instance>',
        resolved_principals: [],
        indexable: config.indexableDefault,
        notes: ['instance defaults'],
      },
    ],
    droppedGrants: [],
    nextExpiry: null,
  };
}

/**
 * Sentinel for "there is no parent yet". Distinct from an empty array, which means
 * "the parent granted nothing" and must intersect to nothing.
 */
export const NO_PARENT: Principal[] = Object.freeze([]) as unknown as Principal[];

export interface FoldOptions {
  /** True for the repo root, where `access` is the grant rather than a narrowing. */
  isRoot: boolean;
  source: string;
  /** Repo-relative directory of `source`, which a `display.cover` here is relative to. */
  baseDir: string;
  lineOf?: (keyPath: string) => number | null;
  grantContext: Omit<GrantContext, 'source' | 'lineOf'>;
}

export async function fold(
  parent: ResolvedConfig,
  child: SpeicherConfig,
  options: FoldOptions,
  findings: FindingList,
): Promise<ResolvedConfig> {
  const ctx: GrantContext = {
    ...options.grantContext,
    source: options.source,
    lineOf: options.lineOf,
  };

  let principals = parent.principals;
  let grants: ResolvedGrants | null = null;
  /**
   * Set when the empty read set below has already been explained by name. The
   * generic warning states the consequence; the specific one states the cause, and
   * printing both makes the author read the vaguer of the two first.
   */
  let emptinessExplained = false;
  const access = normalizeAccess(child.access);
  const level: CascadeLevel = { source: options.source, resolved_principals: [] };

  if (access !== undefined) {
    grants = await resolveAccessBlock(access, ctx, findings);
    level.access = { groups: access.groups, users: access.users };
    if (options.isRoot) {
      principals = grants.principals;
    } else {
      const narrowed = intersectPrincipals(parent.principals, grants.principals);
      /*
        A public root with a private subtree is the first thing an author writes
        and the first thing that does not work.

          # repo root
          access: [public]
          # docs/internal/.speicher.yaml
          access: [engineering]   -> intersect(['group:public'], ['group:engineering']) = []

        `access` intersects, so `engineering` was never in the inherited set and the
        folder resolves to nobody. That is correct and it is the point of the
        intersect rule — but the generic `empty-read-set` warning below states the
        consequence without the cause, and `noop-narrowing` is the opposite case
        (it fires when nothing was removed; here everything was). So this one says
        which grant is missing and where it has to go: `access: { groups: [public,
        engineering] }` at the root, narrowed below.
      */
      if (
        narrowed.length === 0 &&
        grants.principals.length > 0 &&
        parent.principals.length === 1 &&
        parent.principals[0] === PUBLIC_PRINCIPAL
      ) {
        emptinessExplained = true;
        findings.warn({
          code: 'public-narrowed-away',
          source: options.source,
          line: options.lineOf?.('access') ?? undefined,
          message:
            'nobody can read this folder: the inherited set is `public` alone, and `access` ' +
            'here names ' +
            grants.principals.map((p) => `\`${p.replace(/^group:/, '')}\``).join(', ') +
            ', which the root never granted. Folder `access` intersects and can only ' +
            'narrow — grant them at the repo root too (`access: { groups: [public, …] }`) ' +
            'and narrow to them here.',
        });
      }
      // Naming a group the parent didn't grant simply yields a smaller set, never
      // a larger one — but a folder `access` that removes nothing is usually
      // someone expecting it to widen, so it is flagged.
      if (
        narrowed.length === parent.principals.length &&
        narrowed.every((p, i) => p === parent.principals[i])
      ) {
        findings.warn({
          code: 'noop-narrowing',
          source: options.source,
          line: options.lineOf?.('access') ?? undefined,
          message:
            '`access` here removes nothing. Folder access intersects with the inherited set ' +
            'and can only narrow — naming a group the parent did not grant does not add it.',
        });
      }
      principals = narrowed;
    }
  } else if (options.isRoot) {
    // "No config = not synced" only covers a missing file. An omitted grant in a
    // config that exists is almost always a mistake.
    findings.reject({
      code: 'access-missing',
      source: options.source,
      message:
        'the repo root config has no `access` block. Who may read this content? ' +
        'Remove the file entirely to unpublish the repo.',
    });
    principals = [];
  }

  // Empty resolved read set is valid but flagged — unless something above has
  // already said why, in which case this would be the same news, vaguer.
  if (principals.length === 0 && access !== undefined && !emptinessExplained) {
    findings.warn({
      code: 'empty-read-set',
      source: options.source,
      line: options.lineOf?.('access') ?? undefined,
      message: 'no readers specified (no one will be able to see this subtree)',
    });
  }

  // `and`: true -> false is honoured down the tree, false -> true is ignored.
  const indexable =
    child.retrieval?.indexable === undefined
      ? parent.indexable
      : parent.indexable && child.retrieval.indexable;

  level.resolved_principals = principals;
  level.indexable = indexable;

  const nextExpiry = minDate(parent.nextExpiry, grants?.nextExpiry ?? null);

  return {
    principals,
    indexable,
    // `replace`: child replaces wholesale, still bounded by ingest_root.
    include: child.sync?.include ? [...child.sync.include] : parent.include,
    // `append`: accumulates. You can add exclusions, never remove inherited ones.
    exclude: child.sync?.exclude ? [...parent.exclude, ...child.sync.exclude] : parent.exclude,
    // `override`: nearest ancestor wins. `cover: null` is a value (show none), not
    // an absence, so `in` rather than `!== undefined`.
    cover:
      child.display && 'cover' in child.display
        ? child.display.cover === null || child.display.cover === undefined
          ? null
          : { path: child.display.cover, baseDir: options.baseDir }
        : parent.cover,
    ownTitle: child.display?.title,
    chain: [...parent.chain, level],
    droppedGrants: [...parent.droppedGrants, ...(grants?.dropped ?? [])],
    nextExpiry,
  };
}

/**
 * A directory with no `.speicher.yaml` inherits its parent unchanged — but it is
 * still a level in the chain, and its own title defaults rather than inheriting.
 */
export function inheritInto(parent: ResolvedConfig): ResolvedConfig {
  return { ...parent, ownTitle: undefined };
}

function minDate(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

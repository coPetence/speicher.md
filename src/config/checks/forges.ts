import { isReservedSegment, slugify } from '../../common/slug';
import { ForgeConfig, InstanceConfig, gitRepositoryOwner } from '../types';

/**
 * resolvePrimaryForge returns the id of the primary forge. If only one forge is
 * configured, that forge is the primary forge. It returns null if no forge is
 * configured, or if the primary forge cannot be decided.
 *
 * @param forges the configured forges, by id
 * @param problems the list that problems are added to
 */
export function resolvePrimaryForge(
  forges: Record<string, ForgeConfig>,
  problems: string[],
): string | null {
  const ids = Object.keys(forges);
  if (ids.length === 0) return null;
  const marked = ids.filter((id) => forges[id].primary === true);
  if (marked.length > 1) {
    problems.push(
      `exactly one forge may be primary; ${marked.map((i) => `"${i}"`).join(', ')} are all marked as primary`,
    );
    return null;
  }
  if (marked.length === 1) return marked[0];
  if (ids.length === 1) return ids[0];
  problems.push(
    'no forge is marked `primary: true` and more than one is configured — designate one before adding a second forge, since promotion moves every URL',
  );
  return null;
}

/**
 * checkFirstSegments checks that no two of the following claim the same first URL
 * segment, and that none of them claims a reserved one: the ids of the non-primary
 * forges, and, when the primary forge is of type `git`, its repository owners and
 * the repositories of its default repository owner. A `github` forge lists no
 * repositories in the config, so its owners are checked when a repository is
 * registered instead (`RoutingService.assertFirstSegmentFree`).
 *
 * @param config the loaded instance config
 * @param primaryForgeId the id of the primary forge, or null if there is no forge
 * @param problems the list that problems are added to
 */
export function checkFirstSegments(
  config: InstanceConfig,
  primaryForgeId: string | null,
  problems: string[],
): void {
  const claimed = new Map<string, string>();

  const claim = (segment: string, claimant: string) => {
    if (isReservedSegment(segment)) {
      problems.push(`${claimant} claims first segment "${segment}", which is reserved`);
      return;
    }
    const existing = claimed.get(segment);
    if (existing === claimant) return;
    if (existing) {
      problems.push(`first segment "${segment}" is claimed by both ${existing} and ${claimant}`);
      return;
    }
    claimed.set(segment, claimant);
  };

  // The primary forge has no URL segment of its own
  for (const forgeId of Object.keys(config.forges ?? {})) {
    if (forgeId !== primaryForgeId) claim(forgeId, `forge "${forgeId}"`);
  }

  if (primaryForgeId === null) return;
  const primary = config.forges?.[primaryForgeId];
  if (primary?.type !== 'git') return;

  const defaultOwner =
    primary.default_repository_owner === undefined
      ? undefined
      : slugify(primary.default_repository_owner);
  for (const repo of primary.repos ?? []) {
    const owner = gitRepositoryOwner(repo);
    if (owner === null) continue;
    if (slugify(owner) === defaultOwner) {
      claim(slugify(repo.slug ?? repo.id), `repo "${repo.id}" on the primary forge`);
    } else {
      claim(slugify(owner), `repository owner "${owner}" on the primary forge`);
    }
  }
}

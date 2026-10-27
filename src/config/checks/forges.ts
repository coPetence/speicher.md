import { isReservedSegment, slugify } from '../../common/slug';
import { ForgeConfig, InstanceConfig, gitRepositoryOwner } from '../types';
import { ConfigProblem, problem } from '../../common/config-problems';

/** Return the explicit or sole primary forge ID; report ambiguity or a missing selection. */
export function resolvePrimaryForge(
  forges: Record<string, ForgeConfig>,
  problems: ConfigProblem[],
): string | null {
  const ids = Object.keys(forges);
  if (ids.length === 0) return null;
  const marked = ids.filter((id) => forges[id].primary === true);
  if (marked.length > 1) {
    problems.push(
      problem('forges.primary-ambiguous', 'forges', {
        text: `Multiple primary forges: ${marked.map((i) => `"${i}"`).join(', ')}. Set \`primary: true\` on only one.`,
        dashboard: `Multiple primary content sources: ${marked.map((i) => `"${i}"`).join(', ')}. Choose only one.`,
      }),
    );
    return null;
  }
  if (marked.length === 1) return marked[0];
  if (ids.length === 1) return ids[0];
  problems.push(
    problem('forges.primary-missing', 'forges', {
      text: 'Multiple forges configured, but none is primary. Set `primary: true` on one. Changing the primary forge later changes every URL.',
      dashboard:
        'No primary content source selected. Choose one. Changing it later changes every URL.',
    }),
  );
  return null;
}

/**
 * Check reserved root segments and URL conflicts between forges, owners, and repos.
 * GitHub owners are checked at registration by RoutingService.assertFirstSegmentFree.
 */
export function checkFirstSegments(
  config: InstanceConfig,
  primaryForgeId: string | null,
  problems: ConfigProblem[],
): void {
  const claimed = new Map<string, string>();

  // Report conflicts at the claimant's config path.
  const claim = (segment: string, claimant: string, path: string) => {
    if (isReservedSegment(segment)) {
      problems.push(
        problem('forges.segment-reserved', path, {
          text: `Reserved URL path /${segment}: ${claimant} cannot use it. Rename it.`,
          dashboard: `/${segment} is reserved. Rename ${asShown(claimant, false)} to use a different URL.`,
        }),
      );
      return;
    }
    const existing = claimed.get(segment);
    if (existing === claimant) return;
    if (existing) {
      problems.push(
        problem('forges.segment-taken', path, {
          text: `URL conflict at /${segment}: ${existing} and ${claimant}. Rename one.`,
          dashboard: `${asShown(claimant)} and ${asShown(existing, false)} share /${segment}. Rename one.`,
        }),
      );
      return;
    }
    claimed.set(segment, claimant);
  };

  // Only non-primary forges claim their own URL segment.
  for (const forgeId of Object.keys(config.forges ?? {})) {
    if (forgeId !== primaryForgeId) claim(forgeId, `forge "${forgeId}"`, `forges.${forgeId}`);
  }

  for (const [forgeId, forge] of Object.entries(config.forges ?? {})) {
    if (forgeId === primaryForgeId || forge.type !== 'git') continue;
    if (forge.default_repository_owner === undefined) continue;
    const forgeOwner = slugify(forge.default_repository_owner);
    const taken = new Map<string, string>();
    for (const [i, repo] of (forge.repos ?? []).entries()) {
      const owner = gitRepositoryOwner(repo);
      if (owner === null) continue;
      const [segment, claimant] =
        slugify(owner) === forgeOwner
          ? [slugify(repo.slug ?? repo.id), `repo "${repo.id}"`]
          : [slugify(owner), `repository owner "${owner}"`];
      const existing = taken.get(segment);
      if (existing && existing !== claimant) {
        problems.push(
          problem('forges.segment-taken', `forges.${forgeId}.repos[${i}]`, {
            text: `URL conflict at /${forgeId}/${segment}: ${existing} and ${claimant}. Rename one.`,
            dashboard: `${asShown(claimant)} and ${asShown(existing, false)} share /${forgeId}/${segment}. Rename one.`,
          }),
        );
      } else {
        taken.set(segment, claimant);
      }
    }
  }

  if (primaryForgeId === null) return;
  const primary = config.forges?.[primaryForgeId];
  if (primary?.type !== 'git') return;

  const defaultOwner =
    primary.default_repository_owner === undefined
      ? undefined
      : slugify(primary.default_repository_owner);
  for (const [i, repo] of (primary.repos ?? []).entries()) {
    const owner = gitRepositoryOwner(repo);
    if (owner === null) continue;
    const path = `forges.${primaryForgeId}.repos[${i}]`;
    if (slugify(owner) === defaultOwner) {
      claim(slugify(repo.slug ?? repo.id), `repo "${repo.id}" on the primary forge`, path);
    } else {
      claim(slugify(owner), `repository owner "${owner}" on the primary forge`, path);
    }
  }
}

/** Format a claimant using dashboard terminology. */
function asShown(claimant: string, leading = true): string {
  const shown = claimant
    .replace(/^forge /, 'content source ')
    .replace(/^repo /, 'repository ')
    .replace(/ on the primary forge$/, '');
  return leading ? shown.charAt(0).toUpperCase() + shown.slice(1) : shown;
}

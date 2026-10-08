import { PUBLIC_GROUP_NAME } from '../../common/principals';
import { isKnownTimeZone } from '../../dashboard/analytics/buckets';
import { BRAND_IMAGES, parseBrandImage } from '../brand';
import { InstanceConfig } from '../types';

export function checkBrandLogo(config: InstanceConfig, problems: string[]): void {
  for (const spec of BRAND_IMAGES) {
    const stored = config.brand?.[spec.field];
    if (stored === undefined) continue;
    const { problem } = parseBrandImage(stored, spec);
    if (problem) problems.push(problem);
  }
}

/**
 * checkAnalytics checks that `analytics.timezone` is a time zone this runtime knows.
 *
 * @param config the loaded instance config
 * @param problems the list that problems are added to
 */
export function checkAnalytics(config: InstanceConfig, problems: string[]): void {
  const timezone = config.analytics?.timezone;
  if (timezone !== undefined && !isKnownTimeZone(timezone)) {
    problems.push(
      `analytics.timezone "${timezone}" is not an IANA time zone this runtime knows — use a name like \`Europe/Berlin\` or \`UTC\``,
    );
  }
}

/**
 * checkReservedPublicName refuses a group named `public` and the name `public` in
 * `admins.groups`.
 *
 * @param config the loaded instance config
 * @param problems the list that problems are added to
 */
export function checkReservedPublicName(config: InstanceConfig, problems: string[]): void {
  const publicGroup = Object.keys(config.groups ?? {}).find(
    (name) => name.toLowerCase() === PUBLIC_GROUP_NAME,
  );
  if (publicGroup !== undefined) {
    problems.push(
      `groups.${publicGroup}: The group name "${publicGroup}" is reserved. Every visitor belongs to the "${PUBLIC_GROUP_NAME}" group, including visitors who are not signed in, so a repository that grants access to it can be read by anyone. Try renaming the group.`,
    );
  }
  const publicAdmin = (config.admins?.groups ?? []).find(
    (name) => name.toLowerCase() === PUBLIC_GROUP_NAME,
  );
  if (publicAdmin !== undefined) {
    problems.push(
      `admins.groups: "${publicAdmin}" is reserved and cannot be an administrator group. Every visitor belongs to the "${PUBLIC_GROUP_NAME}" group, including visitors who are not signed in, so anyone could administer this instance. Remove "${publicAdmin}" from admins.groups.`,
    );
  }
}

/**
 * checkCaseCollisions refuses two providers, groups or forges whose keys differ
 * only in case.
 *
 * @param config the loaded instance config
 * @param problems the list that problems are added to
 */
export function checkCaseCollisions(config: InstanceConfig, problems: string[]): void {
  const collections: [string, Record<string, unknown> | undefined][] = [
    ['auth.providers', config.auth?.providers],
    ['groups', config.groups],
    ['forges', config.forges],
  ];
  for (const [path, members] of collections) {
    const seenEntries = new Map<string, string>();
    for (const key of Object.keys(members ?? {})) {
      const existingEntry = seenEntries.get(key.toLowerCase());
      if (existingEntry !== undefined) {
        problems.push(`${path}: "${existingEntry}" and "${key}" differ only in case`);
      }
      seenEntries.set(key.toLowerCase(), key);
    }
  }
}

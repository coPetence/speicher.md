import { PUBLIC_GROUP_NAME } from '../../common/principals';
import { isKnownTimeZone } from '../../dashboard/analytics/buckets';
import { BRAND_IMAGES, brandValueKind, parseBrandImage } from '../brand';
import { InstanceConfig } from '../types';
import { ConfigProblem, problem } from '../../common/config-problems';

export function checkBrandLogo(config: InstanceConfig, problems: ConfigProblem[]): void {
  for (const spec of BRAND_IMAGES) {
    const stored = config.brand?.[spec.field];
    if (stored === undefined) continue;

    switch (brandValueKind(stored)) {
      case 'ref':
        continue;
      case 'data': {
        const invalid = parseBrandImage(stored, spec).problem;
        if (invalid) problems.push(brandImageProblem(spec.key, invalid));
        continue;
      }
      default:
        problems.push(
          problem('brand.image-invalid', spec.key, {
            text: 'Invalid image value. Use a base64 `data:` URI or a `sha256:` reference to an image stored on this instance.',
            dashboard: 'Invalid image. Upload it again.',
          }),
        );
    }
  }
}

/**
 * A brand image refused by `parseBrandImage`. Its text leads with the key, which
 * the path already gives, so the text starts after it
 */
export function brandImageProblem(key: string, invalid: string) {
  const rest = invalid.replace(/^`[^`]+`:? /, '');
  return problem('brand.image-invalid', key, {
    text: rest,
    dashboard: /^the /.test(rest)
      ? `${rest.charAt(0).toUpperCase()}${rest.slice(1)}.`
      : `This image ${rest}.`,
  });
}

/** Reports unsupported analytics time zones. */
export function checkAnalytics(config: InstanceConfig, problems: ConfigProblem[]): void {
  const timezone = config.analytics?.timezone;
  if (timezone !== undefined && !isKnownTimeZone(timezone)) {
    problems.push(
      problem('analytics.timezone-unknown', 'analytics.timezone', {
        text: `Unknown time zone "${timezone}". Use a supported IANA name, such as \`Europe/Berlin\` or \`UTC\`.`,
        dashboard: `Unknown time zone "${timezone}". Use a name such as Europe/Berlin or UTC.`,
      }),
    );
  }
}

/** Reports the reserved name "public" in groups or admins.groups, ignoring case. */
export function checkReservedPublicName(config: InstanceConfig, problems: ConfigProblem[]): void {
  const publicGroup = Object.keys(config.groups ?? {}).find(
    (name) => name.toLowerCase() === PUBLIC_GROUP_NAME,
  );
  if (publicGroup !== undefined) {
    problems.push(
      problem('names.reserved', `groups.${publicGroup}`, {
        text: `Rename "${publicGroup}". The name "${PUBLIC_GROUP_NAME}" is reserved for all visitors, including those not signed in.`,
        dashboard: `Rename "${publicGroup}". The name "${PUBLIC_GROUP_NAME}" is reserved for all visitors, including those not signed in.`,
      }),
    );
  }
  const publicAdmin = (config.admins?.groups ?? []).find(
    (name) => name.toLowerCase() === PUBLIC_GROUP_NAME,
  );
  if (publicAdmin !== undefined) {
    problems.push(
      problem('names.reserved', 'admins.groups', {
        text: `Remove "${publicAdmin}" from admins.groups. It includes all visitors, even those not signed in, and cannot be an administrator group.`,
        dashboard: `Remove Administrator access from "${publicAdmin}". It includes all visitors, even those not signed in.`,
      }),
    );
  }
}

/** Reports provider, group, or forge keys that differ only by case. */
export function checkCaseCollisions(config: InstanceConfig, problems: ConfigProblem[]): void {
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
        problems.push(
          problem('names.case-collision', `${path}.${key}`, {
            text: `"${existingEntry}" and "${key}" differ only by capitalization. Rename one.`,
            dashboard: `"${existingEntry}" and "${key}" differ only by capitalization. Rename one.`,
          }),
        );
      }
      seenEntries.set(key.toLowerCase(), key);
    }
  }
}

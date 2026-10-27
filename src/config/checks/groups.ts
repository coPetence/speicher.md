import { githubGroupIdProblem } from '../../auth/directory/github-config';
import { nearestName } from '../../common/edit-distance';
import { parseUntil } from '../../common/until';
import { referenceCycle } from '../groups';
import {
  GroupReference,
  GroupSource,
  InstanceConfig,
  ProviderConfig,
  isGroupReference,
  providerType,
} from '../types';
import { ConfigProblem, problem } from '../../common/config-problems';

/** Matches Microsoft multi-tenant issuer URLs. */
const MULTI_TENANT_ISSUER = /\/(common|organizations|consumers)\/v2\.0\/?$/;

/** Validates group sources, references, and reference cycles. */
export function checkGroups(config: InstanceConfig, problems: ConfigProblem[]): void {
  const providers = config.auth?.providers ?? {};
  for (const [name, items] of Object.entries(config.groups ?? {})) {
    for (const [i, item] of items.entries()) {
      const at = `groups.${name}[${i}]`;
      if (isGroupReference(item)) {
        checkReference(name, at, item, config, problems);
        continue;
      }
      const source = item;
      const provider = providers[source.provider];
      if (!provider) {
        problems.push(
          problem('groups.unknown-provider', `${at}.provider`, {
            text: `Unknown provider "${source.provider}". Use a configured provider.`,
            dashboard: `Group "${name}" uses unknown provider "${source.provider}". Use a configured provider.`,
          }),
        );
        continue;
      }
      const type = providerType(provider);
      if (source.domain !== undefined && type !== 'magic-link') {
        problems.push(
          problem('groups.domain-needs-magic-link', `${at}.domain`, {
            text: `\`domain\` requires a magic-link provider. "${source.provider}" uses ${type}. Use \`id\`, \`subject\`, or \`email\` instead.`,
            dashboard: `Provider "${source.provider}" does not support email domains. Use a provider group ID, subject, or email address instead.`,
          }),
        );
      }
      if (source.id !== undefined && type === 'github') {
        const invalid = githubGroupIdProblem(source.id);
        if (invalid) {
          problems.push(
            problem('groups.github-team-invalid', `${at}.id`, {
              text: invalid,
              dashboard: invalid,
            }),
          );
        }
      }
      if (source.id !== undefined && type === 'magic-link') {
        problems.push(
          problem('groups.id-with-magic-link', `${at}.id`, {
            text: `Magic-link provider "${source.provider}" does not support group IDs. Use \`domain\` or \`email\` instead.`,
            dashboard: `Magic-link provider "${source.provider}" does not support group IDs. Use an email domain or email address instead.`,
          }),
        );
      }
      if (source.until !== undefined && parseUntil(source.until) === null) {
        problems.push(untilProblem(`${at}.until`, source.until));
      }
      checkPinnedForAddress(at, source, provider, problems);
    }
  }

  const cycle = referenceCycle(config.groups);
  if (cycle) {
    problems.push(
      problem('groups.reference-cycle', `groups.${cycle[0]}`, {
        text: `Group reference cycle: ${cycle.join(' -> ')}. Remove a reference to break the cycle.`,
        dashboard: `Group reference cycle: ${cycle.join(' -> ')}. Remove a reference to break the cycle.`,
      }),
    );
  }
}

/** Reports an invalid membership end date. */
function untilProblem(path: string, until: unknown) {
  return problem('groups.until-invalid', path, {
    text: `Invalid \`until\` date: ${JSON.stringify(until)}. Use the last day of membership in YYYY-MM-DD format, e.g. 2026-12-31.`,
    dashboard: `Invalid membership end date: ${JSON.stringify(until)}. Use YYYY-MM-DD, e.g. 2026-12-31.`,
  });
}

/** Checks for self-references, unknown groups, and invalid end dates. */
function checkReference(
  name: string,
  at: string,
  reference: GroupReference,
  config: InstanceConfig,
  problems: ConfigProblem[],
): void {
  const groups = config.groups ?? {};
  if (reference.group === name) {
    problems.push(
      problem('groups.self-reference', `${at}.group`, {
        text: `Group "${name}" references itself. Remove this reference.`,
        dashboard: `Group "${name}" references itself. Remove this reference.`,
      }),
    );
  } else if (!Object.prototype.hasOwnProperty.call(groups, reference.group)) {
    const near = nearestName(reference.group, Object.keys(groups), { ignoreCase: true });
    problems.push(
      problem('groups.unknown-reference', `${at}.group`, {
        text: `Unknown group "${reference.group}".${near ? ` Did you mean "${near}"?` : ' Use a defined group.'}`,
        dashboard: `Unknown group "${reference.group}".${near ? ` Did you mean "${near}"?` : ' Use a defined group.'}`,
      }),
    );
  }
  if (reference.until !== undefined && parseUntil(reference.until) === null) {
    problems.push(untilProblem(`${at}.until`, reference.until));
  }
}

/**
 * Rejects email/domain matching for Microsoft multi-tenant providers:
 * other directories can assign arbitrary email addresses.
 */
function checkPinnedForAddress(
  at: string,
  source: GroupSource,
  provider: ProviderConfig,
  problems: ConfigProblem[],
): void {
  if (source.email === undefined && source.domain === undefined) return;
  if (providerType(provider) !== 'oidc') return;
  const issuer = (provider as { issuer?: string }).issuer ?? '';
  if (!MULTI_TENANT_ISSUER.test(issuer)) return;
  problems.push(
    problem(
      'groups.address-on-multi-tenant',
      `${at}.${source.email !== undefined ? 'email' : 'domain'}`,
      {
        text: `\`email\` and \`domain\` are unsafe with multi-tenant provider "${source.provider}": other Microsoft directories can assign any email address. Use \`subject\` or restrict the provider's issuer to your directory.`,
        dashboard: `Email matching is unsafe with multi-tenant provider "${source.provider}": other Microsoft directories can assign any email address. Use a directory subject or restrict the provider to your directory.`,
      },
    ),
  );
}

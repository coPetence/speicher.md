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

/** Matches the issuers of Microsoft's multi-tenant authorities */
const MULTI_TENANT_ISSUER = /\/(common|organizations|consumers)\/v2\.0\/?$/;

/**
 * checks every item of every group. makes sure every source leads to a provider
 *
 * @param config the loaded instance config
 * @param problems the list that problems are added to
 */
export function checkGroups(config: InstanceConfig, problems: string[]): void {
  const providers = config.auth?.providers ?? {};
  for (const [name, items] of Object.entries(config.groups ?? {})) {
    for (const item of items) {
      if (isGroupReference(item)) {
        checkReference(name, item, config, problems);
        continue;
      }
      const source = item;
      const provider = providers[source.provider];
      if (!provider) {
        problems.push(`groups.${name}: provider "${source.provider}" is not a configured provider`);
        continue;
      }
      const type = providerType(provider);
      if (source.domain !== undefined && type !== 'magic-link') {
        problems.push(
          `groups.${name}: \`domain\` only works with a magic-link provider, and "${source.provider}" is a provider of type ${type}. To add members from "${source.provider}", use \`id\` with the id of a group from that provider, or name a person with \`subject\` or \`email\`.`,
        );
      }
      if (source.id !== undefined && type === 'github') {
        const problem = githubGroupIdProblem(source.id);
        if (problem) problems.push(`groups.${name}: ${problem}`);
      }
      if (source.id !== undefined && type === 'magic-link') {
        problems.push(
          `groups.${name}: \`id\` does not work with "${source.provider}", because a magic-link provider signs people in by email instead of by group. To add members from "${source.provider}", use \`domain\` with an email domain such as example.com, or name a person with \`email\`.`,
        );
      }
      if (source.until !== undefined && parseUntil(source.until) === null) {
        problems.push(
          `groups.${name}: The \`until\` value ${JSON.stringify(source.until)} is not a valid date. Write the last day of the membership as YYYY-MM-DD, for example 2026-12-31.`,
        );
      }
      checkPinnedForAddress(name, source, provider, problems);
    }
  }

  const cycle = referenceCycle(config.groups);
  if (cycle) {
    problems.push(
      `groups.${cycle[0]}: The group references include a cycle (${cycle.join(' -> ')}). Remove one of the references.`,
    );
  }
}

/**
 * checkReference checks one `group` item: the group it names has to be defined,
 * and it must not be the group it sits in, and `until` must be a date.
 *
 * @param name the group's name
 * @param reference the item
 * @param config the loaded instance config
 * @param problems the list that problems are added to
 */
function checkReference(
  name: string,
  reference: GroupReference,
  config: InstanceConfig,
  problems: string[],
): void {
  const groups = config.groups ?? {};
  if (reference.group === name) {
    problems.push(`groups.${name}: This group references itself. Remove the reference.`);
  } else if (!Object.prototype.hasOwnProperty.call(groups, reference.group)) {
    const near = nearestName(reference.group, Object.keys(groups), { ignoreCase: true });
    problems.push(
      `groups.${name}: references the group "${reference.group}", which is not defined.${near ? ` Did you mean "${near}"?` : ''}`,
    );
  }
  if (reference.until !== undefined && parseUntil(reference.until) === null) {
    problems.push(
      `groups.${name}: The \`until\` value ${JSON.stringify(reference.until)} is not a valid date. Use this format: YYYY-MM-DD, for example 2026-12-31.`,
    );
  }
}

/**
 * checkPinnedForAddress refuses a source that matches on `email` or `domain` when its
 * provider accepts accounts from every Microsoft directory. The administrator of any
 * directory can give an account any email address, so an address proves nothing there.
 *
 * @param name the group's name
 * @param source the source to check
 * @param provider the provider the source names
 * @param problems the list that problems are added to
 */
function checkPinnedForAddress(
  name: string,
  source: GroupSource,
  provider: ProviderConfig,
  problems: string[],
): void {
  if (source.email === undefined && source.domain === undefined) return;
  if (providerType(provider) !== 'oidc') return;
  const issuer = (provider as { issuer?: string }).issuer ?? '';
  if (!MULTI_TENANT_ISSUER.test(issuer)) return;
  problems.push(
    `groups.${name}: \`email\` and \`domain\` cannot be used with "${source.provider}", because its issuer accepts accounts from every Microsoft directory, and the administrator of any directory can give an account any email address. Name the person with \`subject\` instead, or use a provider whose issuer names your own directory.`,
  );
}

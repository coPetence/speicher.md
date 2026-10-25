import { hasAnySource } from '../groups';
import { InstanceConfig } from '../types';

/**
 * checkAdmins checks that every group in `admins.groups` is defined and that every
 * user in `admins.users` names a configured provider, either directly or through
 * the default provider.
 *
 * @param config the loaded instance config
 * @param problems the list that problems are added to
 */
export function checkAdmins(config: InstanceConfig, problems: string[]): void {
  const knownGroups = new Set(Object.keys(config.groups ?? {}));
  for (const group of config.admins?.groups ?? []) {
    if (!knownGroups.has(group)) {
      problems.push(`admins.groups: "${group}" is not defined in the \`groups\` map`);
    }
  }
  const providers = Object.keys(config.auth?.providers ?? {});
  for (const [i, user] of (config.admins?.users ?? []).entries()) {
    const provider = user.provider ?? config.auth?.default_provider;
    if (provider === undefined) {
      if (providers.length === 0) {
        problems.push(
          `admins.users[${i}]: This administrator has no \`provider\`, and this instance has no sign-in provider configured, so nobody can sign in as this administrator. Add a provider under auth.providers.`,
        );
      } else if (providers.length > 1) {
        problems.push(
          `admins.users[${i}]: This administrator has no \`provider\`, and this instance has more than one sign-in provider, so it is unclear which one the administrator signs in with. Set \`provider\` on this administrator, or set auth.default_provider.`,
        );
      }
    } else if (!(config.auth?.providers ?? {})[provider]) {
      problems.push(`admins.users[${i}]: provider "${provider}" is not configured`);
    }
  }
}

/**
 * adminLockout returns a message if the config leaves nobody who can administer the
 * instance, and null otherwise. A save is refused on this, but a boot is not.
 *
 * @param config the config that is about to be saved
 */
export function adminLockout(config: InstanceConfig): string | null {
  const knownGroups = new Set(Object.keys(config.groups ?? {}));
  const knownAdminGroups = (config.admins?.groups ?? []).filter((group) => knownGroups.has(group));
  const activeAdminGroups = knownAdminGroups.filter((group) => hasAnySource(config.groups, group));
  if (activeAdminGroups.length > 0 || (config.admins?.users ?? []).length > 0) return null;

  if (knownAdminGroups.length === 0) {
    return 'No administrator is configured. Add a person under admins.users or a group under admins.groups.';
  }

  const groups = knownAdminGroups.map((g) => `"${g}"`).join(', ');
  if (knownAdminGroups.length === 1) {
    return `The administrator group ${groups} has no members, because it is not mapped to a provider group or a person. Add a provider group or a person to ${groups}, or add a person under admins.users.`;
  }

  return `The administrator groups ${groups} have no members, because they are not mapped to a provider group or a person. Add a provider group or a person to one of them, or add a person under admins.users.`;
}

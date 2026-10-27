import { ConfigProblem, problem } from '../../common/config-problems';
import { hasAnySource } from '../groups';
import { InstanceConfig } from '../types';

/** Report undefined admin groups and missing, ambiguous, or unknown user providers. */
export function checkAdmins(config: InstanceConfig, problems: ConfigProblem[]): void {
  const knownGroups = new Set(Object.keys(config.groups ?? {}));
  for (const group of config.admins?.groups ?? []) {
    if (!knownGroups.has(group)) {
      problems.push(
        problem('admins.unknown-group', 'admins.groups', {
          text: `Unknown administrator group "${group}". Define it in \`groups\`.`,
          dashboard: `Administrator group "${group}" is missing. Add it in [Groups](/-/config/groups).`,
        }),
      );
    }
  }
  const providers = Object.keys(config.auth?.providers ?? {});
  for (const [i, user] of (config.admins?.users ?? []).entries()) {
    // The provider is the key at fault, so the dashboard marks that input
    const path = `admins.users[${i}].provider`;
    const who = user.email ?? user.subject ?? `number ${i + 1}`;
    const provider = user.provider ?? config.auth?.default_provider;
    if (provider === undefined) {
      if (providers.length === 0) {
        problems.push(
          problem('admins.user-no-provider', path, {
            text: 'No sign-in providers configured. Add one in `auth.providers`.',
            dashboard: `${who} cannot sign in: no providers configured. Add one in [Identity Providers](/-/config/identity).`,
          }),
        );
      } else if (providers.length > 1) {
        problems.push(
          problem('admins.user-ambiguous-provider', path, {
            text: 'Sign-in provider is ambiguous. Set `provider` or `auth.default_provider`.',
            dashboard: `${who} needs a sign-in provider. Select one in [Administrators](/-/config/admins).`,
          }),
        );
      }
    } else if (!(config.auth?.providers ?? {})[provider]) {
      problems.push(
        problem('admins.unknown-provider', path, {
          text: `Unknown sign-in provider "${provider}". Set \`provider\` to a configured provider.`,
          dashboard: `${who} uses unknown provider "${provider}". Select another in [Administrators](/-/config/admins) or add it in [Identity Providers](/-/config/identity).`,
        }),
      );
    }
  }
}

/** Return a lockout problem or null. Lockouts block saves, not startup. */
export function adminLockout(config: InstanceConfig): ConfigProblem | null {
  const knownGroups = new Set(Object.keys(config.groups ?? {}));
  const knownAdminGroups = (config.admins?.groups ?? []).filter((group) => knownGroups.has(group));
  const activeAdminGroups = knownAdminGroups.filter((group) => hasAnySource(config.groups, group));
  if (activeAdminGroups.length > 0 || (config.admins?.users ?? []).length > 0) return null;

  if (knownAdminGroups.length === 0) {
    return problem('admins.none', null, {
      text: 'No administrators configured. Add a user to `admins.users` or a defined group to `admins.groups`.',
      dashboard:
        'No administrators configured. Add a user in [Administrators](/-/config/admins) or grant a group admin access in [Groups](/-/config/groups).',
    });
  }

  const groups = knownAdminGroups.map((g) => `"${g}"`).join(', ');
  if (knownAdminGroups.length === 1) {
    return problem('admins.group-empty', 'admins.groups', {
      text: `Administrator group ${groups} is empty. Add a member or a user to \`admins.users\`.`,
      dashboard: `Administrator group ${groups} is empty. Add a member in [Groups](/-/config/groups) or a user in [Administrators](/-/config/admins).`,
    });
  }

  return problem('admins.group-empty', 'admins.groups', {
    text: `Administrator groups ${groups} are empty. Add a group member or a user to \`admins.users\`.`,
    dashboard: `Administrator groups ${groups} are empty. Add a member in [Groups](/-/config/groups) or a user in [Administrators](/-/config/admins).`,
  });
}

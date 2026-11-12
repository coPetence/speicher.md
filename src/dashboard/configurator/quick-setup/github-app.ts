/**
 * Quick setup of a GitHub identity provider or content source: its App is
 * created on GitHub from a manifest, on a personal account or an organization.
 * A provider's App is public or private by who should be able to sign in
 */

import { rootLogger } from '../../../common/logger';
import {
  GithubAppOwner,
  githubAppLinks,
  installationUrl,
  lookupGithubApp,
} from '../../../github/app-links';
import { InstallationAccess, installationAccess } from '../../../github/app-installation';
import { githubHosts } from '../../../github/hosts';
import { SOURCE_ACCOUNT } from '../config-form/config-fields/github-app-manifest';
import {
  ManifestTarget,
  contentSourceTarget,
  identityProviderTarget,
  providerInstallPath,
  sourceCheckPath,
} from '../config-page/github-app-manifest';
import { SIGN_IN_AUDIENCES, signInAudienceText } from '../github-sign-in-audience';
import type { QuickStarter, ReadyContext, ReadyStep } from './model';

const log = rootLogger.child('config.quick-setup');

// A GitHub account name: letters, digits and single hyphens between them, up to 39 characters
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const ORG_FIELD = 'org';

// One answer of the setup's choice: where the App is created, and whether it is public
interface AppPlacement {
  value: string;
  label: string;
  organization: boolean;
  public: boolean;
}

interface GithubAppSetup {
  section: 'identity' | 'sources';
  // The setup's choice and its answers
  choice: {
    name: string;
    label: string;
    layout: 'switch' | 'list' | 'dropdown';
    placements: AppPlacement[];
  };
  target: (id: string, placement: AppPlacement) => ManifestTarget;
  // What the App is installed on so the member works, e.g. `the repositories speicher.md should read`
  installOn: (owner: string) => string;
}

/**
 * githubAppStarter returns the quick setup of the GitHub App of a new member of a section.
 *
 * @param setup what the setup asks, and how its answer becomes an App
 */
function githubAppStarter(setup: GithubAppSetup): QuickStarter {
  const { section, choice } = setup;
  const withOrganization = choice.placements
    .filter((placement) => placement.organization)
    .map((placement) => placement.value);

  return {
    setup: {
      submitLabel: 'Continue on GitHub',
      leavesSite: true,
      fields: [
        {
          kind: 'choice',
          name: choice.name,
          label: choice.label,
          layout: choice.layout,
          options: choice.placements.map(({ value, label }) => ({ value, label })),
        },
        {
          kind: 'text',
          name: ORG_FIELD,
          label: 'Organization',
          help: 'The GitHub organization that owns the App. You need to be an owner of it, or an App manager.',
          placeholder: 'acme',
          required: true,
          shownWhen: { field: choice.name, values: withOrganization },
        },
      ],
    },

    start(id, input) {
      const placement =
        choice.placements.find((each) => each.value === input[choice.name]) ?? choice.placements[0];
      const owner = placement.organization ? (input[ORG_FIELD] ?? '').trim() : '';
      if (placement.organization && owner === '') {
        return {
          kind: 'refused',
          message: 'Name the organization the App is created on.',
          field: ORG_FIELD,
        };
      }
      if (placement.organization && !GITHUB_LOGIN.test(owner)) {
        return {
          kind: 'refused',
          message: `"${owner}" is not a GitHub organization name. It has letters, digits and single hyphens between them.`,
          field: ORG_FIELD,
        };
      }
      return {
        kind: 'github-app',
        target: setup.target(id, placement),
        owner,
        public: placement.public,
      };
    },

    async ready(context) {
      const app = await appOf(context);
      const installed = ['install', 'update'].includes(context.query.setup_action ?? '');
      const stored = isRecord(context.member.app) ? context.member.app : {};
      // A provider's App on a personal account has no teams to read, so it needs no installing
      const installs = section === 'sources' || app?.owner.isOrganization === true;
      const { web } = githubHosts(baseUrlOf(context.member));
      const links = app ? githubAppLinks(web, app.slug, app.owner) : null;
      const steps: ReadyStep[] = [];

      steps.push(
        app && links
          ? {
              state: 'done',
              text: `GitHub App **${app.slug}** created on **${app.owner.accountName}**`,
              href: links.settingsUrl,
              label: 'Open on GitHub',
            }
          : { state: 'done', text: 'GitHub App created' },
      );
      const audience = section === 'identity' ? signInAudienceText(stored, bold) : null;
      if (audience) steps.push({ state: 'done', text: audience });

      // A source's App says what it reads: null when GitHub has no installation of it, undefined when it cannot tell
      const access = section === 'sources' && app ? await accessOf(context, app) : undefined;
      if (access && app) {
        steps.push({
          state: 'done',
          text: `App installed on **${app.owner.accountName}**, with access to {link}`,
          inline: {
            text: repositoriesText(access),
            href: installationUrl(web, app.owner, access.installationId),
          },
        });
      } else if (access === undefined && installs && installed) {
        // GitHub names the installation it sent the browser back from
        const installation = /^\d+$/.test(context.query.installation_id ?? '')
          ? context.query.installation_id
          : null;
        steps.push({
          state: 'done',
          text: `App installed on ${app ? `**${app.owner.accountName}**` : 'GitHub'}`,
          ...(app && installation
            ? {
                href: installationUrl(web, app.owner, installation),
                label: 'View installation',
              }
            : {}),
        });
      } else if (installs && app && links) {
        steps.push({
          state: 'next',
          text: `Install the App on ${setup.installOn(`**${app.owner.accountName}**`)}`,
          // A provider's installation starts here, so its return can sign the person in
          ...(section === 'identity'
            ? {
                href: providerInstallPath(context.id),
                external: true,
              }
            : { href: links.installUrl }),
          label: 'Install on GitHub',
        });
      }
      // An installed source goes on to check the repositories it reads
      const onward =
        section === 'sources' && access
          ? { label: 'Check repositories', href: sourceCheckPath(context.id) }
          : undefined;
      return { steps, onward };
    },
  };
}

/**
 * accessOf returns what the installation of a source's App can read. It returns null when the App is not installed on
 * its account, and undefined when GitHub cannot be asked.
 *
 * @param context the ready page's member
 * @param app the source's App
 */
async function accessOf(
  context: ReadyContext,
  app: { owner: GithubAppOwner },
): Promise<InstallationAccess | null | undefined> {
  const member = context.member;
  if (typeof member.app_id !== 'string' || typeof member.private_key !== 'string') return undefined;
  try {
    return await installationAccess(
      githubHosts(baseUrlOf(member)).api,
      member.app_id,
      member.private_key,
      app.owner.accountName,
      context.fetchImpl,
    );
  } catch (err) {
    log.warn('could not read the installation of a ready page', {
      section: context.section,
      id: context.id,
      error: (err as Error).message,
    });
    return undefined;
  }
}

/** How many repositories an installation reads, e.g. `3 selected repositories` */
function repositoriesText(access: InstallationAccess): string {
  const n = access.repositories;
  const noun = n === 1 ? 'repository' : 'repositories';
  if (access.selection === 'all-repositories')
    return n === 1 ? 'its one repository' : `all ${n} ${noun}`;
  return n === 0 ? 'no repositories yet' : `${n} selected ${noun}`;
}

function bold(account: string): string {
  return `**${account}**`;
}

/** The App of the member: as a provider stores it, or as GitHub tells it for a source */
async function appOf(
  context: ReadyContext,
): Promise<{ slug: string; owner: GithubAppOwner } | null> {
  const member = context.member;
  const stored = member.app;
  if (isRecord(stored) && typeof stored.slug === 'string') {
    return {
      slug: stored.slug,
      owner: {
        accountName: String(stored.owner_account ?? ''),
        isOrganization: stored.owner_is_organization === true,
      },
    };
  }
  if (typeof member.app_id !== 'string' || typeof member.private_key !== 'string') return null;
  try {
    const { api } = githubHosts(baseUrlOf(member));
    return await lookupGithubApp(api, member.app_id, member.private_key, context.fetchImpl);
  } catch (err) {
    log.warn('could not look up the App of a ready page', {
      section: context.section,
      id: context.id,
      error: (err as Error).message,
    });
    return null;
  }
}

function baseUrlOf(member: Record<string, unknown>): string | undefined {
  return typeof member.base_url === 'string' ? member.base_url : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const githubProviderStarter = githubAppStarter({
  section: 'identity',
  choice: {
    name: 'audience',
    label: 'Who should be able to sign in',
    layout: 'dropdown',
    placements: SIGN_IN_AUDIENCES,
  },
  // An organization's App is installed, and the person installing it signs in as they do
  target: (id, placement) =>
    identityProviderTarget(id, '', placement.public, placement.organization),
  installOn: (owner) => `${owner}, so speicher.md can read the teams of the people signing in`,
});

export const githubSourceStarter = githubAppStarter({
  section: 'sources',
  choice: {
    name: 'account',
    label: SOURCE_ACCOUNT.label,
    layout: 'list',
    placements: [
      { value: 'org', label: SOURCE_ACCOUNT.organization, organization: true, public: false },
      { value: 'personal', label: SOURCE_ACCOUNT.personal, organization: false, public: false },
    ],
  },
  target: (id) => contentSourceTarget(id),
  installOn: (owner) => `${owner}, on the repositories speicher.md should read`,
});

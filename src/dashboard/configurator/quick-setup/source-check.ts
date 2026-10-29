import { CodedError } from '../../../common/errors';
import { rootLogger } from '../../../common/logger';
import { PUBLIC_GROUP_NAME } from '../../../common/principals';
import {
  RepositoryFiles,
  installationOn,
  repositoryConfigs,
} from '../../../github/app-installation';
import { githubAppLinks, installationUrl, lookupGithubApp } from '../../../github/app-links';
import { githubHosts } from '../../../github/hosts';
import { memberSectionId } from '../config-form/members';
import {
  ConfigFileBack,
  repositoriesConfigFilePath,
  sourceConfigFilePath,
} from '../config-page/github-app-manifest';
import type { CheckModal, CheckRow } from '../config-page/payloads';
import {
  KnownGroups,
  MissingGroup,
  RepositoryVerdict,
  checkRepository,
  isConfigPath,
  missingGroups,
  publicRepoRef,
} from './repository-check';

export type SourceCheck = Pick<CheckModal, 'problem' | 'repositories' | 'more'> & {
  missing: MissingGroup[];
  // The installation's page on GitHub, where the repositories it reads are picked
  installation_href?: string;
};

/**
 * checkSource asks GitHub for the repositories a source's App reads and checks their `.speicher.yaml` files.
 *
 * @param sourceId the source's short id
 * @param forge the source as stored, with its App
 * @param known the instance's groups
 * @param fetchImpl reaches GitHub
 * @param back where the modal that creates a `.speicher.yaml` leads back to
 */
export async function checkSource(
  sourceId: string,
  forge: Record<string, unknown>,
  known: KnownGroups,
  fetchImpl: typeof fetch,
  back: ConfigFileBack = 'check',
): Promise<SourceCheck> {
  const appId = String(forge.app_id);
  const privateKey = String(forge.private_key);
  const { api, web } = githubHosts(typeof forge.base_url === 'string' ? forge.base_url : undefined);
  const log = rootLogger.child('config.quick-setup');
  const nothing = { repositories: [], more: false, missing: [] };
  // What the check was doing, so a failure says where it stopped
  let step = 'look up the App';
  try {
    const app = await lookupGithubApp(api, appId, privateKey, fetchImpl);
    step = `find the App's installation on ${app.owner.accountName}`;
    const installation = await installationOn(
      api,
      appId,
      privateKey,
      app.owner.accountName,
      fetchImpl,
    );
    if (!installation) {
      return {
        ...nothing,
        problem: {
          text: `The App is not installed on **${app.owner.accountName}** yet, so it cannot access any repositories.`,
          href: githubAppLinks(web, app.slug, app.owner).installUrl,
          label: 'Install on GitHub',
        },
      };
    }
    step = 'list the repositories the App reads';
    const read = await repositoryConfigs(api, installation.token, isConfigPath, fetchImpl);
    for (const repo of read.repositories) {
      if (repo.files !== null) continue;
      log.warn('could not read the .speicher.yaml files of a repository', {
        source: sourceId,
        repository: repo.fullName,
        error: repo.error,
      });
    }
    const checked = read.repositories.map((repo) => ({
      repo,
      repository: repo.fullName,
      verdict: repo.files ? checkRepository(repo.files, known) : null,
    }));
    return {
      more: read.more,
      repositories: checked.map(({ repo, verdict }) =>
        checkRow(repo, verdict, web, sourceId, back, known),
      ),
      missing: missingGroups(checked),
      installation_href: installationUrl(web, app.owner, installation.installationId),
    };
  } catch (err) {
    const message = (err as Error).message;
    log.warn('could not check the repositories of a source', {
      source: sourceId,
      step,
      api,
      code: err instanceof CodedError ? err.code : undefined,
      error: message,
    });
    return { ...nothing, problem: { text: `Could not ${step}: ${message}.` } };
  }
}

/**
 * checkRow says what the check found in one repository.
 *
 * @param repo the repository and its `.speicher.yaml` files
 * @param verdict what the check found in them, or null when they could not be read
 * @param web the GitHub web host
 * @param sourceId the short id of the source that reads the repository
 * @param back where the modal that creates a `.speicher.yaml` leads back to
 */
function checkRow(
  repo: RepositoryFiles,
  verdict: RepositoryVerdict | null,
  web: string,
  sourceId: string,
  back: ConfigFileBack,
  known: KnownGroups,
): CheckRow {
  const href = `${web}/${repo.fullName}`;
  const name = repo.fullName;
  if (verdict === null) {
    return {
      name,
      href,
      state: 'unreadable',
      text: `GitHub could not be asked for its files: ${repo.error ?? 'no reason given'}`,
    };
  }
  const code = (each: string) => `\`${each}\``;
  // The root file, on GitHub's page that edits it
  const root = repo.files?.find((file) => !file.path.includes('/'));
  const edit = root
    ? { edit_href: `${href}/edit/${encodeURIComponent(repo.defaultBranch)}/${root.path}` }
    : {};
  switch (verdict.state) {
    case 'unpublished':
      return {
        name,
        href,
        state: 'unpublished',
        text: 'Not published: it has no `.speicher.yaml` yet',
        // Over the page the check is shown on
        create_href:
          back === 'setup'
            ? repositoriesConfigFilePath(sourceId, repo.fullName, repo.defaultBranch)
            : sourceConfigFilePath(sourceId, repo.fullName, repo.defaultBranch),
        create_action: sourceConfigFilePath(sourceId, repo.fullName, repo.defaultBranch, back),
      };
    case 'invalid':
      return {
        name,
        href,
        state: 'invalid',
        text: `${code(verdict.file)}: ${verdict.message}`,
        ...edit,
      };
    case 'unknown-groups':
      return {
        name,
        href,
        ...edit,
        groups: grantedGroups(verdict.readers),
        state: 'unknown-groups',
        text: `Missing group: ${verdict.groups
          .map((each) =>
            each.suggestion
              ? `${code(each.name)} (did you mean ${code(each.suggestion)}?)`
              : code(each.name),
          )
          .join(', ')}`,
      };
    case 'ready': {
      // A group links to its page; `public` and a count of people have none
      const publicAllowed = known.allowsPublic(publicRepoRef(name));
      const readers = verdict.readers
        .map((each) => {
          if (each === PUBLIC_GROUP_NAME) {
            return publicAllowed ? each : `${each} (not enabled for this repository)`;
          }
          return / /.test(each) ? each : `[${each}](/-/config/${memberSectionId('groups', each)})`;
        })
        .join(', ');
      return {
        name,
        href,
        ...edit,
        state: 'ready',
        text: `Readable by ${readers}`,
        readers,
        groups: grantedGroups(verdict.readers),
      };
    }
  }
}

// The groups among the readers, `public` included, without a count of people
function grantedGroups(readers: string[]): string[] {
  return readers.filter((each) => !/ /.test(each));
}

/**
 * configFileTarget returns the repository and branch a new `.speicher.yaml` is created on, and where its modal leads
 * back to, or null when the query names none.
 *
 * @param query the query of the request
 */
export function configFileTarget(
  query: Record<string, unknown>,
): { repository: string; branch: string; back: ConfigFileBack } | null {
  const { repository, branch } = query;
  if (typeof repository !== 'string' || typeof branch !== 'string' || branch === '') return null;
  const back = query.back === 'setup' ? 'setup' : 'check';
  // An owner and a name, so the address on GitHub cannot lead anywhere else
  return /^[\w.-]+\/[\w.-]+$/.test(repository) ? { repository, branch, back } : null;
}

/**
 * githubSourceOf returns a GitHub source with an App, or null.
 *
 * @param forge the source as stored, or none
 */
export function githubSourceOf(forge: unknown): Record<string, unknown> | null {
  if (typeof forge !== 'object' || forge === null) return null;
  const source = forge as Record<string, unknown>;
  return source.type === 'github' &&
    typeof source.app_id === 'string' &&
    typeof source.private_key === 'string'
    ? source
    : null;
}

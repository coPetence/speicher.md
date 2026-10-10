import { DirectoryConfig, GithubProviderConfig } from '../../config/types';

export function githubDirectoryProblems(
  providerKey: string,
  provider: GithubProviderConfig,
): string[] {
  const directory = provider.directory;
  if (!directory) return [];

  const at = `auth.providers.${providerKey}.directory`;
  if (directory.type !== 'github') {
    return [`${at}.type must be "github" for a github provider`];
  }

  const problems: string[] = [];

  for (const key of GRAPH_ONLY) {
    if (directory[key] !== undefined) {
      problems.push(`${at}.${key} belongs to a Microsoft Graph directory. Remove the key.`);
    }
  }

  for (const key of OWN_APP) {
    if (!directory[key]) {
      problems.push(
        `${at}.${key} is required: a GitHub directory reads organisations through its own GitHub App.`,
      );
    }
  }

  return problems;
}

/** Graph's credentials, which name nothing a GitHub organisation would answer to */
const GRAPH_ONLY: (keyof DirectoryConfig)[] = ['tenant_id', 'client_id', 'client_secret'];

/** The directory's own App, never a content source's */
const OWN_APP: (keyof DirectoryConfig)[] = ['app_id', 'private_key'];

/**
 * Split `org/team-slug`
 */
export function splitTeam(groupId: string): [string | null, string | null] {
  const cut = groupId.indexOf('/');
  if (cut <= 0 || cut === groupId.length - 1) return [null, null];

  const org = groupId.slice(0, cut);
  const slug = groupId.slice(cut + 1);
  return slug.includes('/') ? [null, null] : [org, slug];
}

export function githubGroupIdProblem(id: string): string | null {
  const [org, slug] = splitTeam(id);
  if (org !== null && slug !== null) return null;

  return `"${id}" does not name a GitHub team. A team is written \`org/team-slug\``;
}

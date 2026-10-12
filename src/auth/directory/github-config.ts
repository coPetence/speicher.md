import { DirectoryConfig, GithubProviderConfig } from '../../config/types';

export function githubDirectoryProblems(
  providerShortId: string,
  provider: GithubProviderConfig,
): string[] {
  const directory = provider.directory;
  if (!directory) return [];

  const at = `auth.providers.${providerShortId}.directory`;
  if (directory.type !== 'github') {
    return [`${at}.type must be "github" for a github provider`];
  }

  const problems: string[] = [];

  for (const key of MICROSOFT_GRAPH_SPECIFIC_CONFIG_KEYS) {
    if (directory[key] !== undefined) {
      problems.push(`${at}.${key} belongs to a Microsoft Graph directory. Remove the key.`);
    }
  }

  for (const key of GITHUB_DIRECTORY_SPECIFIC_CONFIG_KEYS) {
    if (!directory[key]) {
      problems.push(
        `${at}.${key} is required: a GitHub directory reads organisations through its own GitHub App.`,
      );
    }
  }

  return problems;
}

const MICROSOFT_GRAPH_SPECIFIC_CONFIG_KEYS: (keyof DirectoryConfig)[] = [
  'tenant_id',
  'client_id',
  'client_secret',
];
const GITHUB_DIRECTORY_SPECIFIC_CONFIG_KEYS: (keyof DirectoryConfig)[] = ['app_id', 'private_key'];

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

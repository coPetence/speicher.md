import { ConfigProblem, problem } from '../../common/config-problems';
import { DirectoryConfig, GithubProviderConfig } from '../../config/types';

export function githubDirectoryProblems(
  providerShortId: string,
  provider: GithubProviderConfig,
): ConfigProblem[] {
  const directory = provider.directory;
  if (!directory) return [];

  const at = `auth.providers.${providerShortId}.directory`;
  if (directory.type !== 'github') {
    return [
      problem('providers.directory-wrong-type', `${at}.type`, {
        text: 'must be "github" for a GitHub provider.',
        dashboard: 'Wrong directory type. Set it to "github".',
      }),
    ];
  }

  const problems: ConfigProblem[] = [];

  for (const key of MICROSOFT_GRAPH_SPECIFIC_CONFIG_KEYS) {
    if (directory[key] !== undefined) {
      problems.push(
        problem('providers.directory-foreign-key', `${at}.${key}`, {
          text: 'is not supported by GitHub directories. Remove it.',
          dashboard: `Remove "${key}". It is only supported by Microsoft Graph directories.`,
        }),
      );
    }
  }

  for (const key of GITHUB_DIRECTORY_SPECIFIC_CONFIG_KEYS) {
    if (!directory[key]) {
      problems.push(
        problem('providers.directory-key-missing', `${at}.${key}`, {
          text: 'is required for the directory’s GitHub App.',
          dashboard: `Missing "${key}". Add it for the directory’s GitHub App.`,
        }),
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

// Split org/team-slug; return [null, null] if invalid
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

  return `Invalid GitHub team "${id}". Use \`org/team-slug\`.`;
}

import { parseDuration } from '../../common/time';
import { slugify } from '../../common/slug';
import {
  DEFAULT_POLL_INTERVAL,
  ForgeConfig,
  GitRepoConfig,
  InstanceConfig,
  MIN_POLL_INTERVAL,
  gitRepositoryOwner,
} from '../types';

/**
 * checkGitForges checks the forges of type `git`: their repositories need unique
 * ids and slugs, a URL that names the repository owner, credentials that match the
 * remote, and no keys that only apply to other forge types.
 *
 * @param config the loaded instance config
 * @param problems the list that problems are added to
 */
export function checkGitForges(config: InstanceConfig, problems: string[]): void {
  const minMs = parseDuration(MIN_POLL_INTERVAL);

  for (const [forgeId, forge] of Object.entries(config.forges ?? {})) {
    if (forge.type !== 'git') {
      if (forge.repos !== undefined) {
        problems.push(`forge "${forgeId}": \`repos\` applies to \`type: git\` only`);
      }
      continue;
    }

    if (forge.webhook_secret !== undefined) {
      problems.push(
        `forge "${forgeId}": A forge of type \`git\` receives no webhooks. Remove \`webhook_secret\`, and set \`poll_interval\` to control how often the repositories are checked for new commits.`,
      );
    }
    if (forge.app_id !== undefined || forge.private_key !== undefined) {
      problems.push(
        `forge "${forgeId}": \`app_id\` and \`private_key\` belong to a GitHub App and are only used by a forge of type \`github\`. Remove them, and give each repository of this forge its own \`deploy_key\` or \`token\` instead.`,
      );
    }

    checkPollInterval(forge.poll_interval, minMs, `forge "${forgeId}"`, problems);

    const ids = new Set<string>();
    const slugs = new Map<string, string>();

    for (const repo of forge.repos ?? []) {
      const forgeRepoDescriptor = `forge "${forgeId}", repo "${repo.id}"`;

      // Ids name the mirror directory, and macOS and Windows file systems ignore case
      const key = repo.id.toLowerCase();
      if (ids.has(key)) {
        problems.push(
          `${forgeRepoDescriptor}: Another repository of this forge already uses the id "${repo.id}". Ids are case insensitive and must be unique.`,
        );
      }
      ids.add(key);

      const owner = gitRepositoryOwner(repo);
      if (owner === null || slugify(owner).length === 0) {
        problems.push(
          `${forgeRepoDescriptor}: The URL "${repo.url}" does not name the user or organization that owns the repository. Use the URL of the repository including its owner, for example https://git.example.com/acme/docs.git.`,
        );
      }

      const slug = slugify(repo.slug ?? repo.id);
      if (slug.length === 0) {
        problems.push(
          `${forgeRepoDescriptor}: The URL slug "${repo.slug ?? repo.id}" contains no letters or digits, so it cannot be used in a URL. Set \`slug\` to a name that contains letters or digits.`,
        );
      } else {
        const key = `${slugify(owner ?? '')}/${slug}`;
        const identicalSlug = slugs.get(key);
        if (identicalSlug)
          problems.push(
            `${forgeRepoDescriptor}: slug "${slug}" collides with repo "${identicalSlug}"`,
          );
        else slugs.set(key, repo.id);
      }

      if (repo.url.startsWith('ssh://')) {
        if (!repo.deploy_key) {
          problems.push(
            `${forgeRepoDescriptor}: A repository with an ssh:// URL needs a \`deploy_key\` to sign in to the server.`,
          );
        }
        if (!forge.known_hosts) {
          problems.push(
            `${forgeRepoDescriptor}: A repository with an ssh:// URL needs \`known_hosts\`, so Speicher can check that it is talking to the right server. Add the server's host key to \`known_hosts\` of the forge.`,
          );
        }
        if (repo.token) {
          problems.push(
            `${forgeRepoDescriptor}: A \`token\` is only used for repositories with an https:// URL, and this repository uses ssh://. Remove \`token\`, or change the URL to https://.`,
          );
        }
      } else {
        if (!repo.token) {
          problems.push(
            `${forgeRepoDescriptor}: A repository with an https:// URL needs a \`token\` to authenticate with the server. Add a read-only access token as \`token\`.`,
          );
        }
        if (repo.deploy_key) {
          problems.push(
            `${forgeRepoDescriptor}: A \`deploy_key\` is only used for repositories with an ssh:// URL, and this repository uses https://. Remove \`deploy_key\`, or change the URL to ssh://.`,
          );
        }
      }

      checkPollInterval(repo.poll_interval, minMs, forgeRepoDescriptor, problems);
    }
  }
}

/**
 * checkPollInterval checks that a poll interval is not below the minimum.
 *
 * @param value the configured poll interval, or undefined if none is set
 * @param minMs the minimum poll interval in milliseconds
 * @param where the forge or repository the interval belongs to, for the message
 * @param problems the list that problems are added to
 */
function checkPollInterval(
  value: string | undefined,
  minMs: number,
  where: string,
  problems: string[],
): void {
  if (value === undefined) return;
  if (parseDuration(value) < minMs) {
    problems.push(
      `${where}: \`poll_interval\` of ${value} is below the ${MIN_POLL_INTERVAL} floor`,
    );
  }
}

/**
 * pollIntervalMs returns the poll interval in milliseconds for a repository, falling back to the forge's poll interval and the default if none is set. The returned value is always at least the minimum poll interval.
 *
 * @param forge the forge the repository belongs to
 * @param repo the repository
 */
export function pollIntervalMs(forge: ForgeConfig, repo: GitRepoConfig): number {
  return parseDuration(repo.poll_interval ?? forge.poll_interval ?? DEFAULT_POLL_INTERVAL);
}

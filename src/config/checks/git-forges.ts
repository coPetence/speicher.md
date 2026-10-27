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
import { ConfigProblem, problem } from '../../common/config-problems';

/** Validate Git forge settings, repository IDs, slugs, URLs, and credentials. */
export function checkGitForges(config: InstanceConfig, problems: ConfigProblem[]): void {
  const minMs = parseDuration(MIN_POLL_INTERVAL);

  for (const [forgeId, forge] of Object.entries(config.forges ?? {})) {
    const at = `forges.${forgeId}`;
    if (forge.type !== 'git') {
      if (forge.repos !== undefined) {
        problems.push(
          problem('forges.repos-on-non-git', `${at}.repos`, {
            text: '`repos` requires `type: git`. Remove it for other forge types.',
            dashboard:
              'Only plain Git sources support a repository list. Remove it for this source.',
          }),
        );
      }
      continue;
    }

    if (forge.webhook_secret !== undefined) {
      problems.push(
        problem('forges.webhook-secret-on-git', `${at}.webhook_secret`, {
          text: 'Git forges do not use webhooks. Remove `webhook_secret`; use `poll_interval` to set the check frequency.',
          dashboard:
            'Plain Git sources do not use webhooks. Remove the webhook secret; use the poll interval to set the check frequency.',
        }),
      );
    }
    if (forge.app_id !== undefined || forge.private_key !== undefined) {
      problems.push(
        problem(
          'forges.app-key-on-git',
          `${at}.${forge.app_id !== undefined ? 'app_id' : 'private_key'}`,
          {
            text: '`app_id` and `private_key` require `type: github`. Remove them and set a `deploy_key` or `token` for each repository.',
            dashboard:
              'Plain Git sources cannot use GitHub App credentials. Remove the App ID and private key; use a deploy key or access token for each repository.',
          },
        ),
      );
    }

    checkPollInterval(forge.poll_interval, minMs, `${at}.poll_interval`, problems);

    const ids = new Set<string>();
    const slugs = new Map<string, string>();

    for (const [i, repo] of (forge.repos ?? []).entries()) {
      const repoAt = `${at}.repos[${i}]`;
      const name = `"${repo.id}"`;

      // Mirror directory names must be unique on case-insensitive file systems.
      const key = repo.id.toLowerCase();
      if (ids.has(key)) {
        problems.push(
          problem('forges.repo-id-taken', `${repoAt}.id`, {
            text: `Duplicate repository ID ${name}. Choose a unique ID within this forge; case differences do not count.`,
            dashboard: `Duplicate repository ID ${name}. Choose a unique ID within this source; case differences do not count.`,
          }),
        );
      }
      ids.add(key);

      const owner = gitRepositoryOwner(repo);
      if (owner === null || slugify(owner).length === 0) {
        problems.push(
          problem('forges.repo-url-no-owner', `${repoAt}.url`, {
            text: `URL "${repo.url}" has no valid repository owner. Include the user or organization, e.g. https://git.example.com/acme/docs.git.`,
            dashboard: `URL "${repo.url}" has no valid repository owner. Include the user or organization, e.g. https://git.example.com/acme/docs.git.`,
          }),
        );
      }

      const slugAt = `${repoAt}.${repo.slug !== undefined ? 'slug' : 'id'}`;
      const slug = slugify(repo.slug ?? repo.id);
      if (slug.length === 0) {
        problems.push(
          problem('forges.repo-slug-empty', slugAt, {
            text: `URL slug "${repo.slug ?? repo.id}" has no letters or digits. Set \`slug\` to a name containing letters or digits.`,
            dashboard: `URL slug "${repo.slug ?? repo.id}" has no letters or digits. Choose a slug containing letters or digits.`,
          }),
        );
      } else {
        const key = `${slugify(owner ?? '')}/${slug}`;
        const identicalSlug = slugs.get(key);
        if (identicalSlug) {
          problems.push(
            problem('forges.repo-slug-taken', slugAt, {
              text: `URL slug "${slug}" is already used by repository "${identicalSlug}". Set a different \`slug\`.`,
              dashboard: `URL slug "${slug}" is already used by repository "${identicalSlug}". Choose a different slug.`,
            }),
          );
        } else slugs.set(key, repo.id);
      }

      if (repo.url.startsWith('ssh://')) {
        if (!repo.deploy_key) {
          problems.push(
            problem('forges.ssh-needs-deploy-key', `${repoAt}.deploy_key`, {
              text: 'SSH requires a deploy key. Set `deploy_key` for this repository.',
              dashboard: `Repository ${name} uses SSH. Add a deploy key.`,
            }),
          );
        }
        if (!forge.known_hosts) {
          problems.push(
            problem('forges.ssh-needs-known-hosts', `${at}.known_hosts`, {
              text: `SSH repository ${name} requires server verification. Add the server's verified host key to \`known_hosts\`.`,
              dashboard: `SSH repository ${name} requires server verification. Click Fetch host keys, verify the fingerprints, and save.`,
            }),
          );
        }
        if (repo.token) {
          problems.push(
            problem('forges.token-on-ssh', `${repoAt}.token`, {
              text: 'SSH cannot use an access token. Remove `token` or switch the URL to https://.',
              dashboard: `Repository ${name} uses SSH, which cannot use an access token. Remove the token or switch the URL to https://.`,
            }),
          );
        }
      } else {
        if (!repo.token) {
          problems.push(
            problem('forges.https-needs-token', `${repoAt}.token`, {
              text: 'HTTPS requires an access token. Set `token` to a read-only access token.',
              dashboard: `Repository ${name} uses HTTPS. Add a read-only access token.`,
            }),
          );
        }
        if (repo.deploy_key) {
          problems.push(
            problem('forges.deploy-key-on-https', `${repoAt}.deploy_key`, {
              text: 'HTTPS cannot use a deploy key. Remove `deploy_key` or switch the URL to ssh://.',
              dashboard: `Repository ${name} uses HTTPS, which cannot use a deploy key. Remove the deploy key or switch the URL to ssh://.`,
            }),
          );
        }
      }

      checkPollInterval(repo.poll_interval, minMs, `${repoAt}.poll_interval`, problems);
    }
  }
}

/** Report configured poll intervals below the minimum. */
function checkPollInterval(
  value: string | undefined,
  minMs: number,
  path: string,
  problems: ConfigProblem[],
): void {
  if (value === undefined) return;
  if (parseDuration(value) < minMs) {
    problems.push(
      problem('forges.poll-interval-too-short', path, {
        text: `Poll interval ${value} is too short. Use at least ${MIN_POLL_INTERVAL}.`,
        dashboard: `Poll interval ${value} is too short. Use at least ${MIN_POLL_INTERVAL}.`,
      }),
    );
  }
}

/** Return the poll interval in milliseconds: repository, forge, then default. */
export function pollIntervalMs(forge: ForgeConfig, repo: GitRepoConfig): number {
  return parseDuration(repo.poll_interval ?? forge.poll_interval ?? DEFAULT_POLL_INTERVAL);
}

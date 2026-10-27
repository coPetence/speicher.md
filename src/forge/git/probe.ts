/**
 * The connection check of a repository on a plain git remote
 */

import { GitCredential, withGitCredential } from '../credential';
import { CheckStatus } from '../../common/check-status';
import { lsRemote } from '../git';

/** What the connection check of a remote found */
export type RemoteCode =
  | 'remote.connected'
  | 'remote.branch-missing'
  | 'remote.empty'
  | 'remote.timed-out'
  | 'remote.host-key-untrusted'
  | 'remote.deploy-key-refused'
  | 'remote.token-refused'
  | 'remote.host-unknown'
  | 'remote.connection-refused'
  | 'remote.not-found'
  | 'remote.failed';

export type RemoteStatus = CheckStatus<RemoteCode> & { level: 'ok' | 'warn' | 'fail' };

export type RemoteProber = (
  url: string,
  credential: GitCredential,
  branch: string,
) => Promise<RemoteStatus>;

const PROBE_TIMEOUT_MS = 15_000;

/**
 * probeRemote checks the connection to a remote repository and returns a status.
 * @param url the remote URL of the repository
 * @param credential the deploy key or the access token, and the known hosts
 * @param branch the configured branch, or an empty string for the default branch
 */
export async function probeRemote(
  url: string,
  credential: GitCredential,
  branch: string,
): Promise<RemoteStatus> {
  let listing: string;
  try {
    listing = await withGitCredential(url, credential, (invocation) =>
      lsRemote({ ...invocation, timeoutMs: PROBE_TIMEOUT_MS }, [
        branch === '' ? 'HEAD' : `refs/heads/${branch}`,
      ]),
    );
  } catch (err) {
    return failureOf((err as Error).message);
  }
  return listingStatus(listing, branch);
}

/**
 * listingStatus returns what the output of `git ls-remote --symref` says about a branch.
 * @param listing the output of `git ls-remote --symref`
 * @param branch the configured branch, or an empty string for the default branch
 */
export function listingStatus(listing: string, branch: string): RemoteStatus {
  const lines = listing.split('\n').filter((line) => line.trim() !== '');
  const commitOf = (ref: string) =>
    lines.find((line) => !line.startsWith('ref: ') && line.endsWith(`\t${ref}`))?.split('\t')[0];

  if (branch !== '') {
    const commit = commitOf(`refs/heads/${branch}`);
    return commit
      ? {
          code: 'remote.connected',
          level: 'ok',
          label: 'Connected',
          detail: `Branch ${branch} is at commit ${commit.slice(0, 8)}.`,
          facts: { branch, commit: commit.slice(0, 8) },
        }
      : {
          code: 'remote.branch-missing',
          level: 'fail',
          label: 'Branch not found',
          detail: `The repository has no branch ${branch}. Check the Branch field.`,
          facts: { branch },
        };
  }

  const head = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(
    lines.find((line) => line.startsWith('ref: ')) ?? '',
  )?.[1];
  const commit = commitOf('HEAD');
  if (!head || !commit) {
    return {
      code: 'remote.empty',
      level: 'warn',
      label: 'Empty repository',
      detail: 'The repository has no default branch yet, so there is nothing to sync.',
    };
  }
  return {
    code: 'remote.connected',
    level: 'ok',
    label: 'Connected',
    detail: `The default branch ${head} is at commit ${commit.slice(0, 8)}.`,
    facts: { branch: head, commit: commit.slice(0, 8) },
  };
}

// What git says when it cannot reach a repository, and what the user can do about it
const FAILURES: { code: RemoteCode; pattern: RegExp; label: string; detail: string }[] = [
  {
    pattern: /timed out after/,
    code: 'remote.timed-out',
    label: 'No answer',
    detail: `The server did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds.`,
  },
  {
    pattern: /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/,
    code: 'remote.host-key-untrusted',
    label: 'Host key not trusted',
    detail:
      'The known hosts hold no key of this server. To add it, press Fetch host keys in the Security card, compare the fingerprints and save.',
  },
  {
    pattern: /Permission denied \(publickey/,
    code: 'remote.deploy-key-refused',
    label: 'Deploy key refused',
    detail:
      'The server did not accept the deploy key. Add its public key to the repository as a deploy key.',
  },
  {
    pattern:
      /Authentication failed|could not read Username|could not read Password|returned error: 40[13]/,
    code: 'remote.token-refused',
    label: 'Access token refused',
    detail: 'The server did not accept the access token, or the token cannot read this repository.',
  },
  {
    pattern: /Could not resolve host/,
    code: 'remote.host-unknown',
    label: 'Server not found',
    detail: 'Speicher cannot resolve the server in the remote URL. Check the remote URL.',
  },
  {
    pattern: /Connection refused|Couldn't connect to server|Failed to connect to/,
    code: 'remote.connection-refused',
    label: 'Cannot connect',
    detail: 'Speicher cannot connect to the server. Check the remote URL and its port.',
  },
  {
    pattern:
      /Repository not found|does not appear to be a git repository|not found|returned error: 404/,
    code: 'remote.not-found',
    label: 'Repository not found',
    detail:
      'The server has no repository at this URL, or the deploy key or access token has no access to it. Check the remote URL.',
  },
];

/**
 * failureOf returns the status for an error of `git ls-remote`.
 * @param message the error message, with the credentials already removed
 */
export function failureOf(message: string): RemoteStatus {
  const known = FAILURES.find((failure) => failure.pattern.test(message));
  if (known) return { code: known.code, level: 'fail', label: known.label, detail: known.detail };
  // The last line of git's own output is the reason it gives
  const reason = message.trim().split('\n').pop() ?? message;
  return {
    code: 'remote.failed',
    level: 'fail',
    label: 'Not connected',
    detail: reason,
    facts: { reason },
  };
}

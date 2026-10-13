/**
 * Remote URLs of plain git repositories
 *
 * Git hosts such as GitHub show an SSH remote in the scp form, `git@github.com:owner/repo.git`.
 * Speicher accepts that form and stores it as an `ssh://` URL
 */

/**
 * SCP_FORM matches a remote in the scp form, `[user@]host:path`. It is written so that a browser also accepts it in the `pattern` attribute of an input
 */
export const SCP_FORM = '(?:([^@\\/:\\s]+)@)?([^@\\/:\\s]+):(?!\\/\\/)(?!\\d+(?:\\/|$))(\\S+)';

const SCP_URL = new RegExp(`^${SCP_FORM}$`, 'u');

/**
 * sshRemoteUrl returns the `ssh://` URL of a remote in the scp form. It returns `ssh://git@github.com/owner/repo.git` for `git@github.com:owner/repo.git`. It returns every other URL unchanged.
 * @param url the remote URL as the user entered it
 */
export function sshRemoteUrl(url: string): string {
  const match = SCP_URL.exec(url.trim());
  if (!match) return url;
  const [, user, host, path] = match;
  // `host:~/repo.git` becomes `ssh://host/~/repo.git`
  return `ssh://${user ? `${user}@` : ''}${host}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * repositoryName returns the name of the repository in a remote URL. It returns `docs` for `ssh://git@example.com/team/docs.git` and for `git@example.com:team/docs.git`. It returns an empty string if the URL names no repository.
 * @param url the remote URL as the user entered it
 */
export function repositoryName(url: string): string {
  const path = sshRemoteUrl(url)
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
  return (path.split('/').pop() ?? '').replace(/\.git$/i, '');
}

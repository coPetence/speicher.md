import { CodedError } from '../common/errors';

// Supported until 10 March 2028
// We use an older version because GitHub Enterprise servers often lag
export const GITHUB_API_VERSION = '2022-11-28';

export function githubHeaders(token?: string): Record<string, string> {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
}

/** A request to GitHub that got no usable answer, naming the request so a log says which one */
export class GithubRequestError extends CodedError<
  'github.request-timeout' | 'github.request-unreachable' | 'github.request-failed'
> {
  constructor(
    code: 'github.request-timeout' | 'github.request-unreachable' | 'github.request-failed',
    message: string,
    readonly url: string,
    readonly status: number | null = null,
  ) {
    super(code, message);
  }
}

/**
 * githubRequest sends a request to GitHub with a time limit. It answers with GitHub's response, whatever its status,
 * and throws a GithubRequestError that names the request when GitHub does not answer in time or cannot be reached.
 *
 * @param fetchImpl how GitHub is reached
 * @param url the request's address
 * @param init the request, and how many milliseconds GitHub has to answer it
 */
export async function githubRequest(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit & { timeoutMs: number },
): Promise<Response> {
  const { timeoutMs, ...request } = init;
  const named = `${request.method ?? 'GET'} ${url}`;
  try {
    return await fetchImpl(url, { ...request, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new GithubRequestError(
        'github.request-timeout',
        `GitHub did not answer ${named} within ${timeoutMs / 1000} s`,
        url,
      );
    }
    throw new GithubRequestError(
      'github.request-unreachable',
      `GitHub could not be reached for ${named}: ${(err as Error).message}`,
      url,
    );
  }
}

/**
 * fetchGithubUsername asks GitHub for the user name of an account, by the account's numeric id.
 *
 * @param fetchImpl how GitHub is reached
 * @param api the GitHub API base, e.g. `https://api.github.com`
 * @param userId the account's numeric id, e.g. `583231`
 */
export async function fetchGithubUsername(
  fetchImpl: typeof fetch,
  api: string,
  userId: string,
): Promise<string> {
  const url = `${api}/user/${encodeURIComponent(userId)}`;
  const response = await githubRequest(fetchImpl, url, {
    headers: githubHeaders(),
    timeoutMs: 5_000,
  });
  if (!response.ok) throw refusedRequest(response, url);
  const user = (await response.json()) as { login?: unknown };
  if (typeof user.login !== 'string' || user.login === '') {
    throw new GithubRequestError('github.request-failed', `No user for ${url}`, url);
  }
  return user.login;
}

/** A GithubRequestError for an answer that is not a success */
export function refusedRequest(
  response: Response,
  url: string,
  method = 'GET',
): GithubRequestError {
  return new GithubRequestError(
    'github.request-failed',
    `GitHub answered ${method} ${url} with ${response.status} ${response.statusText}`.trim(),
    url,
    response.status,
  );
}

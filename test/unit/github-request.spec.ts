import { GithubRequestError, githubRequest, refusedRequest } from '../../src/github/api';

const URL = 'https://api.github.com/app/installations?per_page=100&page=1';

function failingWith(name: string, message: string): typeof fetch {
  return (async () => {
    const err = new Error(message);
    err.name = name;
    throw err;
  }) as typeof fetch;
}

describe('a request to GitHub', () => {
  it('names the request that GitHub did not answer in time', async () => {
    const asked = githubRequest(
      failingWith('TimeoutError', 'The operation was aborted due to timeout'),
      URL,
      { timeoutMs: 5000 },
    );
    await expect(asked).rejects.toBeInstanceOf(GithubRequestError);
    await expect(asked).rejects.toMatchObject({
      code: 'github.request-timeout',
      url: URL,
      message: `GitHub did not answer GET ${URL} within 5 s`,
    });
  });

  it('names the request when GitHub cannot be reached, with why', async () => {
    await expect(
      githubRequest(failingWith('TypeError', 'getaddrinfo ENOTFOUND api.github.com'), URL, {
        method: 'POST',
        timeoutMs: 5000,
      }),
    ).rejects.toMatchObject({
      code: 'github.request-unreachable',
      message: `GitHub could not be reached for POST ${URL}: getaddrinfo ENOTFOUND api.github.com`,
    });
  });

  it('answers with whatever GitHub answered, and names a refusal by its status', async () => {
    const response = await githubRequest(
      (async () => new Response('{}', { status: 404, statusText: 'Not Found' })) as typeof fetch,
      URL,
      { timeoutMs: 5000 },
    );
    expect(response.status).toBe(404);
    expect(refusedRequest(response, URL)).toMatchObject({
      code: 'github.request-failed',
      status: 404,
      message: `GitHub answered GET ${URL} with 404 Not Found`,
    });
  });
});

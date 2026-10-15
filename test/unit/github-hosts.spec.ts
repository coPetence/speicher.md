import { GITHUB_API, GITHUB_WEB, githubHosts } from '../../src/forge/github/hosts';

describe('the addresses of a GitHub instance', () => {
  it('are those of GitHub.com when no base URL is set', () => {
    expect(githubHosts()).toEqual({ web: GITHUB_WEB, api: GITHUB_API });
    expect(githubHosts('')).toEqual({ web: GITHUB_WEB, api: GITHUB_API });
  });

  it.each([
    'https://github.com',
    'https://github.com/',
    'https://www.github.com',
    ' https://GitHub.com ',
  ])('are those of GitHub.com when the base URL names it, as %s', (baseUrl) => {
    expect(githubHosts(baseUrl)).toEqual({ web: GITHUB_WEB, api: GITHUB_API });
  });

  it('put the API of a GitHub Enterprise Server under /api/v3', () => {
    expect(githubHosts('https://github.example.com/')).toEqual({
      web: 'https://github.example.com',
      api: 'https://github.example.com/api/v3',
    });
  });
});

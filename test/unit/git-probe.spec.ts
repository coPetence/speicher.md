import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigService } from '../../src/config/config.service';
import { allFields, buildSections } from '../../src/dashboard/configurator/config-form/fields';
import { loadDocument } from '../../src/dashboard/configurator/config-form/document';
import { SectionChecks } from '../../src/dashboard/configurator/config-page/checks';
import type { ConfigSectionPayload } from '../../src/dashboard/configurator/config-page/payloads';
import type { GitCredential } from '../../src/forge/credential';
import { failureOf, listingStatus } from '../../src/forge/git/probe';

const FULL = readFileSync(join(__dirname, '../fixtures/instance-full.yaml'), 'utf8');
const RUNBOOKS = 'forges.onprem.repos.0.url';
const PLAYBOOKS = 'forges.onprem.repos.1.url';

describe('what the remote answers', () => {
  const LISTING = 'ref: refs/heads/main\tHEAD\n0123456789abcdef\tHEAD\n';

  it('names the default branch and its commit', () => {
    expect(listingStatus(LISTING, '')).toMatchObject({
      code: 'remote.connected',
      level: 'ok',
      facts: { branch: 'main', commit: '01234567' },
    });
  });

  it('names the configured branch and its commit, or says it is missing', () => {
    expect(listingStatus('fedcba9876543210\trefs/heads/docs\n', 'docs')).toMatchObject({
      code: 'remote.connected',
      facts: { branch: 'docs', commit: 'fedcba98' },
    });
    expect(listingStatus('', 'docs')).toMatchObject({
      code: 'remote.branch-missing',
      level: 'fail',
      facts: { branch: 'docs' },
    });
  });

  it('warns about a repository with nothing in it', () => {
    expect(listingStatus('', '')).toMatchObject({ code: 'remote.empty', level: 'warn' });
  });

  it('says what to do when git cannot reach the repository', () => {
    const code = (message: string) => failureOf(message).code;
    expect(code('git ls-remote failed: Host key verification failed.')).toBe(
      'remote.host-key-untrusted',
    );
    expect(code('git@example.test: Permission denied (publickey).')).toBe(
      'remote.deploy-key-refused',
    );
    expect(code("fatal: could not read Username for 'https://example.test'")).toBe(
      'remote.token-refused',
    );
    expect(code('ssh: Could not resolve hostname example.test: nodename nor servname')).toBe(
      'remote.host-unknown',
    );
    expect(code('git ls-remote failed: timed out after 15 seconds')).toBe('remote.timed-out');
    // git's own last line, passed on as the reason
    expect(failureOf('fatal: something else went wrong')).toMatchObject({
      code: 'remote.failed',
      level: 'fail',
      facts: { reason: 'fatal: something else went wrong' },
    });
  });
});

describe('the connection check of a plain git remote', () => {
  const payloadOf = (): ConfigSectionPayload =>
    ({
      section: buildSections(loadDocument(FULL)).find((s) => s.id === 'sources/onprem')!,
    }) as unknown as ConfigSectionPayload;
  const urlField = (payload: ConfigSectionPayload, path: string) =>
    allFields([payload.section!]).find((field) => field.path === path)!;

  // Records what it was asked and answers that it connected
  const recorder = () => {
    const asked: { url: string; credential: GitCredential; branch: string }[] = [];
    const checks = new SectionChecks(
      {} as ConfigService,
      null,
      null,
      undefined,
      async (url, credential, branch) => {
        asked.push({ url, credential, branch });
        return {
          code: 'remote.connected',
          level: 'ok',
          label: 'Connected',
          detail: 'Branch main is at commit 01234567.',
        };
      },
    );
    return { asked, checks };
  };

  const ENV = ['TEST_GH_PRIVATE_KEY', 'TEST_GH_WEBHOOK_SECRET'];
  beforeEach(() => ENV.forEach((name) => (process.env[name] = `${name}-value`)));
  afterEach(() => ENV.forEach((name) => delete process.env[name]));

  it('offers the check under each remote URL, and asks nothing', async () => {
    const { asked, checks } = recorder();
    const payload = payloadOf();
    await checks.stampRepositoryStatus(payload, FULL);

    expect(urlField(payload, RUNBOOKS).checkHref).toBe(
      `/-/config/sources/onprem?check=${encodeURIComponent(RUNBOOKS)}`,
    );
    expect(urlField(payload, PLAYBOOKS).checkHref).toContain(encodeURIComponent(PLAYBOOKS));
    expect(asked).toEqual([]);
  });

  it('checks only the repository the request names, with the credentials a sync uses', async () => {
    const { asked, checks } = recorder();
    const payload = payloadOf();
    await checks.stampRepositoryStatus(payload, FULL, PLAYBOOKS);

    expect(asked).toEqual([
      {
        url: 'https://example.test/internal/playbooks.git',
        credential: {
          deployKey: undefined,
          knownHosts: 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyOnly',
          token: 'TEST_GH_WEBHOOK_SECRET-value',
          username: 'x-access-token',
        },
        branch: 'main',
      },
    ]);
    expect(urlField(payload, PLAYBOOKS).status?.code).toBe('remote.connected');
    expect(urlField(payload, RUNBOOKS).status).toBeUndefined();
  });

  it('checks every repository when the request names none', async () => {
    const { asked, checks } = recorder();
    await checks.stampRepositoryStatus(payloadOf(), FULL, '1');
    expect(asked.map((each) => each.url).sort()).toEqual([
      'https://example.test/internal/playbooks.git',
      'ssh://git@example.test/internal/runbooks.git',
    ]);
  });

  it('names the variable that is not set, and does not connect', async () => {
    delete process.env.TEST_GH_PRIVATE_KEY;
    const { asked, checks } = recorder();
    const payload = payloadOf();
    await checks.stampRepositoryStatus(payload, FULL, RUNBOOKS);

    expect(asked).toEqual([]);
    const status = urlField(payload, RUNBOOKS).status;
    // The variable it is missing, and nothing about the rest of the document
    expect(status).toMatchObject({
      code: 'remote.not-configured',
      level: 'fail',
      facts: { variables: 'TEST_GH_PRIVATE_KEY' },
    });
  });
});

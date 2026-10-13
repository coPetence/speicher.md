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
    expect(listingStatus(LISTING, '')).toEqual({
      level: 'ok',
      label: 'Connected',
      detail: 'The default branch main is at commit 01234567.',
    });
  });

  it('names the configured branch and its commit, or says it is missing', () => {
    expect(listingStatus('fedcba9876543210\trefs/heads/docs\n', 'docs').detail).toBe(
      'Branch docs is at commit fedcba98.',
    );
    expect(listingStatus('', 'docs')).toMatchObject({ level: 'fail', label: 'Branch not found' });
  });

  it('warns about a repository with nothing in it', () => {
    expect(listingStatus('', '')).toMatchObject({ level: 'warn', label: 'Empty repository' });
  });

  it('says what to do when git cannot reach the repository', () => {
    const label = (message: string) => failureOf(message).label;
    expect(label('git ls-remote failed: Host key verification failed.')).toBe(
      'Host key not trusted',
    );
    expect(label('git@example.test: Permission denied (publickey).')).toBe('Deploy key refused');
    expect(label("fatal: could not read Username for 'https://example.test'")).toBe(
      'Access token refused',
    );
    expect(label('ssh: Could not resolve hostname example.test: nodename nor servname')).toBe(
      'Server not found',
    );
    expect(label('git ls-remote failed: timed out after 15 seconds')).toBe('No answer');
    expect(failureOf('fatal: something else went wrong')).toEqual({
      level: 'fail',
      label: 'Not connected',
      detail: 'fatal: something else went wrong',
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
        return { level: 'ok', label: 'Connected', detail: 'Branch main is at commit 01234567.' };
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
    expect(urlField(payload, PLAYBOOKS).status?.label).toBe('Connected');
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
    expect(urlField(payload, RUNBOOKS).status).toEqual({
      level: 'fail',
      label: 'Not configured',
      detail: '${TEST_GH_PRIVATE_KEY} is not set',
    });
  });
});

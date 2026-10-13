import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigService } from '../../src/config/config.service';
import {
  allFields,
  buildSections,
  type KnownHostsField,
} from '../../src/dashboard/configurator/config-form/fields';
import { loadDocument, serialise } from '../../src/dashboard/configurator/config-form/document';
import {
  SectionChecks,
  stampUnsavedHostKeys,
} from '../../src/dashboard/configurator/config-page/checks';
import type { ConfigSectionPayload } from '../../src/dashboard/configurator/config-page/payloads';
import { createHmac } from 'node:crypto';

import { validateForSave } from '../../src/config/loader';
import {
  fingerprintOf,
  knownHostsName,
  knowsHost,
  mergeKnownHosts,
  readKnownHosts,
  serversWithoutHostKey,
  sshHostOf,
} from '../../src/forge/host-keys';

const FULL = readFileSync(join(__dirname, '../fixtures/instance-full.yaml'), 'utf8');

// GitHub's published ed25519 host key and its fingerprint
const ED25519 = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const ED25519_FINGERPRINT = 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU';

const FETCH = 'fetch-host-keys:forges.onprem.known_hosts';

describe('the server of an ssh:// URL', () => {
  it('reads the host and the port, 22 when the URL names none', () => {
    expect(sshHostOf('ssh://git@example.test/internal/runbooks.git')).toEqual({
      host: 'example.test',
      port: 22,
    });
    expect(sshHostOf('ssh://git@example.test:2222/internal/runbooks.git')).toEqual({
      host: 'example.test',
      port: 2222,
    });
  });

  it('has none for another transport, or a host ssh-keyscan would read as an option', () => {
    expect(sshHostOf('https://example.test/internal/runbooks.git')).toBeNull();
    expect(sshHostOf('ssh://-oProxyCommand=evil/repo.git')).toBeNull();
  });

  it('is named in known_hosts by its host alone on port 22, and with its port otherwise', () => {
    expect(knownHostsName({ host: 'example.test', port: 22 })).toBe('example.test');
    expect(knownHostsName({ host: 'example.test', port: 2222 })).toBe('[example.test]:2222');
  });
});

describe('the lines of known_hosts', () => {
  it('give each key the fingerprint ssh-keygen prints for it', () => {
    expect(fingerprintOf(ED25519)).toBe(ED25519_FINGERPRINT);
  });

  it('skip comments and blank lines, and count lines that are not a key', () => {
    const { keys, unreadable } = readKnownHosts(
      `# pinned\n\ngithub.com ssh-ed25519 ${ED25519}\n@cert-authority *.example.test ssh-ed25519 ${ED25519}\nnot a key\n`,
    );
    expect(keys).toEqual([
      { host: 'github.com', type: 'ssh-ed25519', fingerprint: ED25519_FINGERPRINT },
      { host: '*.example.test', type: 'ssh-ed25519', fingerprint: ED25519_FINGERPRINT },
    ]);
    expect(unreadable).toBe(1);
  });

  it("replace a fetched server's lines and keep every other server's and the comments", () => {
    const merged = mergeKnownHosts(
      '# pinned by hand\nexample.test ssh-rsa OLD\nexample.test,10.0.0.1 ssh-ed25519 OLDER\nother.test ssh-ed25519 KEEP',
      ['example.test'],
      '# example.test:22 SSH-2.0\nexample.test ssh-ed25519 NEW',
    );
    expect(merged).toBe(
      '# pinned by hand\nother.test ssh-ed25519 KEEP\nexample.test ssh-ed25519 NEW',
    );
  });
});

describe('whether known_hosts holds a key for a server', () => {
  const salt = Buffer.from('0123456789abcdefghij');
  const hashed = (name: string) =>
    `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(name).digest('base64')}`;

  it('finds a server by a plain name, in a list, by a pattern and by a hashed name', () => {
    expect(knowsHost(`github.com ssh-ed25519 ${ED25519}`, 'github.com')).toBe(true);
    expect(knowsHost(`a.test,github.com ssh-ed25519 ${ED25519}`, 'github.com')).toBe(true);
    expect(knowsHost(`*.example.test ssh-ed25519 ${ED25519}`, 'git.example.test')).toBe(true);
    expect(knowsHost(`${hashed('github.com')} ssh-ed25519 ${ED25519}`, 'github.com')).toBe(true);
    expect(
      knowsHost(`[git.example.test]:2222 ssh-ed25519 ${ED25519}`, '[git.example.test]:2222'),
    ).toBe(true);
  });

  it('does not count another server, an excluded one, a revoked key or an unreadable line', () => {
    expect(knowsHost(`gitlab.com ssh-ed25519 ${ED25519}`, 'github.com')).toBe(false);
    expect(knowsHost(`git.example.test ssh-ed25519 ${ED25519}`, '[git.example.test]:2222')).toBe(
      false,
    );
    expect(
      knowsHost(`*.example.test,!git.example.test ssh-ed25519 ${ED25519}`, 'git.example.test'),
    ).toBe(false);
    expect(knowsHost(`@revoked github.com ssh-ed25519 ${ED25519}`, 'github.com')).toBe(false);
    expect(knowsHost('github.com ssh-ed25519 AAAA', 'github.com')).toBe(false);
  });

  it('lists the ssh:// servers of a forge that have no key, and none behind a variable', () => {
    const repos = [
      { url: 'ssh://git@github.com/acme/docs.git' },
      { url: 'ssh://git@git.example.test:2222/ops/notes.git' },
      { url: 'https://example.test/acme/handbook.git' },
    ];
    expect(
      serversWithoutHostKey({ known_hosts: `github.com ssh-ed25519 ${ED25519}`, repos }),
    ).toEqual(['[git.example.test]:2222']);
    expect(serversWithoutHostKey({ known_hosts: '${KNOWN_HOSTS}', repos })).toEqual([]);
  });

  it('refuses to save a configuration with an ssh:// server that has no key', () => {
    const withoutKeys = FULL.replace(
      /^ {4}known_hosts: .*$/m,
      `    known_hosts: other.test ssh-ed25519 ${ED25519}`,
    );
    expect(withoutKeys).not.toBe(FULL);
    expect(() => validateForSave(withoutKeys)).toThrow(/no trusted host key/);
    expect(() => validateForSave(FULL)).not.toThrow(/host key/);
  });
});

describe('fetching the host keys of a git source', () => {
  const field = (yaml: string): KnownHostsField => {
    const section = buildSections(loadDocument(yaml)).find((s) => s.id === 'sources/onprem')!;
    return allFields([section]).find((f): f is KnownHostsField => f.kind === 'known-hosts')!;
  };

  it("offers the servers of the source's ssh:// repositories, each once", () => {
    expect(field(FULL).serverNames).toEqual(['example.test']);
    expect(field(FULL).fetchOp).toBe(FETCH);
  });

  it('writes the fetched keys into the field, unsaved, and says to compare them', async () => {
    const doc = loadDocument(FULL);
    const asked: string[] = [];
    const checks = new SectionChecks({} as ConfigService, null, null, async (server) => {
      asked.push(knownHostsName(server));
      return `example.test ssh-ed25519 ${ED25519}`;
    });

    const answer = await checks.fetchHostKeys(doc, 'sources/onprem', FETCH);

    expect(asked).toEqual(['example.test']);
    expect(answer?.changed).toBe(true);
    expect(answer?.status.level).toBe('warn');
    expect(answer?.status.detail).toContain(
      'Save only if their fingerprints match the published ones',
    );
    expect(field(serialise(doc)).keys).toEqual([
      { host: 'example.test', type: 'ssh-ed25519', fingerprint: ED25519_FINGERPRINT },
    ]);
  });

  it('leaves the lines alone and says so when the server answers with the saved keys', async () => {
    const doc = loadDocument(FULL);
    const before = serialise(doc);
    const saved = /^ {4}known_hosts: (.*)$/m.exec(FULL)![1];
    const checks = new SectionChecks({} as ConfigService, null, null, async () => saved);

    const answer = await checks.fetchHostKeys(doc, 'sources/onprem', FETCH, FULL);

    expect(answer?.changed).toBe(false);
    expect(answer?.status.level).toBe('ok');
    expect(answer?.status.detail).toBe('The keys of example.test are already saved.');
    expect(serialise(doc)).toBe(before);
  });

  it('asks to compare the fingerprints when the keys differ from the saved ones', async () => {
    const doc = loadDocument(FULL);
    const checks = new SectionChecks(
      {} as ConfigService,
      null,
      null,
      async () => `example.test ssh-ed25519 ${ED25519}`,
    );

    const answer = await checks.fetchHostKeys(doc, 'sources/onprem', FETCH, FULL);

    expect(answer?.changed).toBe(true);
    expect(answer?.status.level).toBe('warn');
    expect(answer?.status.detail).toContain('example.test are not saved yet');
  });

  it('changes nothing and says why when the server does not answer', async () => {
    const doc = loadDocument(FULL);
    const before = serialise(doc);
    const checks = new SectionChecks({} as ConfigService, null, null, async () => {
      throw new Error('The server example.test did not answer with a host key within 5 seconds.');
    });

    const answer = await checks.fetchHostKeys(doc, 'sources/onprem', FETCH);

    expect(answer?.changed).toBe(false);
    expect(answer?.status.level).toBe('fail');
    expect(answer?.status.detail).toContain('did not answer');
    expect(serialise(doc)).toBe(before);
  });

  it('asks nobody for an operation that is not the Fetch button of a field on the page', async () => {
    const scanner = jest.fn(async () => '');
    const checks = new SectionChecks({} as ConfigService, null, null, scanner);

    expect(
      await checks.fetchHostKeys(loadDocument(FULL), 'sources/onprem', 'fetch-host-keys:admins'),
    ).toBeNull();
    expect(await checks.fetchHostKeys(loadDocument(FULL), 'sources/onprem', 'add:x')).toBeNull();
    expect(scanner).not.toHaveBeenCalled();
  });

  it('keeps asking to compare the fingerprints of unsaved keys after another round trip', async () => {
    const doc = loadDocument(FULL);
    const checks = new SectionChecks(
      {} as ConfigService,
      null,
      null,
      async () => `example.test ssh-ed25519 ${ED25519}`,
    );
    await checks.fetchHostKeys(doc, 'sources/onprem', FETCH);
    const page = (yaml: string) =>
      ({
        section: buildSections(loadDocument(yaml)).find((s) => s.id === 'sources/onprem')!,
      }) as ConfigSectionPayload;
    const noteOf = (payload: ConfigSectionPayload) =>
      allFields([payload.section!]).find((f): f is KnownHostsField => f.kind === 'known-hosts')!
        .fetchNote;

    const unsaved = page(serialise(doc));
    stampUnsavedHostKeys(unsaved, FULL);
    expect(noteOf(unsaved)?.level).toBe('warn');
    expect(noteOf(unsaved)?.detail).toContain('not saved yet');

    const saved = page(serialise(doc));
    stampUnsavedHostKeys(saved, serialise(doc));
    expect(noteOf(saved)).toBeUndefined();
  });
});

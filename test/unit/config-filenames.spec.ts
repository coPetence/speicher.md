import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfigFromFile } from '../../src/config/parser';
import { NotPublishedError } from '../../src/ingest/walk/root';
import { walkRepo } from '../../src/ingest/walk/walk';

let config: ConfigService;
let root: string;

beforeAll(() => {
  config = new ConfigService(loadInstanceConfigFromFile(process.env.SPEICHER_CONFIG as string));
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'speicher-config-filenames-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, contents: string): void {
  const target = join(root, relative);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, contents);
}

const ROOT_CONFIG = 'version: 1\naccess:\n  groups: [engineering]\ningest_root: docs\n';

const walk = () =>
  walkRepo({
    workingTree: root,
    config,
    repo: { namespace: 'copetence', slug: 'handbook' },
    now: new Date('2026-08-22T00:00:00Z'),
  });

describe('config file names', () => {
  it('accepts .speicher.yml as the root config', async () => {
    write('.speicher.yml', ROOT_CONFIG);
    write('docs/intro.md', '# Intro\n');

    const result = await walk();

    expect(result.findings.rejections).toEqual([]);
    expect(result.documents.map((doc) => doc.slugPath)).toContain('intro');
  });

  it('treats a missing root config under both names as unpublished', async () => {
    write('docs/intro.md', '# Intro\n');

    await expect(walk()).rejects.toBeInstanceOf(NotPublishedError);
  });

  it('reads a folder .speicher.yml and reports findings against that file', async () => {
    write('.speicher.yaml', ROOT_CONFIG);
    write('docs/guides/.speicher.yml', 'version: 1\n');
    write('docs/guides/setup.md', '# Setup\n');

    const { findings } = await walk();

    const sources = findings.all.map((f) => f.source);
    expect(sources).toContain('docs/guides/.speicher.yml');
    expect(sources).not.toContain('docs/guides/.speicher.yaml');
  });

  it('prefers .speicher.yaml and warns that .speicher.yml is ignored', async () => {
    write('.speicher.yaml', ROOT_CONFIG);
    write('.speicher.yml', 'this: [is not valid');
    write('docs/intro.md', '# Intro\n');

    const result = await walk();

    expect(result.findings.rejections).toEqual([]);
    const duplicates = result.findings.all.filter((f) => f.code === 'duplicate-config');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({ severity: 'warn', source: '.speicher.yaml' });
    expect(duplicates[0].message).toContain('.speicher.yml');
  });

  it('warns about a duplicate in a folder too', async () => {
    write('.speicher.yaml', ROOT_CONFIG);
    write('docs/guides/.speicher.yaml', 'display:\n  title: Guides\n');
    write('docs/guides/.speicher.yml', 'display:\n  title: Other\n');
    write('docs/guides/setup.md', '# Setup\n');

    const { findings } = await walk();

    expect(findings.all.filter((f) => f.code === 'duplicate-config').map((f) => f.source)).toEqual([
      'docs/guides/.speicher.yaml',
    ]);
  });
});

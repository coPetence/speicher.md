import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfigFromFile } from '../../src/config/parser';
import { computeResolutionHash } from '../../src/config/resolution-hash';
import { validateInstanceSchema } from '../../src/config/schemas';
import { InstanceConfig, autolinkExcludedDomains } from '../../src/config/types';
import { renderMarkdown } from '../../src/ingest/markdown';
import { walkRepo } from '../../src/ingest/walk/walk';

const EXCLUDED = new Set(['speicher.md']);

const rendered = (source: string, unlinkedDomains: ReadonlySet<string> = EXCLUDED) =>
  renderMarkdown(source, { unlinkedDomains }).html;

describe('a domain excluded from automatic links', () => {
  it('stays plain text', () => {
    expect(rendered('We use speicher.md here.\n')).toContain('<p>We use speicher.md here.</p>');
  });

  it('stays plain text with a path, and in a heading, a list and a table', () => {
    const html = rendered(
      '# On speicher.md\n\n- speicher.md/pricing\n\n| a |\n| - |\n| speicher.md |\n',
    );
    expect(html).not.toContain('<a ');
  });

  it('matches whatever way the address is capitalized', () => {
    expect(rendered('Read Speicher.MD now.\n')).toContain('<p>Read Speicher.MD now.</p>');
  });

  it('keeps the other addresses of the sentence as links', () => {
    const html = rendered('From speicher.md to example.com.\n');
    expect(html).toContain('From speicher.md to <a');
    expect(html).toContain('href="http://example.com"');
  });

  it('does not cover a subdomain, which needs its own entry', () => {
    expect(rendered('See docs.speicher.md.\n')).toContain('href="http://docs.speicher.md"');
  });

  it('keeps an address written with its scheme as a link', () => {
    expect(rendered('See https://speicher.md/pricing.\n')).toContain(
      'href="https://speicher.md/pricing"',
    );
  });

  it('keeps a Markdown link as a link', () => {
    expect(rendered('[speicher.md](https://speicher.md)\n')).toContain(
      'href="https://speicher.md"',
    );
  });

  it('keeps an email address as a link', () => {
    expect(rendered('Write to ferdinand.duschka@speicher.md.\n')).toContain(
      'href="mailto:ferdinand.duschka@speicher.md"',
    );
  });

  it('links everything as before while nothing is excluded', () => {
    expect(rendered('We use speicher.md.\n', new Set())).toContain('href="http://speicher.md"');
    expect(renderMarkdown('We use speicher.md.\n').html).toContain('href="http://speicher.md"');
  });
});

describe('a repository walked with excluded domains in the instance config', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'speicher-autolink-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the domain plain text on the stored page, and other addresses links', async () => {
    const fixture = readFileSync(process.env.SPEICHER_CONFIG as string, 'utf8');
    const instance = join(root, 'instance.yaml');
    writeFileSync(instance, `${fixture}\nautolink:\n  exclude_domains:\n    - Speicher.MD\n`);
    const repository = join(root, 'repository');
    mkdirSync(join(repository, 'docs'), { recursive: true });
    writeFileSync(
      join(repository, '.speicher.yaml'),
      'version: 1\naccess:\n  groups: [engineering]\ningest_root: docs\n',
    );
    writeFileSync(join(repository, 'docs', 'index.md'), 'From speicher.md to example.com.\n');

    const { documents } = await walkRepo({
      workingTree: repository,
      config: new ConfigService(loadInstanceConfigFromFile(instance)),
      repo: { namespace: 'copetence', slug: 'handbook' },
      now: new Date('2026-08-22T00:00:00Z'),
    });

    const [page] = documents;
    expect(page.html).toContain('From speicher.md to <a');
    expect(page.html).toContain('href="http://example.com"');
  });
});

describe('the excluded domains in the config', () => {
  const config = (exclude_domains?: string[]) =>
    ({ version: 1, autolink: { exclude_domains } }) as unknown as InstanceConfig;
  const hash = (domains?: string[]) => computeResolutionHash(config(domains), null);

  it('are lower case, sorted and unique', () => {
    expect(autolinkExcludedDomains(config(['b.md', 'Speicher.MD', 'speicher.md']))).toEqual([
      'b.md',
      'speicher.md',
    ]);
    expect(autolinkExcludedDomains({} as InstanceConfig)).toEqual([]);
  });

  it('rebuild the repositories when they change', () => {
    expect(hash(['speicher.md'])).not.toBe(hash());
    expect(hash(['speicher.md'])).not.toBe(hash(['speicher.md', 'example.com']));
  });

  it('rebuild nothing when only their order or capitalization changes', () => {
    expect(hash(['b.md', 'a.md'])).toBe(hash(['a.md', 'B.md']));
  });

  it('keep the hash of an instance that has none', () => {
    const untouched = computeResolutionHash({ version: 1 } as unknown as InstanceConfig, null);
    expect(hash([])).toBe(untouched);
    expect(hash()).toBe(untouched);
  });

  it.each(['speicher.md', 'docs.Speicher.md'])('accept the domain %s', (domain) => {
    validateInstanceSchema({ version: 1, autolink: { exclude_domains: [domain] } });
    const errors = validateInstanceSchema.errors ?? [];
    expect(errors.filter((each) => each.instancePath.startsWith('/autolink'))).toEqual([]);
  });

  it.each(['https://speicher.md', 'speicher.md/pricing', 'localhost', 'a b.md'])(
    'refuse %s, which is not a domain',
    (domain) => {
      validateInstanceSchema({ version: 1, autolink: { exclude_domains: [domain] } });
      const errors = validateInstanceSchema.errors ?? [];
      expect(errors.map((each) => each.instancePath)).toContain('/autolink/exclude_domains/0');
    },
  );
});

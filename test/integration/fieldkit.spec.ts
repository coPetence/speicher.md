import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { QueryTypes } from 'sequelize';

import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { headingSlug } from '../../src/ingest/markdown';
import { Harness, PrincipalName, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

let app: INestApplication;
let harness: Harness;
const cookies: Partial<Record<PrincipalName, string>> = {};

beforeAll(async () => {
  harness = await createHarness();
  app = await bootTestApp();
  for (const name of ['alice', 'bob', 'carol', 'ops'] as PrincipalName[]) {
    cookies[name] = await sessionCookieFor(harness.tenantId, name);
  }
});

afterAll(async () => {
  await app?.close();
  await harness?.close();
  await closeSequelize();
});

function as(who: PrincipalName | 'anonymous') {
  const agent = request(app.getHttpServer());
  const cookie = who === 'anonymous' ? undefined : cookies[who];
  return {
    get(path: string) {
      const req = agent.get(path);
      return cookie ? req.set('Cookie', cookie) : req;
    },
  };
}

async function rows<T extends object>(sql: string): Promise<T[]> {
  return getSequelize().query<T>(sql, {
    type: QueryTypes.SELECT,
    replacements: { repoId: harness.repos.fieldkit },
  });
}

describe('a repository written for another tool ingests without being adapted first', () => {
  it('takes every file, with no rejection anywhere', async () => {
    const [{ c }] = await rows<{ c: string }>(
      `SELECT count(*)::text AS c FROM documents WHERE repo_id = :repoId`,
    );
    expect(Number(c)).toBe(32);

    const [run] = await rows<{ status: string; findings: { severity: string }[] }>(
      `SELECT status, findings FROM sync_runs WHERE repo_id = :repoId
        ORDER BY started_at DESC LIMIT 1`,
    );
    expect(run.status).toBe('ok');
    expect(run.findings.filter((f) => f.severity === 'reject')).toEqual([]);
  });

  it('serves `.mdx` at the URL the source project published it at', async () => {
    const [{ c }] = await rows<{ c: string }>(
      `SELECT count(*)::text AS c FROM documents
        WHERE repo_id = :repoId AND source_path LIKE '%.mdx'`,
    );
    expect(Number(c)).toBe(31);
    expect((await as('alice').get('/fieldkit/device-management')).status).toBe(200);
    expect((await as('alice').get('/fieldkit/device-management.mdx')).status).toBe(404);
  });

  it('treats `index.mdx` as the folder, exactly as `index.md` would', async () => {
    const [page] = await rows<{ source_path: string; is_index: boolean }>(
      `SELECT source_path, is_index FROM documents
        WHERE repo_id = :repoId AND slug_path = 'python-sdk'`,
    );
    expect(page.source_path).toBe('docs/python-sdk/index.mdx');
    expect(page.is_index).toBe(true);
    expect((await as('alice').get('/fieldkit/python-sdk')).status).toBe(200);
    expect((await as('alice').get('/fieldkit/python-sdk/index')).status).toBe(404);
  });
});

describe('foreign frontmatter', () => {
  it('warns and drops unknown keys rather than rejecting the file', async () => {
    const [run] = await rows<{ findings: { severity: string; code: string; message: string }[] }>(
      `SELECT findings FROM sync_runs WHERE repo_id = :repoId ORDER BY started_at DESC LIMIT 1`,
    );
    const unknown = run.findings.filter((f) => f.code === 'unknown-key');
    expect(unknown.length).toBe(32);
    expect(new Set(unknown.map((f) => /"([^"]+)"/.exec(f.message)?.[1])).size).toBe(10);
    expect(unknown.every((f) => f.severity === 'warn')).toBe(true);
  });

  it('keeps the title it does understand', async () => {
    const [{ c }] = await rows<{ c: string }>(
      `SELECT count(*)::text AS c FROM documents
        WHERE repo_id = :repoId AND (title IS NULL OR title = '')`,
    );
    expect(Number(c)).toBe(0);
  });
});

describe('foreign content meets the sanitiser', () => {
  it('stores no script, style or event handler anywhere in the repo', async () => {
    const bad = await rows<{ slug_path: string }>(
      `SELECT slug_path FROM documents
        WHERE repo_id = :repoId
          AND (html ~* '<script|<style|<iframe| on[a-z]+=' )`,
    );
    expect(bad.map((b) => b.slug_path)).toEqual([]);
  });

  it('emits no dangerous scheme in any href or src', async () => {
    const bad = await rows<{ slug_path: string }>(
      `SELECT slug_path FROM documents
        WHERE repo_id = :repoId
          AND html ~* '(href|src)="\\s*(javascript|data|vbscript|file):'`,
    );
    expect(bad.map((b) => b.slug_path)).toEqual([]);
  });

  it('shows no component tag and no module code as text, anywhere outside code', async () => {
    // Inside code a tag is an example and stays. Outside it, `&lt;Tabs` is the
    // shape an HTML block used to leave behind.
    const docs = await rows<{ slug_path: string; html: string }>(
      `SELECT slug_path, html FROM documents WHERE repo_id = :repoId`,
    );
    const leaked = docs.filter(({ html }) => {
      const prose = html.replace(/<pre[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>/g, '');
      return /&lt;\/?(Tabs|TabItem|Aside|Card|CardGrid|LinkCard|Steps|FileTree|Badge|Icon|Code|LinkButton|ExploreMore|Fragment)\b|<p>import /.test(
        prose,
      );
    });
    expect(leaked.map((d) => d.slug_path)).toEqual([]);
  });

  it("drops an embedded video rather than framing somebody else's page", async () => {
    // surveys.mdx carries a block-level <iframe>, as docs with a walkthrough video
    // do. A block of HTML reaches the sanitiser intact, so the element is removed
    // whole rather than escaped — asserted on the page that has one, since the
    // repo-wide check above would pass just as well if the corpus had none.
    const [page] = await rows<{ html: string; plain: string }>(
      `SELECT html, plain FROM documents WHERE repo_id = :repoId AND slug_path = 'surveys'`,
    );
    expect(page.html).not.toMatch(/iframe|youtube/i);
    expect(page.plain).toContain('versioned');
  });

  it('extracts plain text from every page that has a body', async () => {
    const empty = await rows<{ source_path: string }>(
      `SELECT source_path FROM documents
        WHERE repo_id = :repoId AND (plain IS NULL OR plain = '')`,
    );
    expect(empty.map((e) => e.source_path)).toEqual(['docs/404.md']);
  });

  it('boxes the directives the corpus contains', async () => {
    const [{ c }] = await rows<{ c: string }>(
      `SELECT count(*)::text AS c FROM documents
        WHERE repo_id = :repoId AND html LIKE '%spr-callout%'`,
    );
    expect(Number(c)).toBeGreaterThan(5);
  });

  it('leaves an unopened `:::` as text — the corpus has one, after the bulk-retirement example', async () => {
    const stray = await rows<{ slug_path: string }>(
      `SELECT slug_path FROM documents WHERE repo_id = :repoId AND html LIKE '%<p>:::%'`,
    );
    expect(stray.map((s) => s.slug_path)).toEqual(['device-management']);
  });
});

describe('in-page anchors', () => {
  it('gives every resolved in-page link something to land on', async () => {
    const docs = await getSequelize().query<{ slug_path: string; html: string; title: string }>(
      `SELECT slug_path, html, title FROM documents`,
      { type: QueryTypes.SELECT },
    );

    const broken: string[] = [];
    let links = 0;
    for (const doc of docs) {
      const ids = new Set([...doc.html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
      ids.add(headingSlug(doc.title));
      for (const match of doc.html.matchAll(/href="#([^"]+)"/g)) {
        if (match[1].startsWith('broken-asset')) continue;
        links += 1;
        if (!ids.has(decodeURIComponent(match[1]))) {
          broken.push(`${doc.slug_path || '<root>'} -> #${match[1]}`);
        }
      }
    }

    expect(links).toBeGreaterThan(0);
    expect(broken).toEqual([]);
  });

  it('KNOWN GAP: an internal link written as a URL does not resolve', async () => {
    const [{ c }] = await rows<{ c: string }>(
      `SELECT count(*)::text AS c FROM documents
        WHERE repo_id = :repoId AND html LIKE '%#broken-asset%'`,
    );
    // Eight since `<Aside>`'s content is parsed: tools/cli.mdx writes its one
    // link as a URL inside one, and used to show it as source text instead.
    expect(Number(c)).toBe(8);
  });
});

describe('Starlight components', () => {
  async function html(slugPath: string): Promise<string> {
    const [page] = await rows<{ html: string }>(
      `SELECT html FROM documents WHERE repo_id = :repoId AND slug_path = '${slugPath}'`,
    );
    return page.html;
  }

  it('parses Markdown inside a block-level component', async () => {
    // `<Aside>` on a line of its own used to open an HTML block, whose interior is
    // not Markdown: the link inside it was shown as its source text.
    const cli = await html('tools/cli');
    expect(cli).not.toContain('[configuration file]');
    expect(cli).toMatch(
      /<div class="spr-callout spr-callout-note">[\s\S]*?<a [^>]*>configuration file<\/a>/,
    );
  });

  it('draws tabs as labelled panels, with a fence and its blank lines intact in each', async () => {
    const index = await html('');
    expect(index.match(/<div class="spr-tabs" data-spr-tabs="language">/g)).toHaveLength(2);
    expect(index).toContain('<div class="spr-tab"><p class="spr-tab-label">TypeScript</p>');
    expect(index).toMatch(/<pre><code class="language-python">[\s\S]*?\n\n[\s\S]*?print/);
  });

  it('wraps the lists Steps and FileTree are written as', async () => {
    expect(await html('getting-started')).toMatch(
      /<div class="spr-procedure">\n<ol>\n<li>\n<p>Install the CLI with Homebrew:<\/p>\n<pre><code class="language-bash">/,
    );
    expect(await html('configuration')).toMatch(/<div class="spr-file-tree">\n<ul>/);
  });

  it('draws cards as a folder listing does, whether indented by tabs or by four spaces', async () => {
    const index = await html('');
    expect(index).toContain('<ul class="spr-listing spr-cards">\n<li><a href="');
    expect(index.match(/<li><a href="[^"]*">[^<]+<\/a>(<p>[^<]*<\/p>)?<\/li>/g)).toHaveLength(4);
    const python = await html('python-sdk');
    expect(python).toContain(
      '<li class="spr-card"><p class="spr-card-title">Async</p>\n<p><code>AsyncFieldkit</code>',
    );
  });

  it('draws Code as a fence, its template literal spread over lines', async () => {
    expect(await html('configuration')).toMatch(
      /<pre><code class="language-toml"><span[^>]*>\[profiles\.ci\]<\/span>\n[\s\S]*?120/,
    );
  });

  it('draws a badge in a table cell and beside a heading, out of the heading id', async () => {
    const regions = await html('regions');
    expect(regions).toContain('<span class="spr-chip spr-chip-caution">Preview</span></td>');
    expect(regions).toContain(
      '<h2 id="moving-a-workspace">Moving a Workspace <span class="spr-chip spr-chip-danger">Not supported</span></h2>',
    );
  });

  it("titles an Aside with its own title, at its type's level", async () => {
    expect(await html('api-keys')).toContain(
      '<div class="spr-callout spr-callout-danger"><p class="spr-callout-label">A leaked key</p>',
    );
  });

  it('draws a link button, and nothing for an icon', async () => {
    expect(await html('getting-started')).toMatch(
      /<p><a class="spr-link-button" href="[^"]*">Read the CLI reference<\/a><\/p>/,
    );
    expect(await html('limits')).toContain('<p> Enterprise quotas are set per contract');
  });

  it('draws a task list as boxes, ticked by state, with no form control', async () => {
    const page = await html('offline-sync');
    expect(page.match(/<li class="spr-task spr-task-done">/g)).toHaveLength(1);
    expect(page.match(/<li class="spr-task">/g)).toHaveLength(3);
    expect(page).not.toContain('<input');
  });

  it('links a footnote in a table cell to its note, which no longer reports a broken link', async () => {
    const regions = await html('regions');
    expect(regions).toContain(
      'Ohio<sup class="spr-footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup>',
    );
    expect(regions).toMatch(
      /<section class="spr-footnotes">\n<ol>\n<li id="fn-1"><p>Preview workspaces/,
    );
    const [run] = await rows<{ findings: { code: string; source: string }[] }>(
      `SELECT findings FROM sync_runs WHERE repo_id = :repoId ORDER BY started_at DESC LIMIT 1`,
    );
    expect(
      run.findings.filter((f) => f.source === 'docs/regions.mdx' && f.code === 'broken-link'),
    ).toEqual([]);
  });

  it('keeps a generic type in prose as text', async () => {
    expect(await html('typescript-sdk/device')).toContain('as a Promise&lt;Device&gt;.');
  });

  it('reports exactly what it could not draw: one component and one expression', async () => {
    const [run] = await rows<{ findings: { code: string; source: string; severity: string }[] }>(
      `SELECT findings FROM sync_runs WHERE repo_id = :repoId ORDER BY started_at DESC LIMIT 1`,
    );
    const mdx = run.findings
      .filter((f) => f.code.startsWith('mdx-'))
      .map((f) => `${f.severity} ${f.code} ${f.source}`);
    expect(mdx.sort()).toEqual([
      'warn mdx-component docs/index.mdx',
      'warn mdx-expression docs/device-management.mdx',
    ]);
  });
});

describe('the third repo obeys the same isolation rules', () => {
  it('is readable by engineering and nobody else in the fixture', async () => {
    expect((await as('alice').get('/fieldkit/device-management')).status).toBe(200);
    for (const who of ['bob', 'carol', 'ops', 'anonymous'] as const) {
      expect((await as(who).get('/fieldkit/device-management')).status).toBe(404);
    }
  });

  it('appears at the site root only for a reader who can see it', async () => {
    expect((await as('alice').get('/')).text).toContain('Fieldkit Documentation');
    expect((await as('bob').get('/')).text).not.toContain('Fieldkit Documentation');
  });

  it("keeps its search results out of another reader's results", async () => {
    const alice = await as('alice').get('/?q=device');
    expect(alice.text).toContain('/fieldkit/');
    const bob = await as('bob').get('/?q=device');
    expect(bob.text).not.toContain('/fieldkit/');
  });

  it('shares the default namespace with the handbook without colliding', async () => {
    expect((await as('alice').get('/handbook/introduction')).status).toBe(200);
    expect((await as('alice').get('/fieldkit/device-management')).status).toBe(200);
  });
});

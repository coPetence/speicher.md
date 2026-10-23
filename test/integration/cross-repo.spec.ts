import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';

import { QueryTypes } from 'sequelize';
import request from 'supertest';

import { Forge, Repo } from '../../src/db/models';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { Finding } from '../../src/ingest/findings';
import {
  FIXTURE_ROOT,
  FIXTURE_SHA,
  Harness,
  PrincipalName,
  createHarness,
} from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

let app: INestApplication;
let harness: Harness;
let azureId: string;
let devToolsId: string;
let azureFindings: Finding[];
const cookies: Partial<Record<PrincipalName, string>> = {};

const VAULTS = '/kb-azure/';
const DOTENVX = '/kb-dev-tools/dotenvx';
const TOLERANCES = '/northwind-engineering/specs/tolerances';
const DOTENVX_BLURB = 'Encrypting and decrypting env files with dotenvx.';

beforeAll(async () => {
  harness = await createHarness();

  const forge = await Forge.findOne({ where: { key: 'gh' } });
  const register = async (slug: string, forgeRepoId: string) =>
    (
      await Repo.create({
        tenant_id: harness.tenantId,
        forge_id: forge!.id,
        forge_repo_id: forgeRepoId,
        namespace: 'copetence',
        namespace_id: '9001',
        slug,
        branch: 'main',
      })
    ).id;

  azureId = await register('kb-azure', '41775340');
  devToolsId = await register('kb-dev-tools', '41775341');

  for (const [id, dir] of [
    [azureId, 'kb-azure'],
    [devToolsId, 'kb-dev-tools'],
  ] as const) {
    const result = await harness.ingest.syncRepo(id, {
      workingTree: join(FIXTURE_ROOT, 'repos', dir),
      sha: FIXTURE_SHA,
      trigger: 'manual',
      now: new Date('2026-08-21T12:00:00Z'),
    });
    if (result.status !== 'ok') throw new Error(`${dir} failed to ingest`);
    if (dir === 'kb-azure') azureFindings = result.findings;
  }

  app = await bootTestApp();
  for (const name of ['alice', 'bob', 'carol', 'ops', 'mallory'] as PrincipalName[]) {
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

function group(html: string, heading: string): string[] {
  const aside = /<aside class="spr-aside"[\s\S]*?<\/aside>/.exec(html)?.[0] ?? '';
  const section = new RegExp(
    `<h2 class="spr-aside-heading">${heading}</h2>\\s*<ul class="spr-aside-list">([\\s\\S]*?)</ul>`,
  ).exec(aside);
  return section ? [...section[1].matchAll(/<span>([^<]*)<\/span>/g)].map((m) => m[1]) : [];
}

function hrefs(html: string): string[] {
  const main = /<main[\s\S]*?<\/main>/.exec(html)?.[0] ?? html;
  return [...main.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
}

function findingsOf(code: string): Finding[] {
  return azureFindings.filter((f) => f.code === code);
}

describe('a cross-repository target becomes the other repository’s URL', () => {
  it('resolves the namespace-less address against the default namespace', async () => {
    const { text } = await as('alice').get(VAULTS).expect(200);
    expect(hrefs(text)).toContain(DOTENVX);
    await as('alice').get(DOTENVX).expect(200);
  });

  it('writes a namespace out when it is not the default one', async () => {
    const { text } = await as('alice').get(VAULTS).expect(200);
    expect(hrefs(text)).toContain(TOLERANCES);
  });

  it('refuses an address this instance cannot read, and does not link it', async () => {
    const { text } = await as('alice').get(VAULTS).expect(200);
    expect(text).toContain('data-broken="true"');
    expect(hrefs(text)).not.toContain('/not/a/valid/address/here');
    expect(findingsOf('cross-repo-unresolved')).toHaveLength(1);
    expect(findingsOf('cross-repo-unresolved')[0].message).toContain('@slug:path');
    expect(findingsOf('broken-link')).toEqual([]);
  });

  it('stores the edge against the target’s repo id, not the source’s', async () => {
    const rows = await getSequelize().query<{ target_repo_id: string; target_slug_path: string }>(
      `SELECT target_repo_id, target_slug_path FROM document_edges
        WHERE repo_id = :azureId AND target_repo_id <> :azureId
        ORDER BY target_slug_path`,
      { type: QueryTypes.SELECT, replacements: { azureId } },
    );
    expect(rows).toEqual([
      { target_repo_id: devToolsId, target_slug_path: 'dotenvx' },
      { target_repo_id: harness.repos.specs, target_slug_path: 'tolerances' },
    ]);
  });

  it('writes no edge for an address that names the page it is on', async () => {
    const { text } = await as('alice').get(VAULTS).expect(200);
    expect(text).toContain('>these vaults</a>');
    expect(group(text, 'See also')).not.toContain('Shared env secret key vaults');

    const [{ c }] = await getSequelize().query<{ c: string }>(
      `SELECT count(*)::text AS c FROM document_edges
        WHERE repo_id = :azureId AND target_repo_id = :azureId
          AND source_slug_path = target_slug_path`,
      { type: QueryTypes.SELECT, replacements: { azureId } },
    );
    expect(Number(c)).toBe(0);
  });
});

describe('an edge is exactly as visible as both pages it joins', () => {
  it('lists the cross-repo page for a reader who holds both ends', async () => {
    const { text } = await as('alice').get(VAULTS).expect(200);
    expect(group(text, 'See also')).toContain('dotenvx');
    expect(text).toContain(`data-spr-preview="${DOTENVX_BLURB}`);
  });

  it('gives the reader of one end the link text and nothing else', async () => {
    const { text } = await as('bob').get(VAULTS).expect(200);

    expect(text).toContain('the dotenvx tool');
    expect(hrefs(text)).toContain(DOTENVX);

    expect(group(text, 'See also')).toEqual(['Using a key vault', 'Key vault reference']);
    expect(group(text, 'See also')).not.toContain('dotenvx');
    expect(text).not.toContain(DOTENVX_BLURB);
    expect(text).not.toMatch(/\b1 more\b/);

    const marked = /<a [^>]*href="\/kb-dev-tools\/dotenvx"[^>]*>/.exec(text)?.[0] ?? '';
    expect(marked).not.toContain('data-broken');
    expect(marked).not.toContain('data-spr-preview');

    await as('bob').get(DOTENVX).expect(404);
  });

  it('shows the backlink across repositories, to the readers of both ends', async () => {
    const mine = await as('alice').get(DOTENVX).expect(200);
    expect(group(mine.text, 'Referenced by')).toContain('Shared env secret key vaults');
  });

  it('shows no backlink to a reader who cannot read the linking repository', async () => {
    await as('carol').get(DOTENVX).expect(404);

    const northwind = await as('carol').get(TOLERANCES).expect(200);
    expect(group(northwind.text, 'Referenced by')).toEqual([]);
    await as('alice').get(TOLERANCES).expect(404);
  });

  it('withholds the whole repository from a principal granted nothing', async () => {
    for (const who of ['ops', 'mallory', 'anonymous'] as const) {
      await as(who).get(VAULTS).expect(404);
      await as(who).get(DOTENVX).expect(404);
    }
  });
});

describe('wikilinks', () => {
  it('resolves a bare name, a path, a relative path and an anchor', async () => {
    const { text } = await as('alice').get(VAULTS).expect(200);
    const found = hrefs(text);
    expect(found).toContain('/kb-azure/guides/vault');
    expect(found).toContain('/kb-azure/reference/vault');
    expect(found).toContain('/kb-azure/guides/vault#rotation');
  });

  it("renders the alias as the link text and the linked page's title when there is none", async () => {
    const { text } = await as('alice').get(VAULTS).expect(200);
    expect(text).toContain('>rotating a key</a>');
    expect(text).toContain('>the reference</a>');
    expect(text).toContain('>Using a key vault</a>');
    expect(text).not.toContain('>guides/vault</a>');
  });

  it('says nothing in the HTML about which syntax a link was written in', async () => {
    const { text } = await as('alice').get(VAULTS).expect(200);
    expect(text).not.toContain('data-spr-wikilink');
  });

  it('embeds a file and reports an embedded page as a link', async () => {
    const { text } = await as('alice').get(VAULTS).expect(200);
    expect(text).toMatch(/<img [^>]*src="\/kb-azure\/images\/diagram\.png"/);
    expect(findingsOf('wikilink-embed')).toHaveLength(1);
  });

  it('reports an ambiguous name and resolves it the same way every sync', async () => {
    const ambiguous = findingsOf('ambiguous-wikilink');
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].message).toContain('docs/guides/vault.md');
    expect(ambiguous[0].adminMessage).toContain('docs/reference/vault.md');
  });

  it('serves an agent the same destinations it serves a reader', async () => {
    const [row] = await getSequelize().query<{ markdown: string }>(
      `SELECT markdown FROM documents WHERE repo_id = :azureId AND slug_path = ''`,
      { type: QueryTypes.SELECT, replacements: { azureId } },
    );
    expect(row.markdown).not.toContain('[[');
    expect(row.markdown).toContain('](/kb-dev-tools/dotenvx)');
    expect(row.markdown).toContain('](/northwind-engineering/specs/tolerances)');
  });
});

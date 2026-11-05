import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { QueryTypes } from 'sequelize';

import { DEFAULT_TEMPLATE, stylesheetUrl } from '../../src/content-reader/assets.controller';
import { emptyStateArt } from '../../src/content-reader/empty-state';
import { forgeMark } from '../../src/dashboard/configurator/config-form/members';
import { renderInlineMark } from '../../src/dashboard/ui/provider-marks';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { Harness, PrincipalName, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

let app: INestApplication;
let harness: Harness;
// The seeded failed run on handbook, and the address of its own page
let runId: string;
let runPath: string;
const cookies: Partial<Record<PrincipalName, string>> = {};

const GENERIC = 'A configuration file in this repository was rejected.';
const ADMIN_DETAIL =
  'commercial/.speicher.yaml grants <b>group:finance</b>, which no longer exists';

beforeAll(async () => {
  harness = await createHarness();
  app = await bootTestApp();
  for (const who of ['ops', 'alice', 'bob'] as const) {
    cookies[who] = await sessionCookieFor(harness.tenantId, who);
  }

  const [seeded] = await getSequelize().query<{ id: string }>(
    `INSERT INTO sync_runs
       (tenant_id, repo_id, sha, trigger, started_at, finished_at, status, stats, findings)
     VALUES (:tenantId, :repoId, :sha, 'webhook',
             now() - interval '2 minutes', now() - interval '119 seconds', 'failed',
             :stats::jsonb, :findings::jsonb)
     RETURNING id`,
    {
      type: QueryTypes.SELECT,
      replacements: {
        tenantId: harness.tenantId,
        repoId: harness.repos.handbook,
        sha: 'f'.repeat(40),
        stats: JSON.stringify({
          documents: 4,
          assets: 1,
          dropped_grants: 1,
          failed_subtrees: ['commercial'],
        }),
        findings: JSON.stringify([
          {
            severity: 'reject',
            code: 'unknown-group',
            source: 'commercial/.speicher.yaml',
            line: 3,
            message: GENERIC,
            adminMessage: ADMIN_DETAIL,
          },
        ]),
      },
    },
  );
  runId = seeded.id;
  runPath = `/-/status/copetence/handbook/runs/${runId}`;
});

afterAll(async () => {
  await app?.close();
  await harness?.close();
  await closeSequelize();
});

function page(who: PrincipalName, path: string) {
  return request(app.getHttpServer())
    .get(path)
    .set('Cookie', cookies[who] as string)
    .set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
}

function json(who: PrincipalName, path: string) {
  return request(app.getHttpServer())
    .get(path)
    .set('Cookie', cookies[who] as string)
    .set('Accept', 'application/json');
}

describe('an admin', () => {
  it('gets a page, not a wall of JSON, from the link in the header', async () => {
    const res = await page('ops', '/-/status');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<h1>Sync status</h1>');
    expect(res.text).toContain('copetence/handbook');
    expect(res.text).toContain('northwind-engineering/specs');
  });

  it('is told what this instance is running as data, on no page at all', async () => {
    for (const where of ['/-/status', '/-/config']) {
      const drawn = await page('ops', where);
      expect(drawn.status).toBe(200);
      expect(drawn.text).not.toContain('Resolution hash');
      expect(drawn.text).not.toContain(harness.config.resolutionHash);
    }

    const payload = await json('ops', '/-/status');
    expect(payload.body.instance.resolution_hash).toBe(harness.config.resolutionHash);
  });

  // The reader's shell attribute reserves a related-column track beside the
  // article; a settings page carrying it would be laid out as one, which is what
  // moved every page under `/-/` the last time the reader's width was fixed.
  it('is never laid out as a reader article', async () => {
    for (const where of ['/-/status', '/-/config', '/-/config/groups', '/-/dead-jobs']) {
      const drawn = await page('ops', where);
      expect(drawn.status).toBe(200);
      expect(drawn.text).not.toContain('data-article');
      expect(drawn.text).not.toContain('spr-article');
    }
  });

  it('is still told, on the status page, what retrieval is running on', async () => {
    const res = await page('ops', '/-/status');
    // The page, not the column: the column names the settings page of that title.
    const main = res.text.slice(res.text.indexOf('<main'), res.text.indexOf('</main>'));
    expect(main).not.toContain('Semantic retrieval');
  });

  it('reaches the section list, including the dead jobs', async () => {
    const res = await page('ops', '/-/status');
    expect(res.text).toContain('href="/-/dead-jobs"');
    expect(res.text).toContain('href="/-/connections"');
    expect(res.text).toMatch(/href="\/-\/status" aria-current="page"/);
  });

  it('is not offered the disabled pages, and is answered 404 on each', async () => {
    const res = await page('ops', '/-/status');
    for (const path of ['/-/explain', '/-/graph', '/-/analytics']) {
      expect(res.text).not.toContain(`href="${path}"`);
      expect((await page('ops', path)).status).toBe(404);
      expect((await json('ops', path)).status).toBe(404);
    }
    expect((await page('ops', '/-/explain?path=/handbook/commercial/pricing')).status).toBe(404);
  });

  it('links the tiles that count what is acted on elsewhere to that page', async () => {
    const res = await page('ops', '/-/status');
    const tiles = res.text.slice(
      res.text.indexOf('<ul class="spr-stats">'),
      res.text.indexOf('</ul>', res.text.indexOf('<ul class="spr-stats">')),
    );
    expect(tiles).toMatch(
      /<a class="spr-stat-label spr-stat-link" href="\/-\/dead-jobs">Dead jobs<\/a>/,
    );
    expect(tiles).toMatch(/<span class="spr-stat-label">Repositories<\/span>/);
  });

  it('links Failed and Stale to the list showing only the repositories in that state', async () => {
    const res = await page('ops', '/-/status?sort=pages-desc');
    for (const [label, state] of [
      ['Failed', 'failed'],
      ['Stale', 'stale'],
    ]) {
      expect(res.text).toContain(
        `<a class="spr-stat-label spr-stat-link" href="/-/status?f=1&amp;state=${state}&amp;sort=pages-desc">${label}</a>`,
      );
    }

    const failed = await json('ops', '/-/status?f=1&state=failed');
    expect(failed.body.filter).toMatchObject({ state: ['failed'], owner: [], source: [] });
    expect(failed.body.repos.every((repo: { state: string }) => repo.state === 'failed')).toBe(
      true,
    );
  });

  it('says nothing about dropped grants, which the run pages report', async () => {
    const res = await page('ops', '/-/status');
    expect(res.text).not.toContain('Dropped grants');
    expect((await json('ops', '/-/status')).body.totals).not.toHaveProperty('dropped_grants');
  });

  it("opens a run's findings under its row from the count, which leads to them on the run's page without the island", async () => {
    const res = await page('ops', '/-/status/copetence/handbook');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`href="${runPath}"`);
    expect(res.text).toMatch(/<th scope="col" class="spr-num">Findings<\/th>/);
    // The count carries the mark of the run's worst finding, the word as its name
    const toggle = new RegExp(
      `<a class="spr-run-findings spr-run-findings-toggle" href="${runPath}#findings" aria-expanded="false" aria-controls="(run-findings-\\d+)" data-spr-findings-toggle>\\s*<span\\s+class="spr-badge spr-badge-fail spr-badge-icon"\\s+title="reject"\\s*><svg[\\s\\S]*?<span class="spr-clipped">reject</span></span>\\s*1\\s*<svg`,
    ).exec(res.text);
    expect(toggle).not.toBeNull();
    // The findings themselves, folded under the row until the count is pressed
    expect(res.text).toMatch(
      new RegExp(
        `<tr class="spr-run-findings-row" id="${toggle?.[1]}" hidden>[\\s\\S]*?unknown-group[\\s\\S]*?</tr>`,
      ),
    );
  });

  it('sees the detailed half of a finding on the run page', async () => {
    const res = await page('ops', runPath);
    expect(res.status).toBe(200);
    expect(res.text).toContain('unknown-group');
    expect(res.text).toContain('commercial/.speicher.yaml:3');
    expect(res.text).toContain('f'.repeat(40));
    // The severity is a mark, and the word stays as the badge's accessible name
    expect(res.text).toMatch(
      /<span\s+class="spr-badge spr-badge-fail spr-badge-icon"\s+title="reject"\s*><svg[\s\S]*?<\/svg><span class="spr-clipped">reject<\/span><\/span>/,
    );
    expect(res.text).toContain('href="/-/status/copetence/handbook"');
  });

  it('is answered the same run in JSON', async () => {
    const res = await json('ops', runPath);
    expect(res.status).toBe(200);
    expect(res.body.run.id).toBe(runId);
    expect(res.body.run.findings[0].adminMessage).toBe(ADMIN_DETAIL);
  });

  it('is not found a run through another repository, or a run that is not one', async () => {
    // The repository is in the predicate, so a real id under the wrong name is no run
    expect((await page('ops', `/-/status/northwind-engineering/specs/runs/${runId}`)).status).toBe(
      404,
    );
    expect((await page('ops', '/-/status/copetence/handbook/runs/not-a-uuid')).status).toBe(404);
    expect(
      (await page('ops', '/-/status/copetence/handbook/runs/00000000-0000-4000-8000-000000000000'))
        .status,
    ).toBe(404);
  });

  it('is told what the repository configured, as facts and never as the file', async () => {
    const res = await page('ops', '/-/status/copetence/handbook');
    // The panel is the definition list, not a heading: it sits under the
    // repository's own name, and a second title saying `Repository configuration`
    // would be the page announcing itself twice.
    expect(res.text).toContain('<dl class="spr-defs">');
    expect(res.text).toContain('Read access');
    expect(res.text).toContain('group:engineering');
    expect(res.text).toContain('coPetence Handbook');
    expect(res.text).toContain('user:entra:dave-oid');
    // Resolved values, never the document's own keys
    expect(res.text).not.toContain('ingest_root:');
    expect(res.text).not.toContain('external reviewer, contract 2026-04');
  });

  it('escapes it, because a finding names paths that came from a repository', async () => {
    const res = await page('ops', runPath);
    expect(res.text).toContain('&lt;b&gt;group:finance&lt;/b&gt;');
    expect(res.text).not.toContain('<b>group:finance</b>');
  });
});

describe('the repository list', () => {
  it('narrows to what was typed, and counts the instance anyway', async () => {
    const res = await page('ops', '/-/status?q=handbook');
    expect(res.status).toBe(200);
    expect(res.text).toContain('copetence/handbook');
    expect(res.text).not.toContain('northwind-engineering/specs');
    const unfiltered = await json('ops', '/-/status');
    const filtered = await json('ops', '/-/status?q=handbook');
    expect(filtered.body.repos).toHaveLength(1);
    expect(filtered.body.totals).toEqual(unfiltered.body.totals);
    expect(filtered.body.query).toBe('handbook');
  });

  it('matches the source that holds a repository, not only its name', async () => {
    const res = await json('ops', '/-/status?q=gh');
    expect(res.body.repos.length).toBe(res.body.totals.repositories);
    expect(res.body.repos.length).toBeGreaterThan(1);
  });

  it('says a filter matched nothing differently from having nothing', async () => {
    const res = await page('ops', '/-/status?q=nosuchrepository');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/data-spr-empty="filtered"\s*>/);
    expect(res.text).toMatch(/data-spr-empty="none"\s*hidden>/);
    expect(res.text).toContain('No repository matches');
    expect(res.text).toContain('href="/-/status"');
    expect(res.text).toContain('value="nosuchrepository"');

    const all = await page('ops', '/-/status');
    expect(all.text).toMatch(/data-spr-empty="filtered"\s*hidden>/);
    expect(all.text).toMatch(/data-spr-empty="none"\s*hidden>/);
  });

  it('draws a funnel when the filter leaves nothing, and says how many it holds back', async () => {
    const { body } = await json('ops', '/-/status?f=1');
    const res = await page('ops', '/-/status?f=1&owner=nobody&sort=pages-desc');
    expect(res.text).toMatch(/data-spr-empty="none"\s*>/);
    expect(res.text).toContain(emptyStateArt('filtered'));
    expect(res.text).toContain(
      `Repositories without the filter: ${body.totals.repositories as number}.`,
    );
    expect(res.text).toContain('<a href="/-/status?f=1&amp;sort=pages-desc">Clear the filter</a>');
  });

  it('puts a red half beside the funnel while a filter is applied, which takes it off', async () => {
    const filtered = await page('ops', '/-/status?f=1&owner=nobody');
    expect(filtered.text).toMatch(
      /<\/details>\s*<a class="spr-filter-remove" href="\/-\/status\?f=1" aria-label="Clear the filter"/,
    );
    const unfiltered = await page('ops', '/-/status?f=1');
    expect(unfiltered.text).not.toContain('spr-filter-remove');
  });

  it('escapes the needle, which is text somebody typed', async () => {
    const res = await page('ops', '/-/status?q=%3Cb%3Eoops%3C%2Fb%3E');
    expect(res.text).not.toContain('<b>oops</b>');
    expect(res.text).toContain('&lt;b&gt;oops&lt;/b&gt;');
  });

  it('marks each row with the kind of source behind it, once per page', async () => {
    const res = await page('ops', '/-/status');
    expect(res.text).toContain('href="#m-github"');
    expect(res.text.match(/<symbol id="m-github"/g)).toHaveLength(1);
  });

  it('starts with the heading, so the page begins at the same height with or without rows', async () => {
    const res = await page('ops', '/-/status');
    expect(res.text).toContain('<symbol id="m-github"');
    expect(res.text).toMatch(/<main[^>]*>\s*<h1>Sync status<\/h1>/);
  });

  it('offers Sync all on an instance whose table is empty, in the accent', async () => {
    const res = await page('ops', '/-/status?q=nosuchrepository');
    expect(res.text).toMatch(
      /action="\/-\/discover"[^>]*>\s*<button type="submit" class="spr-primary"><svg[^>]*>[\s\S]*?<\/svg>Sync all<\/button>/,
    );
  });

  describe('a repository whose first sync failed', () => {
    const setFirstSync = (failed: boolean) =>
      getSequelize().query(
        `UPDATE repos SET has_config = :hasConfig, last_status = :status, last_run_at = now()
          WHERE id = :repoId`,
        {
          replacements: {
            hasConfig: !failed,
            status: failed ? 'failed' : 'ok',
            repoId: harness.repos.fieldkit,
          },
        },
      );

    beforeAll(() => setFirstSync(true));
    afterAll(() => setFirstSync(false));

    it('is shown as failed by default, not hidden as not published', async () => {
      const res = await json('ops', '/-/status');
      const fieldkit = res.body.repos.find((repo: { slug: string }) => repo.slug === 'fieldkit');
      expect(fieldkit).toMatchObject({ state: 'failed' });
    });

    it('is listed under the filter the Failed tile links to', async () => {
      const res = await json('ops', '/-/status?f=1&state=failed');
      expect(res.body.repos.map((repo: { slug: string }) => repo.slug)).toContain('fieldkit');
    });
  });

  describe('the filter, with a repository that has no .speicher.yaml', () => {
    const setConfig = (hasConfig: boolean) =>
      getSequelize().query(
        `UPDATE repos SET has_config = :hasConfig, last_run_at = now() - interval '2 days'
          WHERE id = :repoId`,
        { replacements: { hasConfig, repoId: harness.repos.fieldkit } },
      );

    beforeAll(() => setConfig(false));
    afterAll(() => setConfig(true));

    const slugs = (body: { repos: { slug: string }[] }) => body.repos.map((repo) => repo.slug);

    const DEFAULT_STATES = ['ok', 'failed', 'stale', 'never-synced'];

    it('leaves it out by default, and counts it among the states', async () => {
      const res = await json('ops', '/-/status');
      expect(slugs(res.body)).not.toContain('fieldkit');
      expect(slugs(res.body)).toContain('handbook');
      expect(res.body.filter).toEqual({ state: DEFAULT_STATES, owner: [], source: [], pages: [] });
      expect(res.body.facets.state).toContainEqual({ value: 'unpublished', count: 1 });
      expect(res.body.totals.repositories).toBe(slugs(res.body).length + 1);
    });

    it('narrows to the states asked for, and shows it as not published rather than stale', async () => {
      const res = await json('ops', '/-/status?state=unpublished');
      expect(slugs(res.body)).toEqual(['fieldkit']);
      expect(res.body.repos[0]).toMatchObject({ state: 'unpublished', stale: false });

      const html = await page('ops', '/-/status?state=unpublished');
      expect(html.text).toMatch(/name="state" value="unpublished" checked/);
      expect(html.text).toMatch(/name="state" value="ok">/);
      expect(html.text).toContain('not published');
    });

    it('needs one value of each dimension, and every dimension it narrows', async () => {
      const all = await json('ops', '/-/status?f=1');
      const owners = all.body.facets.owner.map((option: { value: string }) => option.value);
      expect(owners.length).toBeGreaterThan(1);

      const one = await json('ops', `/-/status?owner=${owners[0]}`);
      expect(one.body.repos.length).toBeGreaterThan(0);
      expect(
        one.body.repos.every((repo: { namespace: string }) => repo.namespace === owners[0]),
      ).toBe(true);

      const none = await json('ops', `/-/status?owner=${owners[0]}&pages=100%2B`);
      expect(
        none.body.repos.every(
          (repo: { namespace: string; documents: number }) =>
            repo.namespace === owners[0] && repo.documents >= 100,
        ),
      ).toBe(true);
    });

    it('shows everything for an applied filter with nothing ticked', async () => {
      const res = await json('ops', '/-/status?f=1');
      expect(slugs(res.body)).toContain('fieldkit');
      expect(res.body.repos).toHaveLength(res.body.totals.repositories);
    });

    it('marks the filter button active while it narrows the list, the default included', async () => {
      const narrowed = await page('ops', '/-/status');
      expect(narrowed.text).toMatch(/class="spr-modal spr-filter-modal" data-spr-active/);

      const all = await page('ops', '/-/status?f=1');
      expect(all.text).not.toContain('data-spr-active');
    });

    it('ignores a value it does not know', async () => {
      const res = await json('ops', '/-/status?state=sideways&pages=lots');
      expect(res.body.filter.state).toEqual([]);
      expect(res.body.filter.pages).toEqual([]);
    });

    it('remembers an applied filter, and uses it when the address names none', async () => {
      const applied = await json('ops', '/-/status?f=1&state=unpublished');
      const setCookie = [applied.headers['set-cookie'] ?? []].flat().join(';');
      const remembered = /speicher_status_filter=[^;]+/.exec(setCookie)?.[0];
      expect(remembered).toBeDefined();

      const later = await request(app.getHttpServer())
        .get('/-/status')
        .set('Cookie', `${cookies.ops}; ${remembered}`)
        .set('Accept', 'application/json');
      expect(later.body.filter.state).toEqual(['unpublished']);
      expect(slugs(later.body)).toEqual(['fieldkit']);
    });

    it('keeps the filter when the text filter is cleared, since the address names none', async () => {
      const res = await page('ops', '/-/status?q=nosuchrepository&state=unpublished');
      expect(res.text).toContain('href="/-/status"');
    });
  });

  describe('the order', () => {
    const pages = (body: { repos: { documents: number }[] }) =>
      body.repos.map((repo) => repo.documents);

    it('is by owner and name until a header asks otherwise', async () => {
      const res = await json('ops', '/-/status?f=1');
      expect(res.body.sort).toBe('name');
      const names = res.body.repos.map(
        (repo: { namespace: string; slug: string }) => `${repo.namespace}/${repo.slug}`,
      );
      expect(names).toEqual([...names].sort());
    });

    it('puts the most pages first, or the fewest', async () => {
      const most = pages((await json('ops', '/-/status?f=1&sort=pages-desc')).body);
      expect(new Set(most).size).toBeGreaterThan(1);
      expect(most).toEqual([...most].sort((a, b) => b - a));

      const fewest = pages((await json('ops', '/-/status?f=1&sort=pages-asc')).body);
      expect(fewest).toEqual([...fewest].sort((a, b) => a - b));
    });

    it('falls back to the name for an order it does not know', async () => {
      expect((await json('ops', '/-/status?sort=sideways')).body.sort).toBe('name');
    });

    it('turns the Pages header around, and keeps the filter and the needle in its link', async () => {
      const first = await page('ops', '/-/status?state=ok&q=hand');
      expect(first.text).toContain(
        'href="/-/status?f=1&amp;state=ok&amp;q=hand&amp;sort=pages-desc"',
      );

      const sorted = await page('ops', '/-/status?state=ok&sort=pages-desc');
      expect(sorted.text).toContain('href="/-/status?f=1&amp;state=ok&amp;sort=pages-asc"');
      expect(sorted.text).toMatch(/aria-sort="descending"/);
      expect(sorted.text).toContain('name="sort" value="pages-desc"');
    });
  });
});

describe('what the worker is doing', () => {
  const insertJob = (
    kind: string,
    payload: Record<string, string>,
    status: 'running' | 'pending',
    runAfter = "now() - interval '1 second'",
  ) =>
    getSequelize().query(
      `INSERT INTO jobs (tenant_id, kind, payload, status, run_after, locked_until)
       VALUES (:tenantId, :kind, :payload::jsonb, :status, ${runAfter},
               CASE WHEN :status = 'running' THEN now() + interval '5 minutes' END)`,
      {
        replacements: {
          tenantId: harness.tenantId,
          kind,
          payload: JSON.stringify(payload),
          status,
        },
      },
    );

  beforeAll(async () => {
    await insertJob('sync-repo-content', { repoId: harness.repos.handbook }, 'running');
    await insertJob('sync-repo-content', { repoId: harness.repos.specs }, 'pending');
    await insertJob('sync-repo-list', { forgeKey: 'gh' }, 'pending');
    // Scheduled for later, so nobody is waiting on it
    await insertJob('sync-repo-list', { forgeKey: 'gl' }, 'pending', "now() + interval '1 hour'");
  });

  afterAll(() => getSequelize().query(`DELETE FROM jobs WHERE status IN ('running', 'pending')`));

  it('counts the jobs running and due, and leaves the ones scheduled for later out', async () => {
    const res = await json('ops', '/-/status');

    expect(res.body.instance).toMatchObject({
      running_jobs: 1,
      queued_jobs: 2,
      discovering: ['gh'],
    });
  });

  it('marks each repository with what is happening to it', async () => {
    const res = await json('ops', '/-/status');
    const activity = Object.fromEntries(
      res.body.repos.map((repo: { slug: string; activity: string | null }) => [
        repo.slug,
        repo.activity,
      ]),
    );

    expect(activity).toMatchObject({ handbook: 'syncing', specs: 'queued' });
  });

  it('shows it on the page, and tells the island to look again soon', async () => {
    const res = await page('ops', '/-/status');

    expect(res.text).toContain('Running');
    expect(res.text).toContain('Queued');
    expect(res.text).toMatch(/class="spr-activity">[\s\S]*?syncing/);
    expect(res.text).toContain(
      'speicher.md is checking gh for new repositories, and syncs all existing repositories.',
    );
    expect(res.text).toContain('data-spr-activity data-spr-busy');
  });

  it('shows a maintainer their repository’s activity, but not the instance’s jobs', async () => {
    const res = await json('alice', '/-/status');

    expect(res.body.instance).toBeNull();
    expect(res.body.repos.some((repo: { activity: unknown }) => repo.activity !== null)).toBe(true);
  });
});

describe('a maintainer', () => {
  it('sees their own repository and no other', async () => {
    const res = await page('alice', '/-/status');
    expect(res.status).toBe(200);
    expect(res.text).toContain('copetence/handbook');
    expect(res.text).not.toContain('northwind-engineering/specs');
  });

  it('is shown exactly what their JSON carries, and nothing more', async () => {
    const asJson = await json('alice', '/-/status');
    const asPage = await page('alice', '/-/status');
    const linked = [...asPage.text.matchAll(/href="\/-\/status\/([^"]+)"/g)].map((m) => m[1]);
    expect(linked).toEqual(
      asJson.body.repos.map(
        (repo: { namespace: string; slug: string }) => `${repo.namespace}/${repo.slug}`,
      ),
    );
  });

  it('is not offered the dead jobs, or told anything about the instance', async () => {
    const res = await page('alice', '/-/status');
    expect(res.text).not.toContain('href="/-/dead-jobs"');
    expect(res.text).not.toContain('Resolution hash');
    expect(res.text).not.toContain(harness.config.resolutionHash);
    expect(res.text).not.toContain('Dead jobs');
    expect(res.text).toContain('Repositories');
    expect(res.text).not.toContain('href="/-/graph"');
  });

  it('never sees the admin half of a finding, in either representation', async () => {
    const asPage = await page('alice', '/-/status/copetence/handbook');
    expect(asPage.status).toBe(200);
    expect(asPage.text).not.toContain(ADMIN_DETAIL);
    expect(asPage.text).not.toContain(GENERIC);
    expect(asPage.text).not.toContain('unknown-group');

    const asJson = await json('alice', '/-/status/copetence/handbook');
    expect(
      asJson.body.runs.every((run: { findings: unknown[] }) => run.findings.length === 0),
    ).toBe(true);

    // Nor on the run's own page, which a maintainer may open
    const runPage = await page('alice', runPath);
    expect(runPage.status).toBe(200);
    expect(runPage.text).not.toContain(ADMIN_DETAIL);
    expect(runPage.text).not.toContain(GENERIC);
    expect(runPage.text).not.toContain('unknown-group');
    // Withheld is not "found nothing": no section that would claim a clean run
    expect(runPage.text).not.toContain('<h2>Findings</h2>');
    expect(runPage.text).not.toContain('This run found nothing');
    expect((await json('alice', runPath)).body.run.findings).toEqual([]);

    // And no column that would read as a run of clean runs
    expect(asPage.text).not.toMatch(/<th scope="col" class="spr-num">Findings<\/th>/);
  });

  it('cannot open a run of a repository they do not maintain', async () => {
    const [other] = await getSequelize().query<{ id: string }>(
      `INSERT INTO sync_runs (tenant_id, repo_id, trigger, status)
       VALUES (:tenantId, :repoId, 'manual', 'ok') RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId: harness.tenantId, repoId: harness.repos.specs },
      },
    );
    expect(
      (await page('alice', `/-/status/northwind-engineering/specs/runs/${other.id}`)).status,
    ).toBe(404);
    // Under the repository they do maintain it is still not theirs
    expect((await page('alice', `/-/status/copetence/handbook/runs/${other.id}`)).status).toBe(404);
  });

  it('sees the same configuration panel, carrying no admin-only half', async () => {
    const res = await page('alice', '/-/status/copetence/handbook');
    expect(res.text).toContain('<dl class="spr-defs">');
    expect(res.text).toContain('group:engineering');
    expect(res.text).toMatch(/Maintainers[\s\S]{0,200}group:engineering/);
    expect(res.text).not.toContain(ADMIN_DETAIL);
    expect(res.text).not.toContain('up to');
  });

  it('is shown exactly the configuration its JSON carries', async () => {
    const asJson = await json('alice', '/-/status/copetence/handbook');
    const asPage = await page('alice', '/-/status/copetence/handbook');
    expect(asJson.body.config.maintainer_principals).toEqual(['group:engineering']);
    for (const principal of asJson.body.config.root_principals) {
      expect(asPage.text).toContain(principal);
    }
  });

  it('cannot open the repository page of a repo they do not maintain', async () => {
    const res = await page('alice', '/-/status/northwind-engineering/specs');
    expect(res.status).toBe(404);
  });

  it('is offered Sync now in the head row, beside the source mark and the name', async () => {
    const asJson = await json('alice', '/-/status/copetence/handbook');
    const shown = await page('alice', '/-/status/copetence/handbook');
    // One row: the button belongs to the title, not to the first section under it
    const head = /<div class="spr-page-head">([\s\S]*?)<\/div>/.exec(shown.text)?.[1] ?? '';
    expect(head).toContain('copetence/handbook</h1>');
    expect(head).toContain('action="/-/sync"');
    expect(head).toMatch(
      /<button type="submit"><svg class="spr-icon"[^>]*>[\s\S]*?<\/svg>Sync now/,
    );

    // The mark is the payload's source kind, drawn whole rather than by reference
    const mark = forgeMark(asJson.body.forge_type);
    expect(mark).not.toBe('');
    expect(head).toContain(renderInlineMark(mark, 'spr-icon'));
  });

  describe('while a sync is in flight', () => {
    const syncJobs = (status: string) =>
      getSequelize().query(
        `UPDATE jobs SET status = :status
          WHERE kind = 'sync-repo-content' AND dedupe_key = :key AND status = 'pending'`,
        { replacements: { status, key: `sync-repo-content:${harness.repos.handbook}` } },
      );
    const button = (html: string) =>
      /<button type="submit"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? '';

    afterEach(() => syncJobs('done'));

    it('says so on the button until the job is done, and the JSON says the same', async () => {
      const res = await request(app.getHttpServer())
        .post('/-/sync')
        .set('Cookie', cookies.alice as string)
        .send({ namespace: 'copetence', slug: 'handbook' });
      // The page asks the queue, so the redirect carries no flag a reload would repeat
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe('/-/status/copetence/handbook');

      const busy = await page('alice', '/-/status/copetence/handbook');
      expect(button(busy.text)).toMatch(/disabled aria-busy="true"/);
      expect(button(busy.text)).toContain('Syncing…');
      expect(button(busy.text)).toContain('spr-spin');
      expect((await json('alice', '/-/status/copetence/handbook')).body.syncing).toBe(true);

      await syncJobs('done');
      const idle = await page('alice', '/-/status/copetence/handbook');
      expect(button(idle.text)).not.toContain('disabled');
      expect(button(idle.text)).toContain('Sync now');
      expect((await json('alice', '/-/status/copetence/handbook')).body.syncing).toBe(false);
    });

    it('answers for a sync somebody else started, as a webhook would', async () => {
      await getSequelize().query(
        `INSERT INTO jobs (tenant_id, kind, payload, dedupe_key, run_after)
         VALUES (:tenantId, 'sync-repo-content', CAST(:payload AS jsonb), :key, now() + interval '5 seconds')`,
        {
          replacements: {
            tenantId: harness.tenantId,
            payload: JSON.stringify({ repoId: harness.repos.handbook, trigger: 'webhook' }),
            key: `sync-repo-content:${harness.repos.handbook}`,
          },
        },
      );
      expect((await json('alice', '/-/status/copetence/handbook')).body.syncing).toBe(true);
    });

    it('does not count a retry waiting out its backoff, so Sync now can bring it forward', async () => {
      await getSequelize().query(
        `INSERT INTO jobs (tenant_id, kind, payload, dedupe_key, run_after, attempts)
         VALUES (:tenantId, 'sync-repo-content', CAST(:payload AS jsonb), :key, now() + interval '20 minutes', 3)`,
        {
          replacements: {
            tenantId: harness.tenantId,
            payload: JSON.stringify({ repoId: harness.repos.handbook, trigger: 'webhook' }),
            key: `sync-repo-content:${harness.repos.handbook}`,
          },
        },
      );
      expect((await json('alice', '/-/status/copetence/handbook')).body.syncing).toBe(false);
      const shown = await page('alice', '/-/status/copetence/handbook');
      expect(button(shown.text)).toContain('Sync now');
    });
  });

  it('may press Sync now and is answered in JSON', async () => {
    const res = await request(app.getHttpServer())
      .post('/-/sync')
      .set('Cookie', cookies.alice as string)
      .set('Accept', 'application/json')
      .send({ namespace: 'copetence', slug: 'handbook' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ syncing: 'copetence/handbook' });
    await getSequelize().query(`UPDATE jobs SET status = 'done' WHERE kind = 'sync-repo-content'`);
  });

  it('cannot sync a repository they do not maintain', async () => {
    const res = await request(app.getHttpServer())
      .post('/-/sync')
      .set('Cookie', cookies.alice as string)
      .send({ namespace: 'northwind-engineering', slug: 'specs' });
    expect(res.status).toBe(404);
  });

  it('is offered neither of the instance-wide operations', async () => {
    const shown = await page('alice', '/-/status');
    expect(shown.text).not.toContain('action="/-/discover"');
    await request(app.getHttpServer())
      .post('/-/discover')
      .set('Cookie', cookies.alice as string)
      .expect(404);
    await request(app.getHttpServer())
      .post('/-/jobs/retry')
      .set('Cookie', cookies.alice as string)
      .expect(404);
  });
});

// Path Access Check is disabled for now
describe.skip('explain, as a page', () => {
  it('is a form before it is an answer', async () => {
    const res = await page('ops', '/-/explain');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<form class="spr-form" method="get" action="/-/explain">');
  });

  it('answers about content the admin cannot read themselves', async () => {
    const res = await page('ops', '/-/explain?path=/handbook/commercial/pricing');
    expect(res.status).toBe(200);
    expect(res.text).toContain('group:commercial');
    expect(res.text).toContain('Group reach');
  });

  it('gives a maintainer the resolved set without the membership counts', async () => {
    const res = await page('alice', '/-/explain?path=/handbook/commercial/pricing');
    expect(res.status).toBe(200);
    expect(res.text).toContain('group:commercial');
    expect(res.text).not.toContain('Group reach');
  });

  it('keeps the path it was asked about, so the answer has a URL', async () => {
    const res = await page('ops', '/-/explain?path=/handbook/commercial/pricing');
    expect(res.text).toContain('value="/handbook/commercial/pricing"');
  });

  it('reflects nothing it has not escaped', async () => {
    const res = await page('ops', '/-/explain?path=/"><script>alert(1)</script>');
    expect(res.text).not.toContain('<script>alert(1)</script>');
  });
});

describe('the dead jobs page', () => {
  it('renders for an admin', async () => {
    const res = await page('ops', '/-/dead-jobs');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<h1>Dead jobs</h1>');
  });

  it('lists a dead job by its error, with Retry all beside the heading', async () => {
    const error = 'clone failed: Authentication failed for <the remote>';
    await getSequelize().query(
      `INSERT INTO jobs (tenant_id, kind, payload, status, attempts, last_error)
       VALUES (:tenantId, 'sync-repo-content', CAST(:payload AS jsonb), 'dead', 5, :error)`,
      {
        replacements: {
          tenantId: harness.tenantId,
          payload: JSON.stringify({ repoId: harness.repos.handbook, trigger: 'webhook' }),
          error,
        },
      },
    );
    try {
      const res = await page('ops', '/-/dead-jobs');
      // Under the introduction, before the table it acts on
      expect(res.text).toMatch(
        /<p class="spr-section-blurb">[\s\S]*?<\/p>\s*<form[^>]*>\s*<input type="hidden" name="page"[^>]*>\s*<div class="[^"]*spr-page-actions[^"]*">\s*<button type="submit" name="scope" value="all"[^>]*><svg class="spr-icon"[\s\S]*?<\/svg>Retry all 1/,
      );
      // A checkbox per row, and the buttons for what is ticked
      expect(res.text).toMatch(
        /<input type="checkbox" name="ids" value="[^"]+" aria-label="Select this sync-repo-content job">/,
      );
      expect(res.text).toMatch(
        /<button type="submit" name="scope" value="selected"[^>]*>[\s\S]*?Retry selected/,
      );
      expect(res.text).toMatch(
        /<button type="submit" name="scope" value="selected" formaction="\/-\/jobs\/delete"[^>]*>[\s\S]*?Delete selected/,
      );

      expect(res.text).toContain('<th scope="col">Job</th>');
      expect(res.text).toContain('<th scope="col">Repository</th>');
      expect(res.text).toContain('<th scope="col">Error</th>');
      expect(res.text).not.toContain('<th scope="col">Payload</th>');
      // Always the same number, so it has no column
      expect(res.text).not.toContain('<th scope="col" class="spr-num">Attempts</th>');
      // What a job of this kind does, behind an info mark beside its name
      expect(res.text).toMatch(
        /<button[^>]*class="spr-info-mark"[^>]*aria-label="About sync-repo-content"/,
      );
      expect(res.text).toMatch(/role="tooltip"[^>]*>[\s\S]*?Fetches the newest commit of one/);
      expect(res.text).toContain('href="/-/status/copetence/handbook"');
      // The error in its cell, escaped — it can quote a remote's own words
      expect(res.text).toContain(
        '<td class="spr-job-error">clone failed: Authentication failed for &lt;the remote&gt;</td>',
      );
      // The payload is the JSON's, not the page's
      expect(res.text).not.toContain('&quot;repoId&quot;');
      expect((await json('ops', '/-/dead-jobs')).body.dead_jobs[0].payload.repoId).toBe(
        harness.repos.handbook,
      );
      // Icons only, named for a screen reader
      expect(res.text).toMatch(
        /<button type="submit" name="id" value="[^"]+" aria-label="Retry" title="Retry"><svg/,
      );
      expect(res.text).toMatch(
        /<button type="submit" name="id" value="[^"]+" formaction="\/-\/jobs\/delete" class="spr-remove" aria-label="Delete" title="Delete"><svg/,
      );
    } finally {
      await getSequelize().query(`DELETE FROM jobs WHERE status = 'dead'`);
    }
  });

  it('says what a dead job is', async () => {
    const res = await page('ops', '/-/dead-jobs');
    expect(res.text).toMatch(/<p class="spr-section-blurb">[^<]*failed 5 times in a row/);
  });

  describe('with more dead jobs than one page holds', () => {
    beforeAll(() =>
      getSequelize().query(
        `INSERT INTO jobs (tenant_id, kind, payload, status, attempts, last_error, updated_at)
         SELECT :tenantId, 'notify', '{}'::jsonb, 'dead', 5, 'boom ' || n,
                now() - make_interval(secs => n)
           FROM generate_series(1, 55) AS n`,
        { replacements: { tenantId: harness.tenantId } },
      ),
    );
    afterAll(() => getSequelize().query(`DELETE FROM jobs WHERE status = 'dead'`));

    it('shows fifty, newest first, and the rest on the next page', async () => {
      const first = await json('ops', '/-/dead-jobs');
      expect(first.body).toMatchObject({ total: 55, page: 1, pages: 2, per_page: 50 });
      expect(first.body.dead_jobs).toHaveLength(50);
      expect(first.body.dead_jobs[0].last_error).toBe('boom 1');

      const second = await json('ops', '/-/dead-jobs?page=2');
      expect(second.body.dead_jobs).toHaveLength(5);
      expect(second.body.dead_jobs[4].last_error).toBe('boom 55');
    });

    it('counts every page in Retry all, and links the pages to each other', async () => {
      const res = await page('ops', '/-/dead-jobs');
      expect(res.text).toMatch(/Retry all 55/);
      expect(res.text).toContain('1–50 of 55');
      expect(res.text).toContain('href="/-/dead-jobs?page=2" rel="next"');

      const second = await page('ops', '/-/dead-jobs?page=2');
      expect(second.text).toContain('51–55 of 55');
      expect(second.text).toContain('href="/-/dead-jobs" rel="prev"');
    });

    it('shows the last page for a page past it', async () => {
      expect((await json('ops', '/-/dead-jobs?page=99')).body.page).toBe(2);
    });
  });

  it('deletes one dead job, and goes back to the page it was on', async () => {
    const [job] = await getSequelize().query<{ id: string }>(
      `INSERT INTO jobs (tenant_id, kind, payload, status, attempts, last_error)
       VALUES (:tenantId, 'embed', '{}'::jsonb, 'dead', 5, 'gone') RETURNING id`,
      { type: QueryTypes.SELECT, replacements: { tenantId: harness.tenantId } },
    );
    const res = await request(app.getHttpServer())
      .post('/-/jobs/delete')
      .set('Cookie', cookies.ops as string)
      .set('Accept', 'text/html')
      .type('form')
      .send({ id: job.id, page: '2' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/-/dead-jobs?deleted=1&page=2');

    const [left] = await getSequelize().query<{ count: string }>(
      `SELECT count(*) AS count FROM jobs WHERE id = :id`,
      { type: QueryTypes.SELECT, replacements: { id: job.id } },
    );
    expect(Number(left.count)).toBe(0);
    expect((await page('ops', '/-/dead-jobs?deleted=1')).text).toMatch(
      /<div class="spr-toast[^"]*">\s*<p class="spr-toast-text" role="status">1 job\(s\) deleted\.<\/p>/,
    );
  });

  describe('with jobs ticked', () => {
    let ids: string[] = [];
    beforeEach(async () => {
      const rows = await getSequelize().query<{ id: string }>(
        `INSERT INTO jobs (tenant_id, kind, payload, status, attempts, last_error)
         SELECT :tenantId, 'embed', '{}'::jsonb, 'dead', 5, 'boom ' || n FROM generate_series(1, 3) AS n
         RETURNING id`,
        { type: QueryTypes.SELECT, replacements: { tenantId: harness.tenantId } },
      );
      ids = rows.map((row) => row.id);
    });
    afterEach(() =>
      getSequelize().query(`DELETE FROM jobs WHERE id IN (:ids)`, { replacements: { ids } }),
    );

    const statusOf = async (id: string): Promise<string | undefined> => {
      const [row] = await getSequelize().query<{ status: string }>(
        `SELECT status FROM jobs WHERE id = :id`,
        { type: QueryTypes.SELECT, replacements: { id } },
      );
      return row?.status;
    };

    const post = (path: string, body: string) =>
      request(app.getHttpServer())
        .post(path)
        .set('Cookie', cookies.ops as string)
        .set('Accept', 'text/html')
        .type('form')
        .send(body);

    it('retries only the ticked ones', async () => {
      const res = await post('/-/jobs/retry', `scope=selected&ids=${ids[0]}&ids=${ids[1]}&page=1`);
      expect(res.headers.location).toBe('/-/dead-jobs?retried=2');
      expect([await statusOf(ids[0]), await statusOf(ids[1]), await statusOf(ids[2])]).toEqual([
        'pending',
        'pending',
        'dead',
      ]);
    });

    it('deletes only the ticked ones', async () => {
      const res = await post('/-/jobs/delete', `scope=selected&ids=${ids[0]}&ids=${ids[2]}&page=2`);
      expect(res.headers.location).toBe('/-/dead-jobs?deleted=2&page=2');
      expect([await statusOf(ids[0]), await statusOf(ids[1]), await statusOf(ids[2])]).toEqual([
        undefined,
        'dead',
        undefined,
      ]);
    });

    it('retries nothing for an empty selection, not everything', async () => {
      const res = await post('/-/jobs/retry', 'scope=selected');
      expect(res.headers.location).toBe('/-/dead-jobs?retried=0');
      expect(await statusOf(ids[0])).toBe('dead');
    });

    it('acts on the row whose button was pressed, whatever else is ticked', async () => {
      const res = await post('/-/jobs/delete', `id=${ids[1]}&ids=${ids[0]}&ids=${ids[2]}`);
      expect(res.headers.location).toBe('/-/dead-jobs?deleted=1');
      expect([await statusOf(ids[0]), await statusOf(ids[1]), await statusOf(ids[2])]).toEqual([
        'dead',
        undefined,
        'dead',
      ]);
    });

    it('retries all of them with Retry all, whatever is ticked', async () => {
      const res = await post('/-/jobs/retry', `scope=all&ids=${ids[0]}`);
      expect(res.headers.location).toBe('/-/dead-jobs?retried=3');
    });
  });

  it('deletes nothing that is not dead', async () => {
    const [job] = await getSequelize().query<{ id: string }>(
      `INSERT INTO jobs (tenant_id, kind, payload, status) VALUES (:tenantId, 'embed', '{}'::jsonb, 'pending')
       RETURNING id`,
      { type: QueryTypes.SELECT, replacements: { tenantId: harness.tenantId } },
    );
    try {
      const res = await request(app.getHttpServer())
        .post('/-/jobs/delete')
        .set('Cookie', cookies.ops as string)
        .set('Accept', 'application/json')
        .send({ id: job.id });
      expect(res.body).toEqual({ deleted: 0 });
    } finally {
      await getSequelize().query(`DELETE FROM jobs WHERE id = :id`, {
        replacements: { id: job.id },
      });
    }
  });

  it('refuses a delete from anyone but an admin', async () => {
    const res = await request(app.getHttpServer())
      .post('/-/jobs/delete')
      .set('Cookie', cookies.alice as string)
      .send({ id: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(404);
  });

  it('offers no Retry all when nothing is dead', async () => {
    const res = await page('ops', '/-/dead-jobs');
    expect(res.text).toContain('No job has been given up on.');
    expect(res.text).not.toContain('Retry all');
  });

  it('is where Retry leads back to, saying how many went back on the queue', async () => {
    const res = await request(app.getHttpServer())
      .post('/-/jobs/retry')
      .set('Cookie', cookies.ops as string)
      .set('Accept', 'text/html');
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/-/dead-jobs?retried=0');
  });

  it('is the reader 404 for anyone else, page or JSON', async () => {
    for (const res of [await page('alice', '/-/dead-jobs'), await json('alice', '/-/dead-jobs')]) {
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/text\/html/);
    }
  });
});

describe('the old address of the dead jobs', () => {
  it('sends an admin on to the dead jobs, and anyone else to the reader 404', async () => {
    const res = await page('ops', '/-/logs');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/-/dead-jobs');
    expect((await page('alice', '/-/logs')).status).toBe(404);
  });
});

describe('searching this surface', () => {
  it('puts the box over the column, on every page, for an administrator only', async () => {
    const nav = /<nav class="spr-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(
      (await page('ops', '/-/status')).text,
    )?.[1];
    expect(nav).toContain('action="/-/search"');
    expect(nav?.indexOf('action="/-/search"')).toBeLessThan(nav?.indexOf('spr-nav-root') as number);

    const maintainer = await page('alice', '/-/status');
    expect(maintainer.status).toBe(200);
    expect(maintainer.text).not.toContain('action="/-/search"');
  });

  it('answers with the control, not merely with the page it is on', async () => {
    const res = await page('ops', '/-/search?q=smtp%20host');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/-/config/mail#f-mail.host"');
  });

  it('finds a page by a word that appears nowhere on this surface', async () => {
    expect((await page('ops', '/-/search?q=sso')).text).toContain('href="/-/config/identity"');
  });

  it('holds the query in the box it was typed into, and draws no second one', async () => {
    const res = await page('ops', '/-/search?q=sso');
    expect(res.text.match(/action="\/-\/search"/g)).toHaveLength(1);
    expect(res.text).toContain('value="sso"');
  });

  it('is one answer in two representations, like everything else here', async () => {
    const asJson = await json('ops', '/-/search?q=smtp');
    expect(asJson.body.query).toBe('smtp');
    expect(asJson.body.hits.length).toBeGreaterThan(0);
    expect(asJson.body.settings_searchable).toBe(true);
    expect(JSON.stringify(asJson.body)).not.toContain('password:');
  });
});

describe('the representations', () => {
  it('serve JSON to a client that asks for it', async () => {
    const res = await json('ops', '/-/status');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.scope).toBe('admin');
  });

  it('tell a cache that the answer depends on what was asked for', async () => {
    for (const res of [await page('ops', '/-/status'), await json('ops', '/-/status')]) {
      expect(String(res.headers['vary'])).toMatch(/accept/i);
      expect(res.headers['cache-control']).toContain('no-store');
    }
  });

  it('default to the page, because a link in a mail is followed by a browser', async () => {
    const res = await request(app.getHttpServer())
      .get('/-/status')
      .set('Cookie', cookies.ops as string);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });
});

describe('the admin pages themselves', () => {
  it('carry the same security headers as the reader', async () => {
    const res = await page('ops', '/-/status');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(res.headers['cache-control']).toContain('private');
  });

  it('load one island: the page\u2019s own, or the column\u2019s slide where it has none', async () => {
    const connections = await page('ops', '/-/connections');
    const plain = [...connections.text.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)];
    expect(plain).toHaveLength(1);
    expect(plain[0][1]).toMatch(/\/fold-[0-9a-f]+\.js$/);

    const deadJobs = await page('ops', '/-/dead-jobs');
    const own = [...deadJobs.text.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)];
    expect(own).toHaveLength(1);
    expect(own[0][1]).toMatch(/\/dead-jobs-[0-9a-f]+\.js$/);

    const status = await page('ops', '/-/status');
    const islands = [...status.text.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(islands).toHaveLength(1);
    expect(islands[0]).toMatch(/\/status-[0-9a-f]+\.js$/);
    expect(status.text).toContain('class="spr-filter-go"');
  });

  it('take the base sheet, and add one a reader never downloads', async () => {
    const res = await page('ops', '/-/status');
    const sheets = [...res.text.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(sheets).toHaveLength(2);

    expect(sheets[0]).toBe(stylesheetUrl(DEFAULT_TEMPLATE));
    expect((await page('ops', '/-/dead-jobs')).text).toContain(sheets[0]);

    expect(sheets[1]).toMatch(/\/-\/static\/sheet-dashboard-[0-9a-f]+\.css/);
    const reader = await request(app.getHttpServer())
      .get('/')
      .set('Cookie', cookies.ops as string);
    expect(reader.text).not.toContain(sheets[1]);
  });
});

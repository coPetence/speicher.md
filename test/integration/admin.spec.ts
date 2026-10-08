import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { QueryTypes } from 'sequelize';

import { DEFAULT_TEMPLATE, stylesheetUrl } from '../../src/content-reader/assets.controller';
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
    for (const where of ['/-/status', '/-/config', '/-/config/groups', '/-/logs']) {
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

  it('reaches the section list, including the log', async () => {
    const res = await page('ops', '/-/status');
    expect(res.text).toContain('href="/-/logs"');
    expect(res.text).toContain('href="/-/explain"');
    expect(res.text).toMatch(/href="\/-\/status" aria-current="page"/);
  });

  it('links the tiles that count what is acted on elsewhere to that page', async () => {
    const res = await page('ops', '/-/status');
    const tiles = res.text.slice(
      res.text.indexOf('<ul class="spr-stats">'),
      res.text.indexOf('</ul>', res.text.indexOf('<ul class="spr-stats">')),
    );
    expect(tiles).toMatch(
      /<a class="spr-stat-label spr-stat-link" href="\/-\/logs">Dead jobs<\/a>/,
    );
    expect(tiles).toMatch(
      /<a class="spr-stat-label spr-stat-link" href="\/-\/graph">Dropped grants<\/a>/,
    );
    expect(tiles).toMatch(/<span class="spr-stat-label">Repositories<\/span>/);
  });

  it("is sent from the repository's table to the run's own page for its findings", async () => {
    const res = await page('ops', '/-/status/copetence/handbook');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`href="${runPath}"`);
    // Counted in the row, drawn on the run's page — never folded under the row
    expect(res.text).toMatch(/<th scope="col" class="spr-num">Findings<\/th>/);
    expect(res.text).not.toContain('unknown-group');
    // The count carries the mark of the run's worst finding, the word as its name
    expect(res.text).toMatch(
      /<span class="spr-run-findings">\s*<span\s+class="spr-badge spr-badge-fail spr-badge-icon"\s+title="reject"\s*><svg[\s\S]*?<span class="spr-clipped">reject<\/span><\/span>\s*1\s*<\/span>/,
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

  it('offers Discover on an instance whose table is empty', async () => {
    const res = await page('ops', '/-/status?q=nosuchrepository');
    expect(res.text).toContain('action="/-/discover"');
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

  it('is not offered the log, or told anything about the instance', async () => {
    const res = await page('alice', '/-/status');
    expect(res.text).not.toContain('href="/-/logs"');
    expect(res.text).not.toContain('Resolution hash');
    expect(res.text).not.toContain(harness.config.resolutionHash);
    expect(res.text).not.toContain('Dead jobs');
    expect(res.text).toContain('Repositories');
    expect(res.text).toMatch(/<span class="spr-stat-label">Dropped grants<\/span>/);
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

describe('explain, as a page', () => {
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

describe('the logs page', () => {
  it('renders both halves for an admin', async () => {
    const res = await page('ops', '/-/logs');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Retired redirects');
    expect(res.text).toContain('Dead jobs');
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
      const res = await page('ops', '/-/logs');
      // One row: the heading and the control acting on everything under it
      const head = /<div class="spr-section-head">([\s\S]*?)<\/div>/.exec(res.text)?.[1] ?? '';
      expect(head).toContain('<h2>Dead jobs</h2>');
      expect(head).toMatch(/<button type="submit"><svg class="spr-icon"[\s\S]*?<\/svg>Retry all 1/);

      expect(res.text).toContain('<th scope="col">Job</th>');
      expect(res.text).toContain('<th scope="col">Error</th>');
      expect(res.text).not.toContain('<th scope="col">Payload</th>');
      // The error in its cell, escaped — it can quote a remote's own words
      expect(res.text).toContain(
        '<td class="spr-job-error">clone failed: Authentication failed for &lt;the remote&gt;</td>',
      );
      // The payload is the JSON's, not the page's
      expect(res.text).not.toContain('&quot;repoId&quot;');
      expect((await json('ops', '/-/logs')).body.dead_jobs[0].payload.repoId).toBe(
        harness.repos.handbook,
      );
      expect(res.text).toMatch(
        /<button type="submit"><svg class="spr-icon"[\s\S]*?<\/svg>Retry<\/button>/,
      );
    } finally {
      await getSequelize().query(`DELETE FROM jobs WHERE status = 'dead'`);
    }
  });

  it('offers no Retry all when nothing is dead', async () => {
    const res = await page('ops', '/-/logs');
    expect(res.text).toContain('No job has been given up on.');
    expect(res.text).not.toContain('Retry all');
  });

  it('is the reader 404 for anyone else, page or JSON', async () => {
    for (const res of [await page('alice', '/-/logs'), await json('alice', '/-/logs')]) {
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/text\/html/);
    }
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
    const logs = await page('ops', '/-/logs');
    const logIslands = [...logs.text.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)];
    expect(logIslands).toHaveLength(1);
    expect(logIslands[0][1]).toMatch(/\/fold-[0-9a-f]+\.js$/);

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
    expect((await page('ops', '/-/logs')).text).toContain(sheets[0]);

    expect(sheets[1]).toMatch(/\/-\/static\/sheet-dashboard-[0-9a-f]+\.css/);
    const reader = await request(app.getHttpServer())
      .get('/')
      .set('Cookie', cookies.ops as string);
    expect(reader.text).not.toContain(sheets[1]);
  });
});

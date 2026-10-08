import { Controller, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { JobQueue } from '../../src/jobs/queue';
import { Worker } from '../../src/jobs/worker';
import { TenancyService } from '../../src/db/tenancy';
import { closeSequelize } from '../../src/db/sequelize';
import { emptyStateArt } from '../../src/content-reader/empty-state';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp } from '../helpers/http';

const BOOM = 'the sky fell on 41 documents';

@Controller('-')
class BoomController {
  @Post('__boom')
  boom(): void {
    throw new Error(BOOM);
  }
}

let harness: Harness;
let app: INestApplication;
let written: string[];
let spy: jest.SpyInstance;

beforeAll(async () => {
  harness = await createHarness();
  app = await bootTestApp(undefined, [BoomController]);
});

afterAll(async () => {
  await app.close();
  await harness.close();
  await closeSequelize();
});

beforeEach(() => {
  written = [];
  spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
});

afterEach(() => spy.mockRestore());

function logLines(): Array<Record<string, unknown>> {
  return written
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('an unhandled exception', () => {
  it('is logged once, with the route and the stack', async () => {
    await request(app.getHttpServer()).post('/-/__boom').expect(500);

    const failures = logLines().filter((line) => line.msg === 'request failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      level: 'error',
      method: 'POST',
      path: '/-/__boom',
      status: 500,
      error: BOOM,
    });
    expect(String(failures[0].stack)).toContain('BoomController');
  });

  it('carries the request id and the tenant, bound in middleware', async () => {
    const res = await request(app.getHttpServer()).post('/-/__boom').expect(500);

    const line = logLines().find((entry) => entry.msg === 'request failed');
    expect(line?.request_id).toBe(res.headers['x-request-id']);
    expect(line?.tenant_id).toBe(harness.tenantId);
  });

  it('never puts the query string in that line', async () => {
    await request(app.getHttpServer()).post('/-/__boom?secret=hunter2').expect(500);

    const line = logLines().find((entry) => entry.msg === 'request failed');
    expect(JSON.stringify(line)).not.toContain('hunter2');
    expect(line).toMatchObject({ path: '/-/__boom' });
  });

  it('answers a browser with the reader shell and the request id, and no detail', async () => {
    const res = await request(app.getHttpServer())
      .post('/-/__boom')
      .set('Accept', 'text/html')
      .expect(500);

    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<main');
    expect(res.text).toContain('Something went wrong');
    expect(res.text).toContain(emptyStateArt('broken'));
    expect(res.text).not.toContain(BOOM);
    expect(res.text).toContain(res.headers['x-request-id']);
  });

  it('answers a JSON caller with the same id and nothing else', async () => {
    const res = await request(app.getHttpServer())
      .post('/-/__boom')
      .set('Accept', 'application/json')
      .expect(500);

    expect(res.body).toEqual({ error: 'internal', request_id: res.headers['x-request-id'] });
    expect(res.headers.vary).toContain('Accept');
  });

  it('honours a request id the caller supplied, so a proxy trace joins up', async () => {
    const res = await request(app.getHttpServer())
      .post('/-/__boom')
      .set('X-Request-Id', 'trace-from-the-ingress')
      .set('Accept', 'application/json')
      .expect(500);

    expect(res.body.request_id).toBe('trace-from-the-ingress');
    const line = logLines().find((entry) => entry.msg === 'request failed');
    expect(line).toBeDefined();
  });
});

describe('a failure before any route runs', () => {
  it('is answered and logged like any other', async () => {
    const tenancy = app.get(TenancyService);
    const broken = jest
      .spyOn(tenancy, 'resolveTenant')
      .mockRejectedValue(new Error('the database went away'));

    try {
      const res = await request(app.getHttpServer())
        .get('/')
        .set('Accept', 'application/json')
        .expect(500);
      expect(res.body).toEqual({ error: 'internal', request_id: res.headers['x-request-id'] });
    } finally {
      broken.mockRestore();
    }

    const failures = logLines().filter((line) => line.msg === 'request failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ error: 'the database went away', path: '/' });
    expect(failures[0].request_id).toEqual(expect.any(String));
    expect(failures[0].tenant_id).toBeUndefined();
  });
});

describe('a route that does not exist', () => {
  it('gets the reader 404, whatever the method and whatever the Accept', async () => {
    for (const accept of ['text/html', 'application/json']) {
      const res = await request(app.getHttpServer())
        .post('/-/nope')
        .set('Accept', accept)
        .expect(404);

      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('There is nothing at this address');
      expect(res.text).toContain(emptyStateArt('missing'));
      expect(res.text).not.toContain('Cannot POST');
    }
  });

  it('is not logged — a 404 is an answer, not a failure', async () => {
    await request(app.getHttpServer()).post('/-/nope').expect(404);
    expect(logLines().filter((line) => line.msg === 'request failed')).toHaveLength(0);
  });
});

describe('a malformed request body', () => {
  it('is the caller’s 4xx: not logged, and echoing nothing', async () => {
    const res = await request(app.getHttpServer())
      .post('/-/__boom')
      .set('Content-Type', 'application/json')
      .send('{"nope"');

    expect(res.status).toBe(400);
    expect(res.text).toBe('');
    expect(logLines().filter((line) => line.msg === 'request failed')).toHaveLength(0);
  });
});

describe('a failed job', () => {
  it('says which tenant and which job, from the context around the handler', async () => {
    const queue = app.get(JobQueue);
    const worker = app.get(Worker);

    await queue.enqueue({
      tenantId: harness.tenantId,
      kind: 'purge',
      payload: { repoId: 'not-a-uuid' },
    });
    const [job] = await queue.claim(1);
    expect(job).toBeDefined();

    await (worker as unknown as { run(row: typeof job): Promise<void> }).run(job);

    const failures = logLines().filter((line) => line.msg === 'job failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      tenant_id: harness.tenantId,
      job_id: job.id,
      job_kind: 'purge',
    });
    expect(failures[0].attempts).toBe(1);
    expect(String(failures[0].error)).toContain('uuid');
  });
});

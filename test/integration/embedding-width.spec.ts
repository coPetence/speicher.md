import { createServer, IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import request from 'supertest';

import { ConfigService } from '../../src/config/config.service';
import { CONFIG_SOURCE_ENV, loadActiveInstanceConfig } from '../../src/config/loader';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { FormBody, formBody } from '../helpers/form';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

let harness: Harness;
let app: INestApplication;
let ops: string;
let mallory: string;

interface Received {
  headers: IncomingHttpHeaders;
  body: { model: string; input: string[]; dimensions?: number };
}

let endpoint: Server;
let endpointUrl: string;
let received: Received[] = [];
let answer: (received: Received) => { status: number; body: string };

const ENV_VAR = 'EMBED_WIDTH_TEST_KEY';

const answeringWith = (native: number) => (call: Received) => ({
  status: 200,
  body: JSON.stringify({
    data: call.body.input.map((_, index) => ({
      index,
      embedding: Array.from({ length: call.body.dimensions ?? native }, () => 0),
    })),
  }),
});

beforeAll(async () => {
  harness = await createHarness();
  ops = await sessionCookieFor(harness.tenantId, 'ops');
  mallory = await sessionCookieFor(harness.tenantId, 'mallory');

  process.env[CONFIG_SOURCE_ENV] = 'database';
  await getSequelize().query(`DELETE FROM instance_configs`, { type: QueryTypes.DELETE });
  app = await bootTestApp(new ConfigService(await loadActiveInstanceConfig()));

  endpoint = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => {
      const record: Received = { headers: req.headers, body: JSON.parse(raw) };
      received.push(record);
      const reply = answer(record);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', () => resolve()));
  endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/v1`;
});

beforeEach(() => {
  received = [];
  answer = answeringWith(1536);
  delete process.env[ENV_VAR];
});

afterAll(async () => {
  await new Promise<void>((resolve) => endpoint?.close(() => resolve()));
  await app?.close();
  delete process.env[CONFIG_SOURCE_ENV];
  await harness?.close();
  await closeSequelize();
});

async function versionCount(): Promise<number> {
  const rows = await getSequelize().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM instance_configs WHERE tenant_id = :tenantId`,
    { type: QueryTypes.SELECT, replacements: { tenantId: harness.tenantId } },
  );
  return Number(rows[0].count);
}

async function askAbout(
  fields: Partial<Record<'model' | 'api_key' | 'dimensions', string>> & { send?: boolean },
  cookie = ops,
) {
  const page = await request(app.getHttpServer())
    .get('/-/config/embedding')
    .set('cookie', ops)
    .expect(200);
  const body: FormBody = formBody(page.text);
  body['embedding.base_url'] = endpointUrl;
  if (fields.model !== undefined) body['embedding.model'] = fields.model;
  if (fields.api_key !== undefined) body['embedding.api_key'] = fields.api_key;
  if (fields.dimensions !== undefined) body['embedding.dimensions'] = fields.dimensions;
  if (fields.send === false) delete body['embedding.send_dimensions'];

  return request(app.getHttpServer())
    .post('/-/config/embedding')
    .set('cookie', cookie)
    .set('accept', 'application/json')
    .send({ ...body, intent: 'width' });
}

describe('the width lookup on the embedding page', () => {
  it("is drawn on the model box, with its answer's place beside it, for the island to find", async () => {
    const page = await request(app.getHttpServer())
      .get('/-/config/embedding')
      .set('cookie', ops)
      .expect(200);

    const model = /<input[^>]*name="embedding\.model"[^>]*>/.exec(page.text)?.[0] ?? '';
    expect(model).toContain('data-spr-width-into="embedding.dimensions"');
    expect(page.text).toMatch(
      /<p class="spr-note spr-note-idle" data-spr-width-note hidden><svg.*?<\/svg><\/p>/,
    );
  });

  it('fills in the width the model returns, asking it the model it was given', async () => {
    const before = await versionCount();

    const response = await askAbout({
      model: 'text-embedding-3-small',
      dimensions: '',
      send: true,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ dimensions: 1536, model: 'text-embedding-3-small' });
    expect(received).toHaveLength(1);
    expect(received[0].body.model).toBe('text-embedding-3-small');
    expect('dimensions' in received[0].body).toBe(false);
    expect(await versionCount()).toBe(before);
  });

  it('sends the typed width when the parameter is on, so the answer is the width a save would store', async () => {
    answer = answeringWith(1536);

    const response = await askAbout({
      model: 'text-embedding-3-large',
      dimensions: '512',
      send: true,
    });

    expect(received[0].body.dimensions).toBe(512);
    expect(response.body.dimensions).toBe(512);
  });

  it('does not send the parameter when it is off, even with a width typed', async () => {
    const response = await askAbout({
      model: 'text-embedding-3-large',
      dimensions: '512',
      send: false,
    });

    expect('dimensions' in received[0].body).toBe(false);
    expect(response.body.dimensions).toBe(1536);
  });

  it('sends the key typed into the form in both headers the endpoint might read', async () => {
    await askAbout({ model: 'text-embedding-3-small', api_key: 'sk-typed', dimensions: '' });

    expect(received[0].headers.authorization).toBe('Bearer sk-typed');
    expect(received[0].headers['api-key']).toBe('sk-typed');
  });

  it('names a ${VAR} the environment does not set, and sends nothing', async () => {
    const response = await askAbout({ model: 'text-embedding-3-small', api_key: `\${${ENV_VAR}}` });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain(ENV_VAR);
    expect(received).toHaveLength(0);
  });

  it('says the endpoint refused, with its status, and writes nothing', async () => {
    answer = () => ({ status: 401, body: '{"error":"invalid key"}' });
    const before = await versionCount();

    const response = await askAbout({ model: 'text-embedding-3-small', dimensions: '' });

    expect(response.status).toBe(502);
    expect(response.body.error).toMatch(/did not answer.*401/);
    expect(await versionCount()).toBe(before);
  });

  it('asks nothing when there is no model to ask about', async () => {
    const response = await askAbout({ model: '', dimensions: '' });

    expect(response.status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("is the reader's 404 for anybody who is not the administrator", async () => {
    const response = await askAbout({ model: 'text-embedding-3-small', dimensions: '' }, mallory);

    expect(response.status).toBe(404);
    expect(received).toHaveLength(0);
  });
});

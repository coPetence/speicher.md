import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { closeSequelize } from '../../src/db/sequelize';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp } from '../helpers/http';

let app: INestApplication;
let harness: Harness;

const DECLARED_URL = 'https://docs.example.com';
const before = process.env.SPEICHER_PUBLIC_URL;

beforeAll(async () => {
  process.env.SPEICHER_PUBLIC_URL = DECLARED_URL;
  harness = await createHarness();
  app = await bootTestApp();
});

afterAll(async () => {
  if (before === undefined) delete process.env.SPEICHER_PUBLIC_URL;
  else process.env.SPEICHER_PUBLIC_URL = before;
  await app?.close();
  await harness?.close();
  await closeSequelize();
});

describe('the endpoint answers the methods the transport requires', () => {
  it('answers GET with 405 rather than falling through to the reader', async () => {
    const res = await request(app.getHttpServer()).get('/mcp');
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST');
  });

  it('answers DELETE with 405, assigning no session to terminate', async () => {
    const res = await request(app.getHttpServer()).delete('/mcp');
    expect(res.status).toBe(405);
  });

  it('assigns no session id', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toBeUndefined();
  });
});

describe('protocol version negotiation', () => {
  it('echoes a revision the client asked for and this server supports', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' },
      });
    expect(res.body.result.protocolVersion).toBe('2024-11-05');
  });

  it('proposes its own revision when the client asks for one it does not know', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '1999-01-01' },
      });
    expect(res.body.result.protocolVersion).toBe('2025-11-25');
  });

  it('refuses a request whose MCP-Protocol-Version header it cannot speak', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set('MCP-Protocol-Version', '1999-01-01')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(400);
  });

  it('accepts a request that sends no version header at all', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(200);
  });
});

describe('origin validation', () => {
  it('refuses a foreign Origin', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set('Origin', 'https://evil.example.com')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(403);
  });

  it('accepts its own declared origin', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set('Origin', DECLARED_URL)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(200);
  });

  it('accepts a request carrying no Origin, which is every real client', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(200);
  });
});

describe('tool annotations', () => {
  it('declares every tool read-only, with a title', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = res.body.result.tools as {
      name: string;
      title?: string;
      annotations?: { readOnlyHint?: boolean };
    }[];
    expect(tools.map((tool) => tool.name).sort()).toEqual(['list', 'read', 'search']);
    for (const tool of tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });
});

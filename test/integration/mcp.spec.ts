import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { closeSequelize } from '../../src/db/sequelize';
import { EMBEDDING_CLIENT } from '../../src/embed/embed.module';
import { EmbedService } from '../../src/embed/embed.service';
import { hashingVector, stubEmbeddingClient } from '../helpers/embedding';
import { Harness, PrincipalName, createHarness, resetVectorIndex } from '../helpers/harness';
import { accessTokenFor, bootTestApp, sessionCookieFor } from '../helpers/http';

let app: INestApplication;
let harness: Harness;
const tokens: Partial<Record<PrincipalName, string>> = {};
const cookies: Partial<Record<PrincipalName, string>> = {};

const READERS: PrincipalName[] = ['alice', 'bob', 'carol', 'dave', 'ops', 'mallory'];

type Reader = PrincipalName | 'anonymous';
const EVERYONE: Reader[] = [...READERS, 'anonymous'];

const ALL_PATHS = [
  '/handbook/',
  '/handbook/introduction',
  '/handbook/setup',
  '/handbook/where-things-live',
  '/handbook/troubleshooting',
  '/handbook/commercial',
  '/handbook/commercial/pricing',
  '/handbook/commercial/legal',
  '/handbook/commercial/legal/contracts',
  '/handbook/northwind',
  '/handbook/northwind/handover',
  '/northwind-engineering/specs/',
  '/northwind-engineering/specs/tolerances',
  '/speicher-docs/',
  '/speicher-docs/getting-started',
  '/speicher-docs/internal',
  '/speicher-docs/internal/roadmap',
];

beforeAll(async () => {
  harness = await createHarness();
  app = await bootTestApp();
  for (const name of READERS) {
    tokens[name] = await accessTokenFor(harness.tenantId, name);
    cookies[name] = await sessionCookieFor(harness.tenantId, name);
  }
});

afterAll(async () => {
  await app?.close();
  await harness?.close();
  await closeSequelize();
});

async function rpc(who: PrincipalName | 'anonymous', method: string, params?: unknown) {
  const req = request(app.getHttpServer())
    .post(who === 'anonymous' ? '/mcp/public' : '/mcp')
    .send({ jsonrpc: '2.0', id: 1, method, params });
  if (who !== 'anonymous') req.set('Authorization', `Bearer ${tokens[who]}`);
  return req;
}

async function callTool(who: Reader, name: string, args: Record<string, unknown>) {
  return callToolOn(app, who, name, args);
}

async function callToolOn(
  target: INestApplication,
  who: Reader,
  name: string,
  args: Record<string, unknown>,
) {
  const req = request(target.getHttpServer())
    .post(who === 'anonymous' ? '/mcp/public' : '/mcp')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (who !== 'anonymous') req.set('Authorization', `Bearer ${tokens[who]}`);
  const res = await req;
  expect(res.status).toBe(200);
  return res.body.result as { content: { text: string }[]; isError?: boolean };
}

describe('transport', () => {
  it('answers an unauthenticated call with what the public repository holds', async () => {
    const res = await rpc('anonymous', 'tools/list');
    expect(res.status).toBe(200);

    const listed = await callTool('anonymous', 'list', {});
    expect(listed.content[0].text).toMatch(/speicher-docs/);
    expect(listed.content[0].text).not.toMatch(/handbook|specs|fieldkit/);
  });

  it('reads only public content at /mcp/public, whatever credential is sent', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp/public')
      .set('Authorization', `Bearer ${tokens.alice}`)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list', arguments: {} },
      });
    expect(res.body.result.content[0].text).toMatch(/speicher-docs/);
    expect(res.body.result.content[0].text).not.toMatch(/handbook/);
  });

  it('advertises exactly the three tools', async () => {
    const res = await rpc('alice', 'tools/list');
    expect(res.status).toBe(200);
    expect(res.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'list',
      'read',
      'search',
    ]);
  });

  it('handshakes', async () => {
    const res = await rpc('alice', 'initialize');
    expect(res.body.result.serverInfo.name).toBe('speicher');
  });
});

describe('the permitted path set is identical on both surfaces', () => {
  for (const who of EVERYONE) {
    it(`${who} reaches the same paths over MCP as over HTTP`, async () => {
      const overHttp: string[] = [];
      const overMcp: string[] = [];

      for (const path of ALL_PATHS) {
        const get = request(app.getHttpServer()).get(path);
        if (who !== 'anonymous') get.set('Cookie', cookies[who] as string);
        const http = await get;
        if (http.status === 200) overHttp.push(path);

        const read = await callTool(who, 'read', { path });
        const list = await callTool(who, 'list', { path });
        if (!read.isError || !list.isError) overMcp.push(path);
      }

      expect(overMcp.sort()).toEqual(overHttp.sort());
    });
  }
});

describe('read', () => {
  it('returns Markdown, not HTML', async () => {
    const result = await callTool('alice', 'read', { path: '/handbook/introduction' });
    const text = result.content[0].text;
    expect(text).toContain('# Introduction');
    expect(text).not.toContain('<h1>');
  });

  it('rewrites the repo sentinel into the current public base', async () => {
    const result = await callTool('bob', 'read', { path: '/handbook/commercial/pricing' });
    const text = result.content[0].text;
    expect(text).not.toContain('/~repo~');
    expect(text).toContain('/handbook/introduction');
  });

  it('still serves a page marked indexable false', async () => {
    const result = await callTool('alice', 'read', { path: '/handbook/troubleshooting' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Troubleshooting');
  });

  it('answers identically for a restricted path and a nonexistent one', async () => {
    const restricted = await callTool('alice', 'read', { path: '/handbook/commercial/pricing' });
    const absent = await callTool('alice', 'read', { path: '/handbook/no-such-page' });
    expect(restricted.isError).toBe(true);
    expect(absent.isError).toBe(true);
    expect(restricted.content[0].text).toBe('No document at /handbook/commercial/pricing.');
    expect(absent.content[0].text).toBe('No document at /handbook/no-such-page.');
  });
});

describe('list', () => {
  it('lists only the repos the caller can see', async () => {
    const alice = await callTool('alice', 'list', {});
    expect(alice.content[0].text).toContain('/handbook');
    expect(alice.content[0].text).not.toContain('/northwind-engineering/specs');

    const carol = await callTool('carol', 'list', {});
    expect(carol.content[0].text).toContain('/northwind-engineering/specs');
  });

  it('omits a restricted child by name', async () => {
    const alice = await callTool('alice', 'list', { path: '/handbook/' });
    expect(alice.content[0].text).not.toMatch(/commercial/i);
    expect(alice.content[0].text).not.toMatch(/northwind/i);

    const bob = await callTool('bob', 'list', { path: '/handbook/' });
    expect(bob.content[0].text).toMatch(/commercial/i);
  });

  it('never lists the folder nobody can read', async () => {
    for (const who of READERS) {
      const result = await callTool(who, 'list', { path: '/handbook/commercial' });
      if (result.isError) continue;
      expect(result.content[0].text).not.toMatch(/legal/i);
    }
  });

  it('shows an admin with no content grant only what is public', async () => {
    const result = await callTool('ops', 'list', {});
    expect(result.content[0].text).toMatch(/speicher-docs/);
    expect(result.content[0].text).not.toMatch(/handbook|specs|fieldkit/);
  });
});

describe('search cites the passage it matched', () => {
  const DIMENSIONS = 512;
  let semanticApp: INestApplication;

  beforeAll(async () => {
    await resetVectorIndex();
    const stub = stubEmbeddingClient({ dimensions: DIMENSIONS }, hashingVector);
    const run = await new EmbedService(stub.client).embedPending(harness.tenantId);
    expect(run.embedded).toBeGreaterThan(0);

    semanticApp = await bootTestApp(
      undefined,
      [],
      [{ token: EMBEDDING_CLIENT, value: stub.client }],
    );
  });

  afterAll(async () => {
    await semanticApp?.close();
    await resetVectorIndex();
  });

  async function semanticSearch(who: PrincipalName, args: Record<string, unknown>) {
    const res = await request(semanticApp.getHttpServer())
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens[who]}`)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search', arguments: args },
      });
    return res.body.result.content[0].text as string;
  }

  it('returns the chunk and its position, not a snippet of the document', async () => {
    const text = await semanticSearch('bob', {
      query: 'generated API documentation with godoc anchors',
      path_prefix: '/handbook/reference',
    });

    expect(text).toContain('/handbook/reference/client');
    expect(text).toMatch(/passage \d+ — /);
  });

  it('keeps the snippet for a hit only the keyword ranker found', async () => {
    const text = await semanticSearch('carol', { query: 'zzz-nonexistent tolerances' });
    expect(text).toContain('/northwind-engineering/specs/tolerances');
  });

  it('never marks up a passage, whatever the page contains', async () => {
    const text = await semanticSearch('bob', {
      query: 'generated API documentation with godoc anchors',
      path_prefix: '/handbook/reference',
    });
    expect(text).not.toContain('<mark>');
  });

  it('leaves the permitted path set exactly where it was', async () => {
    for (const who of READERS) {
      const overHttp: string[] = [];
      const overMcp: string[] = [];

      for (const path of ALL_PATHS) {
        const http = await request(semanticApp.getHttpServer())
          .get(path)
          .set('Cookie', cookies[who] as string);
        if (http.status === 200) overHttp.push(path);

        const read = await callToolOn(semanticApp, who, 'read', { path });
        const list = await callToolOn(semanticApp, who, 'list', { path });
        if (!read.isError || !list.isError) overMcp.push(path);
      }

      expect({ who, paths: overMcp.sort() }).toEqual({ who, paths: overHttp.sort() });
    }
  });

  it('still omits a page marked indexable false', async () => {
    const text = await semanticSearch('alice', {
      query: 'troubleshooting a sync that will not finish',
    });
    expect(text).not.toContain('/handbook/troubleshooting');

    const read = await callToolOn(semanticApp, 'alice', 'read', {
      path: '/handbook/troubleshooting',
    });
    expect(read.isError).toBeFalsy();

    const commercial = await semanticSearch('bob', { query: 'rate card pricing tiers' });
    expect(commercial).not.toContain('/handbook/commercial/pricing');
  });
});

describe('search', () => {
  it('returns permitted results with paths and snippets', async () => {
    const result = await callTool('carol', 'search', { query: 'tolerances' });
    expect(result.content[0].text).toContain('/northwind-engineering/specs/tolerances');
  });

  it('returns nothing about a restricted page', async () => {
    const result = await callTool('alice', 'search', { query: 'tolerances' });
    expect(result.content[0].text).toBe('No results.');
  });

  it('omits a page marked indexable false, which governs AI retrieval', async () => {
    const result = await callTool('alice', 'search', { query: 'troubleshooting' });
    expect(result.content[0].text).not.toContain('/handbook/troubleshooting');
  });

  it('narrows to the prefix rather than to its repository', async () => {
    const wide = await callTool('bob', 'search', { query: 'pricing' });
    expect(wide.content[0].text).toContain('/handbook/where-things-live');

    const scoped = await callTool('bob', 'search', {
      query: 'pricing',
      path_prefix: '/handbook/commercial',
    });
    expect(scoped.content[0].text).not.toContain('/handbook/where-things-live');
  });

  it('returns nothing under a prefix the caller cannot read', async () => {
    const result = await callTool('alice', 'search', {
      query: 'pricing',
      path_prefix: '/handbook/commercial',
    });
    expect(result.content[0].text).toBe('No results.');
  });

  it('returns nothing for a prefix that does not resolve at all', async () => {
    const result = await callTool('bob', 'search', {
      query: 'pricing',
      path_prefix: '/no-such-repo/anywhere',
    });
    expect(result.content[0].text).toBe('No results.');
  });
});

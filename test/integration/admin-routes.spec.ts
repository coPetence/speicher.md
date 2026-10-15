import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import request from 'supertest';

import { DashboardController } from '../../src/dashboard/dashboard.controller';
import { ConfigController } from '../../src/dashboard/configurator/config.controller';
import { ConnectionsController } from '../../src/dashboard/connections.controller';
import { HealthController } from '../../src/health/health.controller';
import { AuthController } from '../../src/auth/auth.controller';
import { closeSequelize } from '../../src/db/sequelize';
import { WebhookController } from '../../src/forge/webhook.controller';
import { McpController } from '../../src/mcp/mcp.controller';
import { BrandController, StaticController } from '../../src/content-reader/assets.controller';
import { ReadController } from '../../src/content-reader/read.controller';
import { SetupController } from '../../src/dashboard/setup/setup.controller';
import { SetupWizardController } from '../../src/dashboard/setup/wizard.controller';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

let app: INestApplication;
let harness: Harness;
let admin: string;

beforeAll(async () => {
  harness = await createHarness();
  app = await bootTestApp();
  admin = await sessionCookieFor(harness.tenantId, 'ops');
});

afterAll(async () => {
  await app?.close();
  await harness?.close();
  await closeSequelize();
});

type Contract = { both: string } | { exempt: string } | { covered: string };

const CONTRACT: Record<string, Contract> = {
  'GET /-/healthz': {
    exempt:
      'A liveness probe, unauthenticated and with no page: an orchestrator sends no ' +
      'Accept header and needs one shape back whatever it sends.',
  },
  'GET /-/readyz': { exempt: 'The other probe, for the same reason.' },
  'GET /-/search': { both: '/-/search?q=smtp' },
  'GET /-/status': { both: '/-/status' },
  'GET /-/status/:namespace/:slug': { both: '/-/status/copetence/handbook' },
  'GET /-/status/:namespace/:slug/runs/:runId': {
    covered:
      'admin.spec.ts, page and JSON both. One document twice like its neighbours, ' +
      'but the address carries a run id minted by `gen_random_uuid()`, which a ' +
      'table of fixed paths cannot name; admin.spec.ts seeds the run it opens.',
  },
  'GET /-/graph': { both: '/-/graph' },
  'GET /-/explain': { both: '/-/explain?path=/handbook/commercial/pricing' },
  'GET /-/logs': { both: '/-/logs' },
  'GET /-/analytics': { both: '/-/analytics' },
  'GET /-/connections': { both: '/-/connections' },
  'POST /-/connections/revoke': {
    covered:
      'mcp-oauth.spec.ts. It is a form post that answers 303 to the page it came ' +
      'from — a JSON caller would receive a redirect rather than a document, and ' +
      'the thing worth asserting about it is that a row belonging to somebody ' +
      'else is not found rather than refused, which needs two identities.',
  },
  'GET /-/setup': { both: '/-/setup' },
  'GET /-/setup/administrator': { both: '/-/setup/administrator' },
  'POST /-/setup/prove': {
    covered:
      'setup-wizard.spec.ts. It begins a login rather than answering with a ' +
      'document: the browser is redirected to somebody else’s identity provider, ' +
      'and a JSON caller would receive a page it has no way to follow. Asserting ' +
      'it here would also mean starting a login flow as a side effect of a ' +
      'coverage test — and on an instance that has an administrator, which is what ' +
      'this suite runs against, it is refused rather than performed.',
  },
  'GET /-/config': { both: '/-/config' },
  'GET /-/config/history': { both: '/-/config/history' },
  'GET /-/config/environment': { both: '/-/config/environment' },
  'GET /-/config/backup': { both: '/-/config/backup' },
  'GET /-/config/download': {
    exempt:
      'A file, not a document in two encodings: it serves the same `yaml` the ' +
      'overview’s payload already carries, with a filename and a disposition on ' +
      'top. A JSON caller reads it off `GET /-/config` and has no second question ' +
      'to ask here. Asserted in config-editor.spec.ts.',
  },
  'GET /-/config/:section': { both: '/-/config/identity' },
  'GET /-/config/:section/:member': { both: '/-/config/identity/entra' },
  'GET /-/config/:section/:member/:entry': { both: '/-/config/groups/engineering/entra' },
  'GET /-/config/preview/:template': {
    exempt:
      'A rendering rather than a document: the page is a fixed sample article ' +
      'drawn with one template, so the payload a JSON caller would receive is a ' +
      'constant this codebase holds and would describe the sample, not the ' +
      'instance. It is asserted in config-templates.spec.ts instead.',
  },

  'GET /-/config/brand/:hash': {
    exempt:
      'An image, not a document: it answers with the bytes of a stored brand ' +
      'image for the thumbnail beside its picker, and there is no JSON encoding ' +
      'of a PNG. It is asserted in config-editor.spec.ts, where the page that ' +
      'draws it is.',
  },

  'POST /-/config/:section/:member/:app/manifest': {
    covered:
      'github-app-manifest.spec.ts. It hands the browser over to GitHub with a form ' +
      'that posts a manifest there, so the document a JSON caller would receive is a ' +
      'form for another site.',
  },
  'GET /-/config/:section/:member/:app/manifest/callback': {
    covered:
      'github-app-manifest.spec.ts. It is where GitHub sends the browser back with ' +
      'a code. It saves the page with the App GitHub created and redirects to where ' +
      'the App is installed, or answers with the page when the save is refused.',
  },
  'POST /-/config/:section/:member/:entry': {
    covered:
      'config-editor.spec.ts, for the reason every save route here is: the request ' +
      'is a multipart form built from a page that has to be opened first. It is ' +
      'the same handler — `saveSection` — reached with a section id naming one ' +
      'entry of one member.',
  },
  'POST /-/config/:section/:member': {
    covered:
      'config-editor.spec.ts, for the reason its parent route is: the request is ' +
      'a multipart form built from a page that has to be opened first. It is the ' +
      'same handler — `saveSection` — reached with a section id naming one ' +
      'member.',
  },
  'POST /-/config/:section': {
    covered:
      'config-editor.spec.ts. It answers both — the whole payload, or the same ' +
      'payload rendered — but the request is a multipart form built from a page ' +
      'that has to be opened first.',
  },
  'POST /-/reembed': {
    covered:
      'reembed.spec.ts. Like `POST /-/config/restore`, its two representations are ' +
      'not one document twice: a browser is redirected to the page that carries ' +
      'the answer and a JSON caller is told the numbers. Asserting it here would ' +
      'mean clearing every vector in the fixture as a side effect of a coverage ' +
      'test.',
  },
  'POST /-/discover': {
    covered:
      'discovery.spec.ts. Two representations, and neither is one document twice: ' +
      'a browser is redirected to the page carrying the answer and a JSON caller ' +
      'is told which forges were asked. Asserting it here would enqueue a job ' +
      'against the fixture forge as a side effect of a coverage test.',
  },
  'POST /-/sync': {
    covered:
      'discovery.spec.ts. The same shape as the two above, and the one write here ' +
      'a maintainer may make: asserting it would enqueue a sync of a fixture ' +
      'repository as a side effect of a coverage test.',
  },
  'POST /-/jobs/retry': {
    covered:
      'discovery.spec.ts. The same shape, and it writes: asserting it here would ' +
      'move every dead job in the fixture back onto the queue.',
  },
  'POST /-/config/restore': {
    covered:
      'config-history.spec.ts. The one route whose representations are not one ' +
      'document twice: a browser is redirected to the page carrying the answer, a ' +
      'JSON caller is told the version. Asserting it here would mean writing a ' +
      'config version as a side effect of a coverage test.',
  },
};

function routesOf(controller: new (...args: never[]) => unknown): string[] {
  const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .map((name) => proto[name])
    .filter(
      (handler): handler is object =>
        typeof handler === 'function' && Reflect.hasMetadata(PATH_METADATA, handler),
    )
    .map((handler) => {
      const verb = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)];
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
      return `${verb} /${base}/${path}`;
    });
}

const MOUNTED = [
  HealthController,
  DashboardController,
  ConfigController,
  ConnectionsController,
  SetupWizardController,
]
  .flatMap(routesOf)
  .sort();

function pathsOf(controller: new (...args: never[]) => unknown): { path: string }[] {
  const proto = controller.prototype as Record<string, unknown>;
  const handlerPaths = Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .map((name) => proto[name])
    .filter(
      (handler): handler is object =>
        typeof handler === 'function' && Reflect.hasMetadata(PATH_METADATA, handler),
    )
    .map((handler) => Reflect.getMetadata(PATH_METADATA, handler) as string);
  return [Reflect.getMetadata(PATH_METADATA, controller) as string, ...handlerPaths]
    .filter((path) => typeof path === 'string')
    .map((path) => ({ path }));
}

const ALL_ROUTES = [
  HealthController,
  DashboardController,
  ConfigController,
  SetupWizardController,
  SetupController,
  ReadController,
  AuthController,
  WebhookController,
  McpController,
  BrandController,
  StaticController,
].flatMap(pathsOf);

describe('the routes under /-/', () => {
  it('are each declared, so a new one cannot arrive without deciding this', () => {
    expect(MOUNTED).toEqual(Object.keys(CONTRACT).sort());
  });
});

describe('route syntax', () => {
  it('says what it means, rather than relying on the legacy converter', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LegacyRouteConverter } = require('@nestjs/core/router/legacy-route-converter') as {
      LegacyRouteConverter: { tryConvert(route: string): string };
    };
    const rewritten = ALL_ROUTES.filter(
      ({ path }) => LegacyRouteConverter.tryConvert(path) !== path,
    );
    expect(rewritten.map((r) => `${r.path} -> ${LegacyRouteConverter.tryConvert(r.path)}`)).toEqual(
      [],
    );
  });

  it('checks something, which a converter this test cannot reach would not', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LegacyRouteConverter } = require('@nestjs/core/router/legacy-route-converter') as {
      LegacyRouteConverter: { tryConvert(route: string): string };
    };
    expect(ALL_ROUTES.length).toBeGreaterThan(10);
    expect(LegacyRouteConverter.tryConvert('*')).toBe('{*path}');
  });
});

describe('the order the config routes are mounted in', () => {
  it('keeps the named ones ahead of the parametrised one', () => {
    const order = routesOf(ConfigController);
    expect(order.indexOf('GET /-/config/history')).toBeLessThan(
      order.indexOf('GET /-/config/:section'),
    );
    expect(order.indexOf('GET /-/config/environment')).toBeLessThan(
      order.indexOf('GET /-/config/:section'),
    );
    expect(order.indexOf('GET /-/config/download')).toBeLessThan(
      order.indexOf('GET /-/config/:section'),
    );
    expect(order.indexOf('GET /-/config/backup')).toBeLessThan(
      order.indexOf('GET /-/config/:section'),
    );
    expect(order.indexOf('POST /-/config/restore')).toBeLessThan(
      order.indexOf('POST /-/config/:section'),
    );
    expect(order.indexOf('GET /-/config/:section/:member')).toBeLessThan(
      order.indexOf('GET /-/config/:section'),
    );
    expect(order.indexOf('GET /-/config/preview/:template')).toBeLessThan(
      order.indexOf('GET /-/config/:section/:member'),
    );
    expect(order.indexOf('GET /-/config/brand/:hash')).toBeLessThan(
      order.indexOf('GET /-/config/:section/:member'),
    );
    expect(order.indexOf('GET /-/config/:section/:member/:entry')).toBeLessThan(
      order.indexOf('GET /-/config/:section/:member'),
    );
    expect(order.indexOf('POST /-/config/:section/:member/:entry')).toBeLessThan(
      order.indexOf('POST /-/config/:section/:member'),
    );
    expect(order.indexOf('POST /-/config/:section/:member')).toBeLessThan(
      order.indexOf('POST /-/config/:section'),
    );
  });
});

describe('a route that says it has two representations', () => {
  const both = Object.entries(CONTRACT).flatMap(([route, contract]) =>
    'both' in contract ? [[route, contract.both] as const] : [],
  );

  it.each(both)('serves %s as a page and as JSON', async (_route, url) => {
    const asPage = await request(app.getHttpServer())
      .get(url)
      .set('Cookie', admin)
      .set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    const asJson = await request(app.getHttpServer())
      .get(url)
      .set('Cookie', admin)
      .set('Accept', 'application/json');

    expect(asPage.headers['content-type']).toMatch(/text\/html/);
    expect(asJson.headers['content-type']).toMatch(/application\/json/);
    expect(asJson.status).toBe(asPage.status);
    expect(asPage.status).toBe(200);
    expect(String(asPage.headers['vary'])).toMatch(/accept/i);
    expect(String(asJson.headers['vary'])).toMatch(/accept/i);
  });
});

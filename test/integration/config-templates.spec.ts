import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { ConfigService } from '../../src/config/config.service';
import { INSTANCE_CONFIG_PATH_ENV } from '../../src/config/loader';
import { loadInstanceConfigFromFile } from '../../src/config/parser';
import { closeSequelize } from '../../src/db/sequelize';
import { stylesheetUrl, templateNames } from '../../src/content-reader/assets.controller';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

let app: INestApplication;
let harness: Harness;
let ops: string;
let alice: string;

const TEMPLATES = templateNames();

beforeAll(async () => {
  harness = await createHarness();
  app = await bootTestApp();
  ops = await sessionCookieFor(harness.tenantId, 'ops');
  alice = await sessionCookieFor(harness.tenantId, 'alice');
});

afterAll(async () => {
  await app?.close();
  await harness?.close();
  await closeSequelize();
});

const get = (url: string, cookie?: string) => {
  const req = request(app.getHttpServer()).get(url);
  return cookie ? req.set('cookie', cookie) : req;
};

describe('the gallery', () => {
  it('offers every template the build produced, each framing its own preview', async () => {
    const page = await get('/-/config/branding', ops).expect(200);

    expect(TEMPLATES.length).toBeGreaterThan(1);
    for (const template of TEMPLATES) {
      expect(page.text).toContain(`value="${template}"`);
      expect(page.text).toContain(`src="/-/config/preview/${template}"`);
    }
    expect((page.text.match(/<iframe\b/g) ?? []).length).toBe(TEMPLATES.length);
  });

  it('checks the template the instance is actually running', async () => {
    const page = await get('/-/config/branding', ops).expect(200);
    const checked = [...page.text.matchAll(/<input\s+type="radio"[^>]*>/g)].filter((m) =>
      /\schecked\b/.test(m[0]),
    );
    expect(checked).toHaveLength(1);
    expect(checked[0][0]).toContain('value="default"');
  });
});

describe('the operational surface', () => {
  let dressed: INestApplication;
  let dir: string;
  const other = TEMPLATES.find((t) => t !== 'default') as string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'speicher-templates-'));
    const path = join(dir, 'instance.yaml');
    writeFileSync(
      path,
      readFileSync(process.env[INSTANCE_CONFIG_PATH_ENV] as string, 'utf8') +
        `\nbrand:\n  name: Acme Engineering Docs\n` +
        `\ntheme:\n  template: ${other}\n  font: serif\n  palette:\n    light:\n      accent: '#8a4b2f'\n`,
      'utf8',
    );
    dressed = await bootTestApp(new ConfigService(loadInstanceConfigFromFile(path)));
  });

  afterAll(async () => {
    await dressed?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const from = (url: string) =>
    request(dressed.getHttpServer()).get(url).set('cookie', ops).expect(200);

  it('gives a reader the template and the palette the instance chose', async () => {
    const reader = await from('/');
    expect(reader.text).toContain(`href="${stylesheetUrl(other)}"`);
    expect(reader.text).toContain('--spr-accent:#8a4b2f');
    expect(reader.text).toContain('--spr-font-body:Georgia');
  });

  it('gives an operator both too, on every page under /-/', async () => {
    for (const url of ['/-/status', '/-/config/branding', '/-/config/branding/appearance']) {
      const page = await from(url);
      expect(page.text).toContain(`href="${stylesheetUrl(other)}"`);
      expect(page.text).toContain('--spr-accent:#8a4b2f');
      expect(page.text).toContain('--spr-font-body:Georgia');
    }
  });

  it('still says whose instance it is', async () => {
    const page = await from('/-/status');
    expect(page.text).toContain('Acme Engineering Docs');
  });

  it('keeps drawing the previews in what the instance chose', async () => {
    const preview = await from(`/-/config/preview/${other}`);
    expect(preview.text).toContain(`href="${stylesheetUrl(other)}"`);
    expect(preview.text).toContain('--spr-accent:#8a4b2f');
  });
});

describe('the preview', () => {
  it('renders the template it was asked for, not the one in force', async () => {
    const other = TEMPLATES.find((t) => t !== 'default') as string;
    const page = await get(`/-/config/preview/${other}`, ops).expect(200);

    expect(page.text).toContain(`href="${stylesheetUrl(other)}"`);
    expect(page.text).not.toContain(`href="${stylesheetUrl('default')}"`);
  });

  it('is a fixed sample, carrying nothing of this instance but its brand', async () => {
    const page = await get('/-/config/preview/default', ops).expect(200);

    expect(page.text).toContain('Working with repositories');
    expect(page.text).toContain('spr-callout');
    expect(page.text).toMatch(/class="spr-tok-/);
    expect(page.text).not.toContain('/handbook/');
    expect(page.text).not.toContain('/fieldkit/');
  });

  it('404s a name the build did not produce, rather than falling back', async () => {
    await get('/-/config/preview/nonsense', ops).expect(404);
  });

  it('404s for a maintainer and for an anonymous caller, never 403', async () => {
    await get('/-/config/preview/default', alice).expect(404);
    await get('/-/config/preview/default').expect(404);
  });
});

describe('the framing directives', () => {
  const csp = (res: request.Response) => String(res.headers['content-security-policy']);

  it('are opened by the gallery page and by the preview, and by nothing else', async () => {
    const gallery = await get('/-/config/branding', ops).expect(200);
    const preview = await get('/-/config/preview/default', ops).expect(200);

    expect(csp(gallery)).toContain("frame-src 'self'");
    expect(csp(gallery)).toContain("frame-ancestors 'none'");
    expect(csp(preview)).toContain("frame-ancestors 'self'");
    expect(csp(preview)).toContain("frame-src 'none'");
    expect(preview.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(gallery.headers['x-frame-options']).toBe('DENY');
  });

  it('stay shut on every other page', async () => {
    for (const [url, cookie] of [
      ['/-/config/identity', ops],
      ['/-/config', ops],
      ['/', ops],
    ] as const) {
      const res = await get(url, cookie).expect(200);
      expect(csp(res)).toContain("frame-src 'none'");
      expect(csp(res)).toContain("frame-ancestors 'none'");
      expect(res.headers['x-frame-options']).toBe('DENY');
    }
  });
});

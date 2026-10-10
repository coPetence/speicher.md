/**
 * Handing a large asset to the store instead of serving it
 *
 * The asset row is a real one, ingested from the handbook fixture, so the authz
 * it is subject to is the real thing. Its mime and size are rewritten per case,
 * because the fixtures hold only small images and the rule under test turns on
 * exactly those two columns
 */

import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import request from 'supertest';
import { QueryTypes } from 'sequelize';

import { createS3BlobStore } from '../../src/assets/s3-blob-store';
import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfigFromFile } from '../../src/config/parser';
import { AssetsConfig } from '../../src/config/types';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

const S3_URL = process.env.S3_ENDPOINT_URL ?? 'http://127.0.0.1:51001';
const CHART = 'commercial/images/chart.jpg';
const OVER = 1024;

let harness: Harness;
let app: INestApplication;
let bob: string;
let bucket: string;
let contentHash: string;

const credentials = { accessKeyId: 'speicher', secretAccessKey: 'speicher-secret' };

function assetsConfig(): AssetsConfig {
  return {
    driver: 's3',
    bucket,
    region: 'us-east-1',
    access_key_id: credentials.accessKeyId,
    secret_access_key: credentials.secretAccessKey,
    endpoint: S3_URL,
    presign_over_bytes: OVER,
    presign_ttl: '60s',
  };
}

/**
 * The config the harness itself runs on, with only the asset store swapped
 *
 * It has to be that one: who may read the chart is decided by the fixture's
 * grants together with this document's groups, and a config invented here would
 * answer a different question
 */
function configWithStore(): ConfigService {
  const loaded = loadInstanceConfigFromFile(process.env.SPEICHER_CONFIG as string);
  return new ConfigService({ ...loaded, raw: { ...loaded.raw, assets: assetsConfig() } });
}

const describeAsset = (mime: string, sizeBytes: number) =>
  getSequelize().query(
    `UPDATE assets SET mime = :mime, size_bytes = :sizeBytes
      WHERE repo_id = :repoId AND slug_path = :slugPath`,
    {
      type: QueryTypes.UPDATE,
      replacements: { mime, sizeBytes, repoId: harness.repos.handbook, slugPath: CHART },
    },
  );

beforeAll(async () => {
  harness = await createHarness();
  bob = await sessionCookieFor(harness.tenantId, 'bob');

  const admin = new S3Client({
    region: 'us-east-1',
    endpoint: S3_URL,
    forcePathStyle: true,
    credentials,
  });
  bucket = `spr-presign-${randomUUID()}`;
  await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  admin.destroy();

  // The row the fixture ingested, whose bytes the harness put on a volume; the
  // same hash is written into the bucket so the proxied cases can answer too
  const [row] = await getSequelize().query<{ content_hash: string }>(
    `SELECT content_hash FROM assets WHERE repo_id = :repoId AND slug_path = :slugPath`,
    {
      type: QueryTypes.SELECT,
      replacements: { repoId: harness.repos.handbook, slugPath: CHART },
    },
  );
  contentHash = row.content_hash;

  const store = createS3BlobStore(assetsConfig());
  await store.put(harness.repos.handbook, contentHash, { bytes: Buffer.from('the chart bytes') });
  await store.close();

  app = await bootTestApp(configWithStore());
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.close();
  await closeSequelize();
});

const getChart = () =>
  request(app.getHttpServer())
    .get(`/handbook/${CHART}`)
    .set('Cookie', bob)
    .redirects(0)
    // These answers are binary, so superagent only collects a body when asked
    .buffer(true);

const bodyOf = (res: { body: Buffer }) => Buffer.from(res.body).toString();

describe('an asset above the pre-signing threshold', () => {
  it('is handed to the store, so its bytes never pass through here', async () => {
    await describeAsset('application/pdf', OVER * 10);
    const res = await getChart();

    expect(res.status).toBe(302);
    expect(res.headers['location']).toContain(bucket);
    expect(res.headers['location']).toContain('X-Amz-Signature');
  });

  it('tells every cache not to keep the redirect, which outlives its own URL', async () => {
    await describeAsset('application/pdf', OVER * 10);
    const res = await getChart();

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['vary']).toContain('Cookie');
    // An ETag would invite a revalidation against a URL that has expired
    expect(res.headers['etag']).toBeUndefined();
  });

  it('asks the store for the type and name the row carries, not the stored ones', async () => {
    await describeAsset('application/pdf', OVER * 10);
    const location = new URL((await getChart()).headers['location']);

    expect(location.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(location.searchParams.get('response-content-disposition')).toContain('chart.jpg');
  });

  it('answers a revalidation itself rather than redirecting to a URL to discard', async () => {
    await describeAsset('application/pdf', OVER * 10);
    const res = await request(app.getHttpServer())
      .get(`/handbook/${CHART}`)
      .set('Cookie', bob)
      .set('If-None-Match', `"${contentHash}"`)
      .redirects(0);

    expect(res.status).toBe(304);
  });

  it('is still refused to a reader who may not see it, before any URL is signed', async () => {
    await describeAsset('application/pdf', OVER * 10);
    const res = await request(app.getHttpServer()).get(`/handbook/${CHART}`).redirects(0);

    expect(res.status).toBe(404);
    expect(res.headers['location']).toBeUndefined();
  });
});

describe('an asset the rule leaves alone', () => {
  it('serves an image itself however large, since a page is waiting on it', async () => {
    await describeAsset('image/jpeg', OVER * 10);
    const res = await getChart();

    expect(res.status).toBe(200);
    expect(bodyOf(res)).toBe('the chart bytes');
  });

  it('serves anything under the threshold', async () => {
    await describeAsset('application/pdf', OVER - 1);
    const res = await getChart();

    expect(res.status).toBe(200);
    expect(bodyOf(res)).toBe('the chart bytes');
  });
});

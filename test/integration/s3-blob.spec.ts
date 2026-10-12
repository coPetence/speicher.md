import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { blobKey } from '../../src/assets/blob-store';
import {
  BUCKET_FAIL_LABEL,
  BUCKET_OK_LABEL,
  S3BlobStore,
  createS3BlobStore,
  resolveS3Options,
  usesPathStyle,
} from '../../src/assets/s3-blob-store';
import { AssetsConfig } from '../../src/config/types';

const ACCESS_KEY_ID = 'speicher';
const SECRET_ACCESS_KEY = 'speicher-secret';
const REGION = 'us-east-1';

const S3_URL = process.env.S3_ENDPOINT_URL ?? 'http://127.0.0.1:51001';

function assetsConfig(bucket: string, overrides: Partial<AssetsConfig> = {}): AssetsConfig {
  return {
    driver: 's3',
    bucket,
    region: REGION,
    access_key_id: ACCESS_KEY_ID,
    secret_access_key: SECRET_ACCESS_KEY,
    endpoint: S3_URL,
    ...overrides,
  };
}

const service = new S3Client({
  region: REGION,
  endpoint: S3_URL,
  forcePathStyle: true,
  credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
});

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

afterAll(() => {
  service.destroy();
});

async function freshBucket(): Promise<string> {
  const name = `spr-test-${randomUUID()}`;
  await service.send(new CreateBucketCommand({ Bucket: name }));
  return name;
}

beforeAll(async () => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(`${S3_URL}/minio/health/live`);
      if (response.ok) return;
      throw new Error(`health returned ${response.status}`);
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(
          `no s3 emulator at ${S3_URL} after 30s — run "npm run db:up", which ` +
            `starts MinIO beside Postgres (${String(error)})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}, 40_000);

describe('the s3 blob driver', () => {
  let bucket: string;
  let store: S3BlobStore;

  // Every store built here is closed again: the client pools sockets, and jest
  // hangs on to the handles otherwise
  const opened: S3BlobStore[] = [];
  const openStore = (config: AssetsConfig): S3BlobStore => {
    const made = createS3BlobStore(config);
    opened.push(made);
    return made;
  };

  beforeEach(async () => {
    bucket = await freshBucket();
    store = openStore(assetsConfig(bucket));
  });

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((each) => each.close()));
  });

  it('reports a blob absent before it is written and present after', async () => {
    const contentHash = hash('a diagram');
    expect(await store.exists('repo-a', contentHash)).toBe(false);

    await store.put('repo-a', contentHash, { bytes: Buffer.from('a diagram') });
    expect(await store.exists('repo-a', contentHash)).toBe(true);
  });

  it('round-trips bytes, and a file from disk, at the same key the filesystem uses', async () => {
    const contentHash = hash('from a path');
    const dir = await mkdtemp(join(tmpdir(), 'spr-s3-'));
    const path = join(dir, 'cover.png');
    await writeFile(path, 'from a path');

    await store.put('repo-a', contentHash, { path });

    expect((await store.get('repo-a', contentHash)).toString()).toBe('from a path');
    await expect(
      service.send(new HeadObjectCommand({ Bucket: bucket, Key: blobKey('repo-a', contentHash) })),
    ).resolves.toBeTruthy();
  });

  it('streams the same bytes it returns whole', async () => {
    const contentHash = hash('streamed');
    await store.put('repo-a', contentHash, { bytes: Buffer.from('streamed') });

    const chunks: Buffer[] = [];
    for await (const chunk of await store.stream('repo-a', contentHash)) {
      chunks.push(Buffer.from(chunk as Buffer));
    }
    expect(Buffer.concat(chunks).toString()).toBe('streamed');
  });

  it('stores bytes as octet-stream, whatever the asset is', async () => {
    const contentHash = hash('<script>alert(1)</script>');
    await store.put('repo-a', contentHash, { bytes: Buffer.from('<script>alert(1)</script>') });

    const properties = await service.send(
      new GetObjectCommand({ Bucket: bucket, Key: blobKey('repo-a', contentHash) }),
    );
    expect(properties.ContentType).toBe('application/octet-stream');
  });

  it('presigns a URL that serves the bytes without any credentials', async () => {
    const contentHash = hash('presigned');
    await store.put('repo-a', contentHash, { bytes: Buffer.from('presigned') });

    const url = await store.presign('repo-a', contentHash, {
      ttlSeconds: 60,
      filename: 'diagram.png',
      mime: 'image/png',
    });
    expect(url).not.toBeNull();

    // Fetched with no Authorization header at all: the signature is the whole claim
    const response = await fetch(url!);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('presigned');
    expect(response.headers.get('content-disposition')).toContain('diagram.png');
  });

  it('strips quotes from a filename so the disposition header cannot be escaped', async () => {
    const contentHash = hash('quoted');
    await store.put('repo-a', contentHash, { bytes: Buffer.from('quoted') });

    const url = await store.presign('repo-a', contentHash, {
      ttlSeconds: 60,
      filename: 'a"; attack="x.png',
      mime: 'image/png',
    });
    const disposition = new URL(url!).searchParams.get('response-content-disposition');

    expect(disposition).toBe('inline; filename="a; attack=x.png"');
  });

  it('signs the URL for exactly the lifetime it was asked for', async () => {
    const contentHash = hash('expiring');
    await store.put('repo-a', contentHash, { bytes: Buffer.from('expiring') });

    const query = new URL(
      (await store.presign('repo-a', contentHash, {
        ttlSeconds: 45,
        filename: 'f.png',
        mime: 'image/png',
      }))!,
    ).searchParams;

    expect(query.get('X-Amz-Expires')).toBe('45');
    expect(query.get('X-Amz-Signature')).toBeTruthy();
  });

  it('refuses a presigned URL once its lifetime is spent', async () => {
    const contentHash = hash('expiring');
    await store.put('repo-a', contentHash, { bytes: Buffer.from('expiring') });

    const url = await store.presign('repo-a', contentHash, {
      ttlSeconds: 1,
      filename: 'gone.png',
      mime: 'image/png',
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // The short TTL is the whole of the reader's protection once a URL is out:
    // nothing can revoke one, so expiry has to be what stops it
    expect((await fetch(url!)).status).toBe(403);
  });

  it('purges one repository and leaves the others alone', async () => {
    const keep = hash('keep');
    const drop = hash('drop');
    await store.put('repo-a', drop, { bytes: Buffer.from('drop') });
    await store.put('repo-b', keep, { bytes: Buffer.from('keep') });
    await store.put('repo-ab', keep, { bytes: Buffer.from('keep') });

    await store.purgeRepo('repo-a');

    expect(await store.exists('repo-a', drop)).toBe(false);
    expect(await store.exists('repo-b', keep)).toBe(true);
    // The prefix is `repo-a/`, so a repo whose id merely starts with it survives
    expect(await store.exists('repo-ab', keep)).toBe(true);
  });

  it('purges a repository with more assets than one delete batch', async () => {
    const hashes = Array.from({ length: 40 }, (_, i) => hash(`asset-${i}`));
    for (const contentHash of hashes) {
      await store.put('repo-many', contentHash, { bytes: Buffer.from(contentHash) });
    }

    await store.purgeRepo('repo-many');

    const present = await Promise.all(hashes.map((h) => store.exists('repo-many', h)));
    expect(present.filter(Boolean)).toEqual([]);
  });

  it('purges a repository that has nothing stored', async () => {
    await expect(store.purgeRepo('repo-never-synced')).resolves.toBeUndefined();
  });

  it('answers the settings page that the bucket is there, without writing to it', async () => {
    const status = await store.probe();
    expect(status.level).toBe('ok');
    expect(status.label).toBe(BUCKET_OK_LABEL);
    expect(status.detail).toContain(bucket);
  });

  it('says a missing bucket is missing, rather than throwing at the page', async () => {
    const name = `spr-absent-${randomUUID()}`;
    const status = await openStore(assetsConfig(name)).probe();

    expect(status.level).toBe('fail');
    expect(status.label).toBe(BUCKET_FAIL_LABEL);
    expect(status.detail).toContain(name);
    expect(status.detail).toContain('does not exist');
  });

  it('fails rather than creating a bucket that is not there', async () => {
    const absent = openStore(assetsConfig(`spr-absent-${randomUUID()}`));

    await expect(absent.get('repo-a', hash('nothing'))).rejects.toThrow();
    expect(await absent.exists('repo-a', hash('nothing'))).toBe(false);
  });
});

describe('the s3 driver configuration', () => {
  const base: AssetsConfig = {
    driver: 's3',
    bucket: 'a-bucket',
    region: REGION,
    access_key_id: ACCESS_KEY_ID,
    secret_access_key: SECRET_ACCESS_KEY,
  };

  it('accepts a bucket, a region and a key pair', () => {
    expect(resolveS3Options(base).bucket).toBe('a-bucket');
  });

  it.each([
    ['no endpoint, so real AWS', undefined, false],
    ['a self-hosted endpoint', 'http://minio:9000', true],
    ['a provider endpoint', 'https://fsn1.your-objectstorage.com', true],
    ['an AWS regional endpoint', 'https://s3.eu-central-1.amazonaws.com', false],
    ['the legacy AWS endpoint', 'https://s3.amazonaws.com', false],
    ['an AWS VPC endpoint', 'https://bucket.vpce-abc.s3.eu-central-1.vpce.amazonaws.com', false],
  ])('addresses %s the way that endpoint needs', (_name, endpoint, pathStyle) => {
    expect(usesPathStyle(endpoint)).toBe(pathStyle);
    expect(resolveS3Options({ ...base, endpoint }).path_style).toBe(pathStyle);
  });

  it('says which addressing it chose, so a 404 can be read', () => {
    const hosted = createS3BlobStore({ ...base, endpoint: 'http://minio:9000' });
    const aws = createS3BlobStore(base);

    expect(hosted.describe()).toContain('path-style');
    expect(aws.describe()).toContain('virtual-host style');
    return Promise.all([hosted.close(), aws.close()]);
  });

  it.each([
    ['bucket', 'assets.bucket'],
    ['region', 'assets.region'],
    ['access_key_id', 'assets.access_key_id'],
    ['secret_access_key', 'assets.secret_access_key'],
  ])('says %s is required when it is missing', (key, named) => {
    expect(() => resolveS3Options({ ...base, [key]: undefined })).toThrow(named);
  });

  it('lists every problem at once, so one save answers all of them', () => {
    try {
      resolveS3Options({ driver: 's3' });
      throw new Error('expected resolveS3Options to throw');
    } catch (err) {
      expect((err as { problems: string[] }).problems).toHaveLength(4);
    }
  });
});

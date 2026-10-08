import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';

import {
  AzureBlobStore,
  CONTAINER_FAIL_LABEL,
  CONTAINER_OK_LABEL,
  createAzureBlobStore,
} from '../../src/assets/azure-blob-store';
import { blobKey } from '../../src/assets/blob-store';
import { AssetsConfig } from '../../src/config/types';

const ACCOUNT = 'devstoreaccount1';
const ACCOUNT_KEY =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

const BLOB_URL = process.env.AZURITE_BLOB_URL ?? `http://127.0.0.1:51000/${ACCOUNT}`;

const CONNECTION_STRING =
  `DefaultEndpointsProtocol=http;AccountName=${ACCOUNT};AccountKey=${ACCOUNT_KEY};` +
  `BlobEndpoint=${BLOB_URL};`;

function assetsConfig(container: string, overrides: Partial<AssetsConfig> = {}): AssetsConfig {
  return {
    driver: 'azure',
    account: ACCOUNT,
    container,
    auth: 'key',
    account_key: ACCOUNT_KEY,
    endpoint: BLOB_URL,
    ...overrides,
  };
}

const service = new BlobServiceClient(
  BLOB_URL,
  new StorageSharedKeyCredential(ACCOUNT, ACCOUNT_KEY),
);

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

async function freshContainer(): Promise<string> {
  const name = `spr-test-${randomUUID()}`;
  await service.getContainerClient(name).create();
  return name;
}

beforeAll(async () => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await service.getProperties();
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(
          `no blob emulator at ${BLOB_URL} after 30s — run "npm run db:up", which ` +
            `starts Azurite beside Postgres (${String(error)})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}, 40_000);

describe('the azure blob driver', () => {
  let container: string;
  let store: AzureBlobStore;

  beforeEach(async () => {
    container = await freshContainer();
    store = createAzureBlobStore(assetsConfig(container));
  });

  it('reports a blob absent before it is written and present after', async () => {
    const contentHash = hash('a diagram');
    expect(await store.exists('repo-a', contentHash)).toBe(false);

    await store.put('repo-a', contentHash, { bytes: Buffer.from('a diagram') });
    expect(await store.exists('repo-a', contentHash)).toBe(true);
  });

  it('round-trips bytes, and a file from disk, at the same key the filesystem uses', async () => {
    const contentHash = hash('from a path');
    const dir = await mkdtemp(join(tmpdir(), 'spr-azure-'));
    const path = join(dir, 'cover.png');
    await writeFile(path, 'from a path');

    await store.put('repo-a', contentHash, { path });

    expect((await store.get('repo-a', contentHash)).toString()).toBe('from a path');
    const blob = service
      .getContainerClient(container)
      .getBlobClient(blobKey('repo-a', contentHash));
    expect(await blob.exists()).toBe(true);
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

    const properties = await service
      .getContainerClient(container)
      .getBlobClient(blobKey('repo-a', contentHash))
      .getProperties();
    expect(properties.contentType).toBe('application/octet-stream');
  });

  it('never presigns, so every asset stays proxied', async () => {
    expect(await store.presign()).toBeNull();
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

  it('reads back what a connection string wrote, since both name one account', async () => {
    const contentHash = hash('either way');
    const viaKey = createAzureBlobStore(assetsConfig(container));
    const viaConnectionString = createAzureBlobStore(
      assetsConfig(container, {
        auth: 'connection_string',
        connection_string: CONNECTION_STRING,
        account_key: undefined,
      }),
    );

    await viaConnectionString.put('repo-a', contentHash, { bytes: Buffer.from('either way') });
    expect((await viaKey.get('repo-a', contentHash)).toString()).toBe('either way');
  });

  it('answers the settings page that the container is there, without writing to it', async () => {
    const status = await store.probe();
    expect(status.level).toBe('ok');
    expect(status.label).toBe(CONTAINER_OK_LABEL);
    expect(status.detail).toContain(container);
  });

  it('says a missing container is missing, rather than throwing at the page', async () => {
    const name = `spr-absent-${randomUUID()}`;
    const status = await createAzureBlobStore(assetsConfig(name)).probe();

    expect(status.level).toBe('fail');
    expect(status.label).toBe(CONTAINER_FAIL_LABEL);
    expect(status.detail).toContain(name);
    expect(status.detail).toContain('never creates it');
  });

  it('fails rather than creating a container that is not there', async () => {
    const absent = createAzureBlobStore(assetsConfig(`spr-absent-${randomUUID()}`));
    await expect(absent.get('repo-a', hash('nothing'))).rejects.toThrow();
    expect(await absent.exists('repo-a', hash('nothing'))).toBe(false);
  });
});

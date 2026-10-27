/**
 * Blob (binary large object) storage abstraction
 *
 * Three drivers: filesystem, S3, Azure Blob
 * The config lives under `assets.*` in config files
 *
 * Files are stored as `${repoId}/${hash[:2]}/${hash}`, local or in a bucket
 * A filesystem file is written to a temp name then atomically renamed so a
 * concurrent read never sees a half-written blob
 *
 * Not exposed to the network -- the asset middleware reads through the database
 */

import { constants, createReadStream, promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';

import { ConfigService } from '../config/config.service';
import { AssetsConfig } from '../config/types';
import { createAzureBlobStore } from './azure-blob-store';
import { createS3BlobStore } from './s3-blob-store';
import { reasonOf } from '../common/errors';
import { CheckStatus } from '../common/check-status';

/** What the check of an asset store found: the directory, container or bucket */
export type StoreCode =
  | 'store.reachable'
  | 'store.missing'
  | 'store.read-only'
  | 'store.refused'
  | 'store.unreachable'
  | 'store.not-configured'
  | 'store.presign-unavailable';

export type StoreStatus = CheckStatus<StoreCode> & { level: 'ok' | 'fail' };

export const DIRECTORY_OK_LABEL = 'Directory writable';
export const DIRECTORY_FAIL_LABEL = 'Directory inaccessible';

export interface PresignRequest {
  ttlSeconds: number;

  // Goes in the store's Content-Disposition, so a download keeps its name
  filename: string;

  // The type from the asset row. The stored object is octet-stream, and the
  // store answers with that unless the signature overrides it
  mime: string;
}

export interface BlobStore {
  readonly kind: 'filesystem' | 's3' | 'azure';

  probe(): Promise<StoreStatus>;

  exists(repoId: string, contentHash: string): Promise<boolean>;
  put(
    repoId: string,
    contentHash: string,
    source: { path?: string; bytes?: Buffer },
  ): Promise<void>;
  get(repoId: string, contentHash: string): Promise<Buffer>;
  stream(repoId: string, contentHash: string): Promise<Readable>;

  presign(repoId: string, contentHash: string, request: PresignRequest): Promise<string | null>;
  purgeRepo(repoId: string): Promise<void>;
  close?(): Promise<void>;
}

export function blobKey(repoId: string, contentHash: string): string {
  // Two-char prefix directory: avoids thousands of files in one dir
  return `${repoId}/${contentHash.slice(0, 2)}/${contentHash}`;
}

export class FilesystemBlobStore implements BlobStore {
  readonly kind = 'filesystem' as const;

  constructor(private readonly root: string) {}

  private pathFor(repoId: string, contentHash: string): string {
    return join(resolve(this.root), blobKey(repoId, contentHash));
  }

  async exists(repoId: string, contentHash: string): Promise<boolean> {
    try {
      await fs.access(this.pathFor(repoId, contentHash));
      return true;
    } catch {
      return false;
    }
  }

  async put(
    repoId: string,
    contentHash: string,
    source: { path?: string; bytes?: Buffer },
  ): Promise<void> {
    const target = this.pathFor(repoId, contentHash);
    await fs.mkdir(dirname(target), { recursive: true });

    // Write to temp on same volume then atomic rename
    const temp = `${target}.${process.pid}.tmp`;
    if (source.bytes) await fs.writeFile(temp, source.bytes);
    else if (source.path) await fs.copyFile(source.path, temp);
    else throw new Error('put() needs either bytes or a path');
    await fs.rename(temp, target);
  }

  async get(repoId: string, contentHash: string): Promise<Buffer> {
    return fs.readFile(this.pathFor(repoId, contentHash));
  }

  async stream(repoId: string, contentHash: string): Promise<Readable> {
    return createReadStream(this.pathFor(repoId, contentHash));
  }

  async presign(): Promise<string | null> {
    // Filesystem blobs are served through the asset middleware, not direct URLs
    return null;
  }

  async probe(): Promise<StoreStatus> {
    const root = resolve(this.root);
    try {
      await fs.access(root, constants.W_OK);
      return {
        code: 'store.reachable',
        level: 'ok',
        label: DIRECTORY_OK_LABEL,
        detail: root,
        facts: { target: root },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      return {
        code:
          code === 'ENOENT'
            ? 'store.missing'
            : code === 'EACCES'
              ? 'store.read-only'
              : 'store.unreachable',
        level: 'fail',
        label: DIRECTORY_FAIL_LABEL,
        facts: { target: root },
        detail:
          code === 'ENOENT'
            ? `${root} does not exist.`
            : code === 'EACCES'
              ? `${root} is not writable by this process.`
              : `${root} could not be reached (${reasonOf(err)})`,
      };
    }
  }

  async purgeRepo(repoId: string): Promise<void> {
    await fs.rm(join(resolve(this.root), repoId), { recursive: true, force: true });
  }
}

export function createBlobStore(assets: AssetsConfig): BlobStore {
  switch (assets.driver) {
    case 'filesystem':
      return new FilesystemBlobStore(assets.path ?? './var/assets');
    case 's3':
      return createS3BlobStore(assets);
    case 'azure':
      return createAzureBlobStore(assets);
    default:
      throw new Error(`unknown assets.driver ${JSON.stringify(assets.driver)}`);
  }
}

export function blobStoreFor(config: ConfigService): BlobStore {
  return createBlobStore(config.assets);
}

export class BlobCache {
  private readonly map = new Map<string, Buffer>();

  constructor(
    private readonly maxEntries = 256,
    private readonly maxBytes = 32 * 1024 * 1024,
  ) {}

  private bytes = 0;

  get(key: string): Buffer | undefined {
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;

    // Bump to most-recently-used position
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(key: string, value: Buffer): void {
    // Reject values larger than a quarter of the budget: too big to cache
    if (value.byteLength > this.maxBytes / 4) return;
    if (this.map.has(key)) this.bytes -= this.map.get(key)!.byteLength;
    this.map.set(key, value);
    this.bytes += value.byteLength;
    // Evict oldest until within both limits
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.bytes -= this.map.get(oldest.value)!.byteLength;
      this.map.delete(oldest.value);
    }
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
}

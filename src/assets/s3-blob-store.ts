import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { ConfigError, reasonOf } from '../common/errors';
import { Logger, rootLogger } from '../common/logger';
import { AssetsConfig } from '../config/types';
import { BlobStore, PresignRequest, StoreStatus, blobKey } from './blob-store';
import { problem } from '../common/config-problems';

/** Resolved S3 options */
export interface S3BlobStoreOptions {
  bucket: string;
  region: string;
  access_key_id: string;
  secret_access_key: string;

  // Custom endpoint for S3-compatible providers
  endpoint?: string;

  // Derived from endpoint by usesPathStyle
  path_style: boolean;
}

export interface S3BlobStoreDeps {
  /** Inject a client for network-free tests */
  client?: S3Client;
}

// S3 deletion limit per request
const DELETE_BATCH = 1000;

const PROBE_TIMEOUT_MS = 3_000;

export const BUCKET_OK_LABEL = 'Bucket accessible';
export const BUCKET_FAIL_LABEL = 'Not connected to the bucket';

/** Extract the SDK error's HTTP status */
function statusOf(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

/** Detect missing objects, including HeadObject's code-less 404 */
function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'NotFound' || name === 'NoSuchKey' || statusOf(err) === 404;
}

/** Blob storage in a single S3 bucket */
export class S3BlobStore implements BlobStore {
  readonly kind = 's3' as const;

  private readonly log: Logger = rootLogger.child('assets');

  constructor(
    private readonly client: S3Client,

    private readonly bucket: string,

    private readonly description: string,
  ) {}

  describe(): string {
    return this.description;
  }

  async exists(repoId: string, contentHash: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: blobKey(repoId, contentHash) }),
      );
      return true;
    } catch (err) {
      // Return false only for missing objects
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async put(
    repoId: string,
    contentHash: string,
    source: { path?: string; bytes?: Buffer },
  ): Promise<void> {
    const common = {
      Bucket: this.bucket,
      Key: blobKey(repoId, contentHash),
      // The app controls access and the served content type
      ContentType: 'application/octet-stream',
    };

    if (source.bytes) {
      await this.client.send(new PutObjectCommand({ ...common, Body: source.bytes }));
      return;
    }
    if (source.path) {
      // Supply the size to avoid buffering the stream
      const { size } = await stat(source.path);
      await this.client.send(
        new PutObjectCommand({
          ...common,
          Body: createReadStream(source.path),
          ContentLength: size,
        }),
      );
      return;
    }
    throw new Error('put() needs either bytes or a path');
  }

  async get(repoId: string, contentHash: string): Promise<Buffer> {
    const key = blobKey(repoId, contentHash);
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!response.Body) throw new Error(`s3 object ${key} returned no body`);
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async stream(repoId: string, contentHash: string): Promise<Readable> {
    const key = blobKey(repoId, contentHash);
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!response.Body) throw new Error(`s3 object ${key} returned no stream`);
    return response.Body as Readable;
  }

  /** Create a temporary URL for direct browser access */
  async presign(
    repoId: string,
    contentHash: string,
    request: PresignRequest,
  ): Promise<string | null> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: blobKey(repoId, contentHash),
      // Strip characters that affect header quoting
      ResponseContentDisposition: `inline; filename="${request.filename.replace(/["\\]/g, '')}"`,
      // Override the stored octet-stream type
      ResponseContentType: request.mime,
    });
    return getSignedUrl(this.client, command, { expiresIn: request.ttlSeconds });
  }

  /** Check bucket access with a timeout */
  async probe(): Promise<StoreStatus> {
    const abortSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal });
      return {
        code: 'store.reachable',
        level: 'ok',
        label: BUCKET_OK_LABEL,
        detail: this.description,
        facts: { target: this.bucket },
      };
    } catch (err) {
      const status = statusOf(err);
      return {
        code:
          status === 404 ? 'store.missing' : status === 403 ? 'store.refused' : 'store.unreachable',
        level: 'fail',
        label: BUCKET_FAIL_LABEL,
        detail: this.failureDetail(err),
        facts: { target: this.bucket },
      };
    }
  }

  /** Describe the bucket access failure */
  private failureDetail(err: unknown): string {
    const status = statusOf(err);
    if (status === 404) {
      return `${this.description} does not exist. Make sure to create it before.`;
    }
    if (status === 403) {
      return `${this.description} refused these credentials. Make sure it has s3:ListBucket permission.`;
    }
    return `${this.description} (${reasonOf(err)})`;
  }

  /** Release pooled client sockets */
  async close(): Promise<void> {
    this.client.destroy();
  }

  /** Delete all objects under the repository prefix */
  async purgeRepo(repoId: string): Promise<void> {
    const prefix = `${repoId}/`;
    let continuationToken: string | undefined;
    let deleted = 0;

    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
          MaxKeys: DELETE_BATCH,
        }),
      );

      const keys = (listed.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => Boolean(key));

      if (keys.length) {
        const response = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );

        const failures = response.Errors ?? [];
        if (failures.length) {
          throw new Error(
            `purging repository ${repoId} left ${failures.length} object(s) behind: ` +
              failures
                .slice(0, 3)
                .map((failure) => `${failure.Key} (${failure.Code})`)
                .join(', '),
          );
        }
        deleted += keys.length;
      }

      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);

    this.log.info('purged repository blobs', { repo_id: repoId, deleted });
  }
}

export function createS3BlobStore(assets: AssetsConfig, deps: S3BlobStoreDeps = {}): S3BlobStore {
  const options = resolveS3Options(assets);
  const client = deps.client ?? clientFor(options);
  const description =
    `bucket "${options.bucket}" in region "${options.region}" ` +
    `(${options.endpoint ?? 'aws'}, ${options.path_style ? 'path-style' : 'virtual-host style'})`;

  rootLogger.child('assets').info('s3 blob store configured', { store: description });

  return new S3BlobStore(client, options.bucket, description);
}

/** Use path-style addressing for non-AWS endpoints */
export function usesPathStyle(endpoint: string | undefined): boolean {
  if (!endpoint) return false;
  try {
    const host = new URL(endpoint).hostname;
    return host !== 'amazonaws.com' && !host.endsWith('.amazonaws.com');
  } catch {
    // Invalid endpoints are rejected later
    return true;
  }
}

/** Validate and resolve S3 options */
export function resolveS3Options(assets: AssetsConfig): S3BlobStoreOptions {
  const problems = (['bucket', 'region', 'access_key_id', 'secret_access_key'] as const)
    .filter((key) => !assets[key])
    .map((key) =>
      problem('assets.key-missing', `assets.${key}`, {
        text: 'is required for the s3 driver',
        dashboard: 'S3 storage needs this.',
      }),
    );
  if (problems.length) {
    throw new ConfigError(
      problem('assets.misconfigured', null, {
        text: 'the s3 assets driver is misconfigured',
        dashboard: 'This storage is not fully set up.',
      }),
      problems,
    );
  }

  return {
    bucket: assets.bucket!,
    region: assets.region!,
    access_key_id: assets.access_key_id!,
    secret_access_key: assets.secret_access_key!,
    endpoint: assets.endpoint,
    path_style: usesPathStyle(assets.endpoint),
  };
}

function clientFor(options: S3BlobStoreOptions): S3Client {
  return new S3Client({
    region: options.region,
    endpoint: options.endpoint,
    forcePathStyle: options.path_style,
    credentials: {
      accessKeyId: options.access_key_id,
      secretAccessKey: options.secret_access_key,
    },

    // Avoid optional checksums and aws-chunked uploads rejected by Hetzner and older MinIO
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

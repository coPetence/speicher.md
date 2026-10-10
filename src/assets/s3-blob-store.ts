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

/** Resolved options for the s3 driver */
export interface S3BlobStoreOptions {
  bucket: string;
  region: string;
  access_key_id: string;
  secret_access_key: string;

  // Overrides the AWS endpoint, for providers like Hetzner or MinIO
  endpoint?: string;

  // Derived from the endpoint, never configured; see `usesPathStyle`
  path_style: boolean;
}

export interface S3BlobStoreDeps {
  /** Overrides client construction so tests can answer without a network */
  client?: S3Client;
}

// S3 accepts at most this many keys in one DeleteObjects call
const DELETE_BATCH = 1000;

const PROBE_TIMEOUT_MS = 3_000; // How long probe waits on the bucket

export const BUCKET_OK_LABEL = 'Bucket accessible';
export const BUCKET_FAIL_LABEL = 'Not connected to the bucket';

/** HTTP status of a failed SDK call, when it carries one */
function statusOf(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

/**
 * Whether a failure means the object is not there
 *
 * HeadObject answers a bare 404 with no body, so the SDK has no error code to
 * name it by and the status is the only signal
 */
function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'NotFound' || name === 'NoSuchKey' || statusOf(err) === 404;
}

/** BlobStore backed by one S3 bucket */
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
      // Absent is an answer; anything else is a fault the caller should see
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
      // Whatever the asset is, it is served by this app behind an authz check and
      // never by the bucket, so the stored type says only "bytes"
      ContentType: 'application/octet-stream',
    };

    if (source.bytes) {
      await this.client.send(new PutObjectCommand({ ...common, Body: source.bytes }));
      return;
    }
    if (source.path) {
      // A stream without a length makes the SDK buffer the whole body to find one,
      // so the size is read off the file instead
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

  /**
   * A short-lived URL the browser can fetch straight from the bucket
   */
  async presign(
    repoId: string,
    contentHash: string,
    request: PresignRequest,
  ): Promise<string | null> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: blobKey(repoId, contentHash),
      // Quotes and backslashes would end the header's quoted string early
      ResponseContentDisposition: `inline; filename="${request.filename.replace(/["\\]/g, '')}"`,
      // Without this the bucket answers octet-stream, which is how it is stored
      ResponseContentType: request.mime,
    });
    return getSignedUrl(this.client, command, { expiresIn: request.ttlSeconds });
  }

  /** Checks the bucket with a timeout, telling an absent bucket from a refused one */
  async probe(): Promise<StoreStatus> {
    const abortSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal });
      return { level: 'ok', label: BUCKET_OK_LABEL, detail: this.description };
    } catch (err) {
      return { level: 'fail', label: BUCKET_FAIL_LABEL, detail: this.failureDetail(err) };
    }
  }

  /**
   * Why a probe failed, in the terms the operator can act on
   *
   * The three cases need different fixes -- make the bucket, widen the policy, or
   * look at the endpoint -- and a bare SDK message names none of them
   */
  private failureDetail(err: unknown): string {
    const status = statusOf(err);
    if (status === 404) {
      return (
        `${this.description} is not there. This instance never creates it, and a ` +
        `provider wanting the other addressing style answers the same way.`
      );
    }
    if (status === 403) {
      return `${this.description} refused these credentials. They may lack s3:ListBucket on it.`;
    }
    return `${this.description} (${reasonOf(err)})`;
  }

  /** Releases the client's pooled sockets */
  async close(): Promise<void> {
    this.client.destroy();
  }

  /** Deletes every object under the repo prefix, a page of keys at a time */
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

        // DeleteObjects answers 200 with per-key failures in the body, so a purge
        // that silently kept objects would otherwise look like it had worked
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

/** Resolves the assets config, connects, and logs the store's boot line */
export function createS3BlobStore(assets: AssetsConfig, deps: S3BlobStoreDeps = {}): S3BlobStore {
  const options = resolveS3Options(assets);
  const client = deps.client ?? clientFor(options);
  const description =
    `bucket "${options.bucket}" in region "${options.region}" ` +
    `(${options.endpoint ?? 'aws'}, ${options.path_style ? 'path-style' : 'virtual-host style'})`;

  rootLogger.child('assets').info('s3 blob store configured', { store: description });

  return new S3BlobStore(client, options.bucket, description);
}

/**
 * Whether the bucket goes in the path rather than the hostname
 *
 * Derived rather than asked. Virtual-host addressing (`bucket.host/key`) needs the
 * bucket to resolve as a subdomain, which only the public clouds arrange, and AWS
 * now requires it for buckets made after September 2020. Everything reached through
 * an `endpoint` is self-hosted or S3-compatible, where there is no wildcard DNS and
 * no certificate to match, so the bucket goes in the path
 *
 * An AWS endpoint named explicitly -- a VPC, FIPS or regional one -- is still AWS,
 * and still wants the hostname form
 *
 * The SDK separately corrects the two cases where virtual-host cannot work at all:
 * an IP address for a host, and a bucket name containing a dot over HTTPS
 */
export function usesPathStyle(endpoint: string | undefined): boolean {
  if (!endpoint) return false;
  try {
    const host = new URL(endpoint).hostname;
    return host !== 'amazonaws.com' && !host.endsWith('.amazonaws.com');
  } catch {
    // Unparseable: the client constructor rejects it a moment later anyway
    return true;
  }
}

/** Validates the s3 config, listing every problem in one ConfigError */
export function resolveS3Options(assets: AssetsConfig): S3BlobStoreOptions {
  const problems: string[] = [];
  if (!assets.bucket) problems.push('assets.bucket is required for the s3 driver');

  // The SDK has no default region, and guessing one fails as a redirect to the
  // bucket's real region, which reads like a broken endpoint
  if (!assets.region) problems.push('assets.region is required for the s3 driver');

  if (!assets.access_key_id) {
    problems.push('assets.access_key_id is required for the s3 driver');
  }
  if (!assets.secret_access_key) {
    problems.push('assets.secret_access_key is required for the s3 driver');
  }

  if (problems.length) throw new ConfigError('the s3 assets driver is misconfigured', problems);

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

    // The SDK otherwise sends a CRC32 checksum with `aws-chunked` encoding on
    // every upload, which Hetzner Object Storage and older MinIO reject outright.
    // Both are providers this driver documents support for, so checksums go out
    // only where the protocol demands them
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

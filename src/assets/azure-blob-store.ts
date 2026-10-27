import { Readable } from 'node:stream';

import { reasonOf } from '../common/errors';

import type { TokenCredential } from '@azure/identity';
import {
  BlobSASPermissions,
  BlobServiceClient,
  ContainerClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';

import {
  AzureCredentialConfig,
  createAzureCredential,
  describeAzureCredential,
  isAzureCredentialKind,
} from '../common/azure-credential';
import { ConfigError } from '../common/errors';
import { Logger, rootLogger } from '../common/logger';
import { AssetsConfig } from '../config/types';
import { BlobStore, PresignRequest, StoreStatus, blobKey } from './blob-store';
import { ConfigProblem, problem } from '../common/config-problems';

export type AzureAuthKind = 'connection_string' | 'key' | AzureCredentialConfig['kind'];

/** Resolved Azure storage options */
export interface AzureBlobStoreOptions {
  account: string;
  container: string;
  auth: AzureAuthKind;
  connection_string?: string;
  account_key?: string;
  client_id?: string;
  tenant_id?: string;

  // Custom storage URL; defaults to Azure's public host
  endpoint?: string;
}

export interface AzureBlobStoreDeps {
  /** Credential factory override for tests */
  credentialFor?: (config: AzureCredentialConfig) => TokenCredential;
}

const PURGE_CONCURRENCY = 16; // Maximum concurrent deletes

const PROBE_TIMEOUT_MS = 3_000; // Container check timeout

export const CONTAINER_OK_LABEL = 'Container accessible';
export const CONTAINER_FAIL_LABEL = 'Container unavailable';

/** Blob storage in a single Azure container */
export class AzureBlobStore implements BlobStore {
  readonly kind = 'azure' as const;

  private readonly log: Logger = rootLogger.child('assets');

  constructor(
    private readonly container: ContainerClient,

    private readonly description: string,

    /** Client has an account key for SAS signing */
    private readonly canSign: boolean,
  ) {}

  describe(): string {
    return this.description;
  }

  private blob(repoId: string, contentHash: string) {
    return this.container.getBlockBlobClient(blobKey(repoId, contentHash));
  }

  async exists(repoId: string, contentHash: string): Promise<boolean> {
    return this.blob(repoId, contentHash).exists();
  }

  async put(
    repoId: string,
    contentHash: string,
    source: { path?: string; bytes?: Buffer },
  ): Promise<void> {
    const blob = this.blob(repoId, contentHash);
    const options = { blobHTTPHeaders: { blobContentType: 'application/octet-stream' } };
    if (source.bytes) await blob.uploadData(source.bytes, options);
    else if (source.path) await blob.uploadFile(source.path, options);
    else throw new Error('Cannot upload blob: provide bytes or a file path.');
  }

  async get(repoId: string, contentHash: string): Promise<Buffer> {
    return this.blob(repoId, contentHash).downloadToBuffer();
  }

  async stream(repoId: string, contentHash: string): Promise<Readable> {
    const response = await this.blob(repoId, contentHash).download();
    const body = response.readableStreamBody;

    if (!body)
      throw new Error(`No download stream for Azure blob "${blobKey(repoId, contentHash)}".`);
    return body as Readable;
  }

  async presign(
    repoId: string,
    contentHash: string,
    request: PresignRequest,
  ): Promise<string | null> {
    if (!this.canSign) return null;

    return this.blob(repoId, contentHash).generateSasUrl({
      permissions: BlobSASPermissions.parse('r'),
      expiresOn: new Date(Date.now() + request.ttlSeconds * 1000),
      // Strip characters that break the quoted filename
      contentDisposition: `inline; filename="${request.filename.replace(/["\\]/g, '')}"`,
      // Override the stored octet-stream content type
      contentType: request.mime,
    });
  }

  /** Check container access with a timeout */
  async probe(): Promise<StoreStatus> {
    const abortSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    try {
      const there = await this.container.exists({ abortSignal });
      return there
        ? {
            code: 'store.reachable',
            level: 'ok',
            label: CONTAINER_OK_LABEL,
            detail: this.description,
            facts: { target: this.container.containerName },
          }
        : {
            code: 'store.missing',
            facts: { target: this.container.containerName },
            level: 'fail',
            label: CONTAINER_FAIL_LABEL,
            detail: `Container not found: ${this.description}. Create it manually.`,
          };
    } catch (err) {
      return {
        code: 'store.unreachable',
        facts: { target: this.container.containerName, reason: reasonOf(err) },
        level: 'fail',
        label: CONTAINER_FAIL_LABEL,
        detail: `Container check failed: ${reasonOf(err)}. Target: ${this.description}.`,
      };
    }
  }

  /** Delete repository blobs with bounded concurrency */
  async purgeRepo(repoId: string): Promise<void> {
    const pending: Promise<unknown>[] = [];
    let deleted = 0;

    for await (const blob of this.container.listBlobsFlat({ prefix: `${repoId}/` })) {
      pending.push(
        this.container
          .getBlockBlobClient(blob.name)
          .deleteIfExists({ deleteSnapshots: 'include' })
          .then(() => {
            deleted += 1;
          }),
      );

      // Wait when the delete limit is reached
      if (pending.length >= PURGE_CONCURRENCY) {
        await Promise.all(pending.splice(0));
      }
    }
    await Promise.all(pending);

    this.log.info('purged repository blobs', { repo_id: repoId, deleted });
  }
}

/** Create the store and log its configuration */
export function createAzureBlobStore(
  assets: AssetsConfig,
  deps: AzureBlobStoreDeps = {},
): AzureBlobStore {
  const options = resolveAzureOptions(assets);
  const container = containerClientFor(options, deps);
  const description =
    `container "${options.container}" on storage account "${options.account}" ` +
    `(${describeAuth(options)})`;

  const canSign = options.auth === 'key' || options.auth === 'connection_string';

  rootLogger
    .child('assets')
    .info('azure blob store configured', { store: description, presigns: canSign });

  return new AzureBlobStore(container, description, canSign);
}

function credentialConfigOf(options: AzureBlobStoreOptions): AzureCredentialConfig | null {
  if (options.auth === 'connection_string' || options.auth === 'key') return null;
  return {
    kind: options.auth,
    client_id: options.client_id,
    tenant_id: options.tenant_id,
  };
}

/** Auth label for logs and status */
function describeAuth(options: AzureBlobStoreOptions): string {
  const credential = credentialConfigOf(options);
  if (credential) return describeAzureCredential(credential);
  return options.auth === 'key' ? 'account key' : 'connection string';
}

/** Validate config and report all problems in one ConfigError */
export function resolveAzureOptions(assets: AssetsConfig): AzureBlobStoreOptions {
  const problems: ConfigProblem[] = [];
  const missing = (key: string, text: string) =>
    problems.push(
      problem('assets.key-missing', `assets.${key}`, {
        text,
        dashboard: `Set assets.${key}: ${text}.`,
      }),
    );
  if (!assets.account) missing('account', 'required for Azure Blob Storage');
  if (!assets.container) missing('container', 'required for Azure Blob Storage');

  const auth = assets.auth ?? 'key';
  if (auth !== 'connection_string' && auth !== 'key' && !isAzureCredentialKind(auth)) {
    problems.push(
      problem('assets.auth-unknown', 'assets.auth', {
        text: `unsupported Azure authentication method: ${JSON.stringify(auth)}`,
        dashboard: `Unsupported authentication method ${JSON.stringify(auth)}. Choose a supported one.`,
      }),
    );
  }
  if (auth === 'connection_string' && !assets.connection_string) {
    missing('connection_string', 'required when assets.auth is "connection_string"');
  }
  if (auth === 'key' && !assets.account_key) {
    missing('account_key', 'required when assets.auth is "key"');
  }

  if (problems.length) {
    throw new ConfigError(
      problem('assets.misconfigured', null, {
        text: 'invalid Azure Blob Storage configuration',
        dashboard: 'Azure Blob Storage configuration needs fixing.',
      }),
      problems,
    );
  }

  return {
    account: assets.account!,
    container: assets.container!,
    auth: auth as AzureAuthKind,
    connection_string: assets.connection_string,
    account_key: assets.account_key,
    client_id: assets.client_id,
    tenant_id: assets.tenant_id,
    endpoint: assets.endpoint,
  };
}

/** Custom endpoint without trailing slashes, or Azure's public URL */
export function azureServiceUrl(options: AzureBlobStoreOptions): string {
  return (
    options.endpoint?.replace(/\/+$/, '') ?? `https://${options.account}.blob.core.windows.net`
  );
}

function containerClientFor(
  options: AzureBlobStoreOptions,
  deps: AzureBlobStoreDeps,
): ContainerClient {
  const service = serviceClientFor(options, deps);
  return service.getContainerClient(options.container);
}

/** Create a service client using the configured auth */
export function serviceClientFor(
  options: AzureBlobStoreOptions,
  deps: AzureBlobStoreDeps = {},
): BlobServiceClient {
  const url = azureServiceUrl(options);

  switch (options.auth) {
    case 'connection_string':
      return BlobServiceClient.fromConnectionString(options.connection_string!);

    case 'key':
      return new BlobServiceClient(
        url,
        new StorageSharedKeyCredential(options.account, options.account_key!),
      );

    default: {
      const credential = (deps.credentialFor ?? createAzureCredential)(
        credentialConfigOf(options)!,
      );
      return new BlobServiceClient(url, credential);
    }
  }
}

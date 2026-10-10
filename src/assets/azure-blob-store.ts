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

export type AzureAuthKind = 'connection_string' | 'key' | AzureCredentialConfig['kind'];

/** Resolved options for the azure driver */
export interface AzureBlobStoreOptions {
  account: string;
  container: string;
  auth: AzureAuthKind;
  connection_string?: string;
  account_key?: string;
  client_id?: string;
  tenant_id?: string;

  // Overrides the storage URL, for emulators like Azurite; the public host when unset
  endpoint?: string;
}

export interface AzureBlobStoreDeps {
  /** Overrides credential construction so tests can answer without Azure */
  credentialFor?: (config: AzureCredentialConfig) => TokenCredential;
}

const PURGE_CONCURRENCY = 16; // In-flight deletes allowed during one purge

const PROBE_TIMEOUT_MS = 3_000; // How long probe waits on the container

export const CONTAINER_OK_LABEL = 'Container accessible';
export const CONTAINER_FAIL_LABEL = 'Not connected to the container';

/** BlobStore backed by one Azure blob container */
export class AzureBlobStore implements BlobStore {
  readonly kind = 'azure' as const;

  private readonly log: Logger = rootLogger.child('assets');

  constructor(
    private readonly container: ContainerClient,

    private readonly description: string,

    /** Whether this container's client holds an account key, so it can sign a SAS */
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
    else throw new Error('put() needs either bytes or a path');
  }

  async get(repoId: string, contentHash: string): Promise<Buffer> {
    return this.blob(repoId, contentHash).downloadToBuffer();
  }

  async stream(repoId: string, contentHash: string): Promise<Readable> {
    const response = await this.blob(repoId, contentHash).download();
    const body = response.readableStreamBody;

    if (!body) throw new Error(`azure blob ${blobKey(repoId, contentHash)} returned no stream`);
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
      // Quotes and backslashes would end the header's quoted string early
      contentDisposition: `inline; filename="${request.filename.replace(/["\\]/g, '')}"`,
      // Without this the container answers octet-stream, which is how it is stored
      contentType: request.mime,
    });
  }

  /** Checks the container with a timeout */
  async probe(): Promise<StoreStatus> {
    const abortSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    try {
      const there = await this.container.exists({ abortSignal });
      return there
        ? { level: 'ok', label: CONTAINER_OK_LABEL, detail: this.description }
        : {
            level: 'fail',
            label: CONTAINER_FAIL_LABEL,
            detail: `${this.description} is not there. This instance never creates it.`,
          };
    } catch (err) {
      return {
        level: 'fail',
        label: CONTAINER_FAIL_LABEL,
        detail: `${this.description} (${reasonOf(err)})`,
      };
    }
  }

  /** Deletes every blob under the repo prefix, capped at PURGE_CONCURRENCY in flight */
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

      // Bound in-flight deletes so a large repo does not open hundreds of connections
      if (pending.length >= PURGE_CONCURRENCY) {
        await Promise.all(pending.splice(0));
      }
    }
    await Promise.all(pending);

    this.log.info('purged repository blobs', { repo_id: repoId, deleted });
  }
}

/** Resolves the assets config, connects, and logs the store's boot line */
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

/** Human name of the auth kind, for the boot log and status detail */
function describeAuth(options: AzureBlobStoreOptions): string {
  const credential = credentialConfigOf(options);
  if (credential) return describeAzureCredential(credential);
  return options.auth === 'key' ? 'account key' : 'connection string';
}

/** Validates the azure config, listing every problem in one ConfigError */
export function resolveAzureOptions(assets: AssetsConfig): AzureBlobStoreOptions {
  const problems: string[] = [];
  if (!assets.account) problems.push('assets.account is required for the azure driver');
  if (!assets.container) problems.push('assets.container is required for the azure driver');

  const auth = assets.auth ?? 'key';
  if (auth !== 'connection_string' && auth !== 'key' && !isAzureCredentialKind(auth)) {
    problems.push(`assets.auth is missing: ${JSON.stringify(auth)}`);
  }
  if (auth === 'connection_string' && !assets.connection_string) {
    problems.push('assets.connection_string is required when assets.auth is "connection_string"');
  }
  if (auth === 'key' && !assets.account_key) {
    problems.push('assets.account_key is required when assets.auth is "key"');
  }

  if (problems.length) throw new ConfigError('the azure assets driver is misconfigured', problems);

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

/** Storage URL: the endpoint minus trailing slashes, else the public host */
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

/** BlobServiceClient for the connection_string, key, or identity auth */
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

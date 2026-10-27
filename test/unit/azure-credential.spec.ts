import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  WorkloadIdentityCredential,
} from '@azure/identity';

import { resolveAzureOptions, serviceClientFor } from '../../src/assets/azure-blob-store';
import {
  AzureCredentialConfig,
  createAzureCredential,
  describeAzureCredential,
  isAzureCredentialKind,
} from '../../src/common/azure-credential';
import { AssetsConfig } from '../../src/config/types';

describe('createAzureCredential', () => {
  const federatedTokenFile = process.env.AZURE_FEDERATED_TOKEN_FILE;
  afterEach(() => {
    if (federatedTokenFile === undefined) delete process.env.AZURE_FEDERATED_TOKEN_FILE;
    else process.env.AZURE_FEDERATED_TOKEN_FILE = federatedTokenFile;
  });

  it('gives the host identity for managed_identity, with or without a client id', () => {
    expect(createAzureCredential({ kind: 'managed_identity' })).toBeInstanceOf(
      ManagedIdentityCredential,
    );
    expect(
      createAzureCredential({ kind: 'managed_identity', client_id: 'aaaa-bbbb' }),
    ).toBeInstanceOf(ManagedIdentityCredential);
  });

  it('gives the federated-token credential for workload_identity', () => {
    const tokenFile = join(mkdtempSync(join(tmpdir(), 'spr-wi-')), 'token');
    writeFileSync(tokenFile, 'a federated token');
    process.env.AZURE_FEDERATED_TOKEN_FILE = tokenFile;

    expect(
      createAzureCredential({
        kind: 'workload_identity',
        client_id: 'aaaa-bbbb',
        tenant_id: 'cccc-dddd',
      }),
    ).toBeInstanceOf(WorkloadIdentityCredential);
  });

  it('refuses at construction when the pod was never given a token, and says so', () => {
    delete process.env.AZURE_FEDERATED_TOKEN_FILE;

    const configured = { kind: 'workload_identity' as const, client_id: 'aaaa', tenant_id: 'bbbb' };

    expect(() => createAzureCredential(configured)).toRefuseWith('azure.credential-unavailable');
    // The SDK's own reason is passed on as text; it names what the pod is missing
    // eslint-disable-next-line no-restricted-syntax -- the Azure SDK's message has no code
    expect(() => createAzureCredential(configured)).toThrow(/workload identity/);
    // eslint-disable-next-line no-restricted-syntax -- the Azure SDK's message has no code
    expect(() => createAzureCredential(configured)).toThrow(/AZURE_FEDERATED_TOKEN_FILE/);
  });

  it('reaches the SDK fallback chain only when asked for by name', () => {
    expect(createAzureCredential({ kind: 'default' })).toBeInstanceOf(DefaultAzureCredential);
    expect(() =>
      createAzureCredential({ kind: 'imds' } as unknown as AzureCredentialConfig),
    ).toRefuseWith('azure.credential-unknown-kind');
  });

  it('names the kinds the schema closes over, and nothing else', () => {
    expect(isAzureCredentialKind('managed_identity')).toBe(true);
    expect(isAzureCredentialKind('workload_identity')).toBe(true);
    expect(isAzureCredentialKind('default')).toBe(true);
    expect(isAzureCredentialKind('key')).toBe(false);
    expect(isAzureCredentialKind('connection_string')).toBe(false);
  });

  it('describes what it built, because that is what the boot line has to say', () => {
    expect(describeAzureCredential({ kind: 'managed_identity' })).toContain('system-assigned');
    expect(describeAzureCredential({ kind: 'managed_identity', client_id: 'aaaa' })).toContain(
      'aaaa',
    );
    expect(describeAzureCredential({ kind: 'default' })).toContain('chain');
  });
});

describe('the blob driver, asked how to authenticate', () => {
  const base = { driver: 'azure' as const, account: 'acme', container: 'assets' };

  function askedFor(assets: Record<string, unknown>): AzureCredentialConfig | null {
    let asked: AzureCredentialConfig | null = null;
    serviceClientFor(resolveAzureOptions({ ...base, ...assets } as AssetsConfig), {
      credentialFor: (config) => {
        asked = config;
        return { getToken: async () => null };
      },
    });
    return asked;
  }

  it('passes the configured identity through, rather than defaulting inside the SDK', () => {
    expect(askedFor({ auth: 'workload_identity', client_id: 'aaaa', tenant_id: 'bbbb' })).toEqual({
      kind: 'workload_identity',
      client_id: 'aaaa',
      tenant_id: 'bbbb',
    });
  });

  it('holds the account key by default, and asks for no token at all', () => {
    expect(askedFor({ auth: 'key', account_key: 'c2VjcmV0' })).toBeNull();
    expect(() => askedFor({})).toRefuseWith('assets.key-missing', { path: 'assets.account_key' });
  });

  it('asks for no token at all when it holds a secret', () => {
    expect(askedFor({ auth: 'key', account_key: 'c2VjcmV0' })).toBeNull();
    expect(
      askedFor({
        auth: 'connection_string',
        connection_string:
          'DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=c2VjcmV0;EndpointSuffix=core.windows.net',
      }),
    ).toBeNull();
  });

  it('refuses a mode whose secret is missing, naming the key', () => {
    expect(() => resolveAzureOptions({ ...base, auth: 'key' })).toRefuseWith('assets.key-missing', {
      path: 'assets.account_key',
    });
    expect(() => resolveAzureOptions({ driver: 'azure', container: 'assets' })).toRefuseWith(
      'assets.key-missing',
      { path: 'assets.account' },
    );
  });
});

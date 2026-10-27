/** Create and describe Azure credentials from config */

import type { TokenCredential } from '@azure/identity';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  WorkloadIdentityCredential,
} from '@azure/identity';

import { ConfigError } from './errors';
import { problem } from './config-problems';

export type AzureCredentialKind = 'managed_identity' | 'workload_identity' | 'default';

export interface AzureCredentialConfig {
  kind: AzureCredentialKind;

  client_id?: string;
  tenant_id?: string;
}

export const AZURE_CREDENTIAL_KINDS: AzureCredentialKind[] = [
  'managed_identity',
  'workload_identity',
  'default',
];

/** Check whether a value is a supported credential kind */
export function isAzureCredentialKind(value: unknown): value is AzureCredentialKind {
  return typeof value === 'string' && AZURE_CREDENTIAL_KINDS.includes(value as AzureCredentialKind);
}

/** Create a credential and wrap construction errors in ConfigError */
export function createAzureCredential(config: AzureCredentialConfig): TokenCredential {
  try {
    return buildAzureCredential(config);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      problem('azure.credential-unavailable', null, {
        text:
          `this instance is configured to authenticate to Azure as ${describeAzureCredential(config)}, ` +
          'and this process cannot present one',
      }),
      [
        problem('azure.credential-unavailable', null, {
          text: error instanceof Error ? error.message : String(error),
        }),
      ],
    );
  }
}

function buildAzureCredential(config: AzureCredentialConfig): TokenCredential {
  switch (config.kind) {
    case 'managed_identity':
      // A client ID selects a user-assigned identity; otherwise use system-assigned
      return config.client_id
        ? new ManagedIdentityCredential({ clientId: config.client_id })
        : new ManagedIdentityCredential();

    case 'workload_identity':
      return new WorkloadIdentityCredential({
        clientId: config.client_id,
        tenantId: config.tenant_id,
      });

    case 'default':
      return new DefaultAzureCredential(
        config.client_id ? { managedIdentityClientId: config.client_id } : {},
      );

    default:
      // Reject unsupported credential kinds
      throw new ConfigError(
        problem('azure.credential-unknown-kind', null, {
          text: `unknown Azure credential kind ${JSON.stringify((config as AzureCredentialConfig).kind)}`,
        }),
      );
  }
}

/** Describe a credential for errors and logs */
export function describeAzureCredential(config: AzureCredentialConfig): string {
  switch (config.kind) {
    case 'managed_identity':
      return config.client_id
        ? `user-assigned managed identity ${config.client_id}`
        : 'system-assigned managed identity';
    case 'workload_identity':
      return config.client_id
        ? `workload identity ${config.client_id}`
        : 'workload identity (client id from the environment)';
    default:
      return 'DefaultAzureCredential chain';
  }
}

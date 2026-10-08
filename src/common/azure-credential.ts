/**
 * Azure credential construction and description
 *
 * Thin wrapper around the `@azure/identity` classes that hides the library's
 * constructor shape behind a config object
 * Validation of the config happens at construction time; a wrong `kind` yields
 * a `ConfigError`
 *
 * Not exposed on credential kinds without a stable `@azure/identity` API
 */

import type { TokenCredential } from '@azure/identity';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  WorkloadIdentityCredential,
} from '@azure/identity';

import { ConfigError } from './errors';

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

/** Narrowing guard for runtime validation */
export function isAzureCredentialKind(value: unknown): value is AzureCredentialKind {
  return typeof value === 'string' && AZURE_CREDENTIAL_KINDS.includes(value as AzureCredentialKind);
}

/** Build a credential, wrapping thrown non-ConfigError into ConfigError */
export function createAzureCredential(config: AzureCredentialConfig): TokenCredential {
  try {
    return buildAzureCredential(config);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      `this instance is configured to authenticate to Azure as ${describeAzureCredential(config)}, ` +
        'and this process cannot present one',
      [error instanceof Error ? error.message : String(error)],
    );
  }
}

function buildAzureCredential(config: AzureCredentialConfig): TokenCredential {
  switch (config.kind) {
    case 'managed_identity':
      // System-assigned MI needs no clientId; user-assigned requires one
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
      // Unreachable unless a new kind is added without updating the switch
      throw new ConfigError(
        `unknown Azure credential kind ${JSON.stringify((config as AzureCredentialConfig).kind)}`,
      );
  }
}

/**
 * Human-readable label for config, used in error messages and deployment logs
 */
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

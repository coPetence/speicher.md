/**
 * The SSH host keys Speicher trusts, stored as `known_hosts` lines
 *
 * The page shows one row per key with its fingerprint, and a button that fetches
 * the keys from the servers the source's `ssh://` repositories are on. Fetching
 * writes the keys into the field without saving; the operator compares the
 * fingerprints and saves to trust them. The lines themselves can still be edited
 * by hand
 */

import type { HostKey, SshHost } from '../../../../forge/host-keys';
import { knownHostsName, knowsHost, readKnownHosts } from '../../../../forge/host-keys';
import { scalarString } from '../document';
import type { FieldStatus } from '../model';
import type { BaseOptions, FieldBase } from './base';
import { at, baseField } from './base';

// Start of the operation the Fetch button submits; the rest is the field's path
export const FETCH_HOST_KEYS_OP = 'fetch-host-keys:';

export interface KnownHostsField extends FieldBase {
  kind: 'known-hosts';
  // The stored lines
  value: string;
  // Height of the text area in lines
  rows: number;
  // One entry per readable line of `value`
  keys: HostKey[];
  // Number of lines in `value` that are not a host key
  unreadable: number;
  // The servers the Fetch button asks for their keys
  servers: SshHost[];
  // The same servers as `known_hosts` names them, e.g. `[git.example.com]:2222`
  serverNames: string[];
  // The servers in `serverNames` that `value` holds no key for. The configuration
  // cannot be saved while there are any
  missing: string[];
  // Operation the Fetch button submits
  fetchOp: string;
  // What pressing the Fetch button did, shown above the list of keys. Set only on
  // the page that answers the press
  fetchNote?: FieldStatus;
}

export interface KnownHostsOptions extends BaseOptions {
  rows?: number;
  servers?: SshHost[];
}

export function knownHostsField(
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: KnownHostsOptions = {},
): KnownHostsField {
  const base = baseField(path, schemaPath, label, options);
  const value = base.inapplicable ? '' : scalarString(at(root, path));
  const servers = options.servers ?? [];
  const serverNames = servers.map(knownHostsName);
  return {
    ...base,
    kind: 'known-hosts',
    value,
    rows: options.rows ?? 3,
    ...readKnownHosts(value),
    servers,
    serverNames,
    // A reference to an environment variable is not checked, because its value is not known here
    missing: value.includes('${') ? [] : serverNames.filter((name) => !knowsHost(value, name)),
    fetchOp: `${FETCH_HOST_KEYS_OP}${base.path}`,
  };
}

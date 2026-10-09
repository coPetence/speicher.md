/**
 * Git remote security card
 */

import type { SshHost } from '../../../../../forge/host-keys';
import { knownHostsName, sshHostOf } from '../../../../../forge/host-keys';
import { scalarString } from '../../document';
import type { Obj } from '../../config-fields';
import { at, knownHostsField } from '../../config-fields';
import type { Card } from '../../model';

// The servers of the source's `ssh://` repositories, each once
function sshServers(root: Obj, id: string): SshHost[] {
  const repos = at(root, ['forges', id, 'repos']);
  const servers = new Map<string, SshHost>();
  for (const repo of Array.isArray(repos) ? repos : []) {
    const server = sshHostOf(scalarString(at(repo, ['url'])));
    if (server) servers.set(knownHostsName(server), server);
  }
  return [...servers.values()];
}

/**
 * securityCard builds the Security card of a plain git remote's page, which holds
 * the SSH host keys Speicher trusts.
 *
 * @param root the configuration document
 * @param id the source's id
 */
export function securityCard(root: Obj, id: string): Card {
  const base = ['forges', id];
  const p = (key: string) => `forges.<key>.${key}`;
  return {
    title: 'Security',
    subtitle: 'Which SSH servers Speicher trusts when it fetches the repositories.',
    removeOp: null,
    notes: [],
    cards: [],
    addOps: [],
    items: [
      knownHostsField(root, [...base, 'known_hosts'], p('known_hosts'), 'Known hosts', {
        help: 'These are the SSH host keys of the servers the `ssh://` repositories of this source are fetched from. A host key is the public key a server proves its identity with, so Speicher can authenticate the real server. Speicher does not connect to a server whose key is not listed here. To add the keys, press **Fetch host keys** and ==compare the fingerprints with the ones published by the administrator of the server==, and save.',
        rows: 3,
        servers: sshServers(root, id),
      }),
    ],
  };
}

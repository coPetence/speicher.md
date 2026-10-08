/**
 * First-admin setup on a tenant's first login
 *
 * A tenant starts with no YAML config. When the first login arrives with
 * namesFirstAdmin set, the caller is appended to admins.users and persisted
 * as the current config version
 *
 * Not using the admin API because there is no config version to diff against
 */

import { CallerIdentity } from '../../authz/caller';
import { ConfigError } from '../../common/errors';
import { rootLogger } from '../../common/logger';
import { SaveActor, getNewestConfigVersion, saveInstanceConfig } from '../../config/loader';
import {
  appendSeqItem,
  ensureSequence,
  loadDocument,
  serialise,
} from '../configurator/config-form/document';
import { UNCLAIMED_YAML } from './unclaimed';

/** Grant data for an entry in admins.users */
export interface AdminGrant {
  provider?: string;
  subject?: string;
  email?: string;
  note?: string;
}

/** Append a caller as an administrator to the current config */
export async function addAdministrator(
  tenantId: string,
  grant: AdminGrant,
  by: SaveActor,
): Promise<{ version: number }> {
  const latestConfigVersion = await getNewestConfigVersion(tenantId);

  const configurationDocument = loadDocument(latestConfigVersion?.yaml ?? UNCLAIMED_YAML);
  ensureSequence(configurationDocument, ['admins', 'users']);
  appendSeqItem(configurationDocument, ['admins', 'users'], {
    ...(grant.provider ? { provider: grant.provider } : {}),
    ...(grant.subject ? { subject: grant.subject } : {}),
    ...(grant.email ? { email: grant.email } : {}),
    ...(grant.note ? { note: grant.note } : {}),
  });

  const saved = await saveInstanceConfig(tenantId, serialise(configurationDocument), by);
  return { version: saved.version };
}

/** Note explaining who the first admin is and why they were added */
export function firstAdminNote(identity: CallerIdentity): string {
  const who = identity.email ?? identity.displayName ?? null;
  return who
    ? `First administrator: ${who}, named by their own first login`
    : 'First administrator, named by their own first login';
}

/** Returns null if already administered or on ConfigError to let login proceed */
export async function nameFirstAdmin(
  tenantId: string,
  identity: CallerIdentity,
  alreadyAdministered: boolean,
): Promise<{ version: number } | null> {
  const log = rootLogger.child('setup');
  if (alreadyAdministered) {
    log.warn('a first-admin login completed on an instance that already has one; ignored', {
      provider: identity.provider,
    });
    return null;
  }

  try {
    const saved = await addAdministrator(
      tenantId,
      { provider: identity.provider, subject: identity.subject, note: firstAdminNote(identity) },

      { origin: 'setup' },
    );
    log.info('the first administrator was named by their own login', {
      provider: identity.provider,
      version: saved.version,
    });
    return saved;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    log.error('could not write the first administrator', {
      provider: identity.provider,
      error: err.message,
      problems: err.problems,
    });
    return null;
  }
}

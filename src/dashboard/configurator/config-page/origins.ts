import { Document } from 'yaml';

import { ConfigVersion, listConfigVersions } from '../../../config/loader';
import { loadDocument } from '../config-form/document';
import { memberCollectionOf } from '../config-form/members';
import { ConfigSectionPayload } from './payloads';

/**
 * When each row of an index first appeared, and who put it there — read from the
 * version history, because the document has no such thing.
 */
export async function stampEntryOrigins(
  tenantId: string,
  payload: ConfigSectionPayload,
): Promise<void> {
  const section = payload.section;
  if (!section || section.entries.length === 0) return;
  if ((section.columns?.length ?? 0) <= 2) return;

  const collection = memberCollectionOf(section.id);
  // Only map-type collections have origin stamps (list entries have no meaningful key)
  if (!collection || collection.kind !== 'map') return;

  const origins = await memberOrigins(
    tenantId,
    collection.path,
    section.entries.map((entry) => entry.title),
  );

  if (origins.size === 0) {
    section.columns = section.columns?.slice(0, 2);
    return;
  }

  for (const entry of section.entries) {
    const origin = origins.get(entry.title);
    entry.cells = [
      origin ? appliedBy(origin) : UNKNOWN,
      origin ? stamp(origin.applied_at) : UNKNOWN,
    ];
  }
}

// Fallback value for cells when origin data is missing
const UNKNOWN = '—';

// Who applied a version
function appliedBy(version: ConfigVersion): string {
  if (version.applied_by) return version.applied_by;
  if (version.origin === 'file') return 'seeded';
  if (version.origin === 'setup') return 'setup';
  return UNKNOWN;
}

// How many past versions to scan for origin detection
const ORIGIN_SCAN = 500;

function stamp(at: Date): string {
  const date = at instanceof Date ? at : new Date(String(at));
  return Number.isNaN(date.getTime()) ? UNKNOWN : date.toISOString().slice(0, 16).replace('T', ' ');
}

async function memberOrigins(
  tenantId: string,
  path: string[],
  names: string[],
): Promise<Map<string, ConfigVersion>> {
  const found = new Map<string, ConfigVersion>();
  if (names.length === 0) return found;

  const versions = await listConfigVersions(tenantId, ORIGIN_SCAN);
  const truncated = versions.length === ORIGIN_SCAN;
  const pending = new Set(names);

  // Walk versions newest-first to find the first (most recent) appearance of each name
  for (const version of versions) {
    let doc: Document;
    try {
      doc = loadDocument(version.yaml);
    } catch {
      // Corrupt version in history; stop scanning
      break;
    }
    for (const name of [...pending]) {
      if (!doc.hasIn([...path, name])) {
        pending.delete(name);
        continue;
      }
      found.set(name, version);
    }
    if (pending.size === 0) break;
  }

  // If truncated, remove uncertain entries (they may appear beyond the scan window)
  if (truncated) for (const name of pending) found.delete(name);

  return found;
}

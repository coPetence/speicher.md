/**
 * Config key classification and comparison
 *
 * Each known config key is tagged by whether a change affects document
 * resolution (access control, forge drivers, ingest rules) and whether the
 * process must restart to apply the change
 *
 * compareConfigs diffs the current and proposed config, looks up each key's
 * classification, and returns a SaveVerdict with the required action
 */

import { LoadedInstanceConfig } from './parser';
import { stableStringify } from './resolution-hash';

/** Classification for a single config key */
export interface KeyEffect {
  affectsResolution: boolean;
  requiresRestart: boolean;

  note: string;
}

/** Known config keys and their effect classifications */
export const CONFIG_KEY_EFFECTS: Record<string, KeyEffect> = {
  version: {
    affectsResolution: false,
    requiresRestart: true,
    note: 'the schema version this document is written against',
  },
  mail: {
    affectsResolution: false,
    requiresRestart: false,
    note: 'the transport is rebuilt when the host, port or credentials change',
  },
  assets: {
    affectsResolution: false,
    requiresRestart: true,
    note: 'the blob driver is built once, at boot',
  },
  theme: {
    affectsResolution: false,
    requiresRestart: false,
    note: 'presentation, read while rendering a page',
  },
  attribution: {
    affectsResolution: false,
    requiresRestart: false,
    note: 'presentation, read while rendering the shell',
  },
  brand: {
    affectsResolution: false,
    requiresRestart: false,
    note: 'presentation, read while rendering the shell',
  },
  graph: {
    affectsResolution: false,
    requiresRestart: false,
    note: 'read-side switches; edges are recorded either way',
  },
  analytics: {
    affectsResolution: false,
    requiresRestart: false,
    note: 'read counts; consulted per read, so switching it off is immediate',
  },
  notify: {
    affectsResolution: false,
    requiresRestart: false,
    note: 'read when a notification is decided',
  },
  embedding: {
    affectsResolution: false,
    requiresRestart: true,
    note: 'the embedding client is built once, and changing it needs a re-embed',
  },
  auth: {
    affectsResolution: true,
    requiresRestart: false,
    note: 'providers are read per login and per request; a changed provider rebuilds',
  },
  admins: {
    affectsResolution: true,
    requiresRestart: false,
    note: 'compared against a session’s own principals, per request',
  },
  groups: {
    affectsResolution: true,
    requiresRestart: false,
    note:
      'mapped per request, so an edit lands without waiting for re-login; ' +
      'defining or removing a group rebuilds, changing who is in one does not',
  },
  public: {
    affectsResolution: true,
    requiresRestart: false,
    note: 'which repositories may grant `public`, read at ingest — changing it rebuilds',
  },
  forges: {
    affectsResolution: true,
    requiresRestart: false,
    note: 'drivers are rebuilt when their configuration moves, and discovery re-runs on the reconciler',
  },
  defaults: {
    affectsResolution: true,
    requiresRestart: false,
    note: 'read at ingest, and they decide what is walked and what is indexable',
  },
  autolink: {
    affectsResolution: true,
    requiresRestart: false,
    note: 'read at ingest, and stored pages hold the links it decides',
  },
};

/** The process can hot-reload config changes without restart */
// TODO modify this when testing over
export const HOT_RELOAD_AVAILABLE = true;

/** Conservative fallback for keys not in CONFIG_KEY_EFFECTS */
const UNCLASSIFIED: KeyEffect = {
  affectsResolution: true,
  requiresRestart: true,
  note: 'not classified — assumed to need both a restart and a rebuild',
};

/** Look up a key's effect, defaulting to the conservative fallback */
export function effectFor(key: string): KeyEffect {
  return CONFIG_KEY_EFFECTS[key] ?? UNCLASSIFIED;
}

/** A changed key carrying its effect classification */
export interface ChangedKey extends KeyEffect {
  key: string;
}

/** Result of comparing two configs */
export interface SaveVerdict {
  changed: ChangedKey[];

  rebuild: boolean;
  effect: 'none' | 'hot' | 'restart' | 'rebuild';

  hotReloadAvailable: boolean;
}

/** Diff current and proposed config, return the verdict */
export function compareConfigs(
  current: LoadedInstanceConfig,
  proposed: LoadedInstanceConfig,
): SaveVerdict {
  const keys = new Set([...Object.keys(current.raw), ...Object.keys(proposed.raw)]);
  const changed: ChangedKey[] = [];

  for (const key of [...keys].sort()) {
    const before = (current.raw as unknown as Record<string, unknown>)[key];
    const after = (proposed.raw as unknown as Record<string, unknown>)[key];

    if (stableStringify(before) === stableStringify(after)) continue;
    changed.push({ key, ...effectFor(key) });
  }

  const rebuild = current.resolutionHash !== proposed.resolutionHash;

  return {
    changed,
    rebuild,
    effect: verdictEffect(changed, rebuild),
    hotReloadAvailable: HOT_RELOAD_AVAILABLE,
  };
}

/** Determine the action level from changed keys and rebuild flag */
function verdictEffect(changed: ChangedKey[], rebuild: boolean): SaveVerdict['effect'] {
  if (changed.length === 0) return 'none';
  if (rebuild) return 'rebuild';
  if (!HOT_RELOAD_AVAILABLE || changed.some((c) => c.requiresRestart)) return 'restart';
  return 'hot';
}

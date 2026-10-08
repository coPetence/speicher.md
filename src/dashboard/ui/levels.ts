/**
 * The display severity scale behind `spr-badge-*` and `spr-stat-*`, and the
 * mappings from a sync's, a run's and a finding's state onto it
 */

/** The display severity scale used by status rows */
export const LEVELS = ['ok', 'warn', 'fail', 'idle'] as const;

export type Level = (typeof LEVELS)[number];

/** Where a repository sync stands: failed, stale, ok, or never synced */
export function repoLevel(status: string, stale: boolean): Level {
  if (status === 'failed') return 'fail';
  if (stale) return 'warn';
  if (status === 'ok') return 'ok';
  return 'idle';
}

/** Where an individual run stands, with unknown states reading as idle */
export function runLevel(status: string): Level {
  if (status === 'failed') return 'fail';
  if (status === 'ok') return 'ok';

  return 'idle';
}

/** A check finding's severity: reject fails, warn warns, the rest is idle */
export function severityLevel(severity: string): Level {
  if (severity === 'reject') return 'fail';
  if (severity === 'warn') return 'warn';
  return 'idle';
}

/** The units a configured duration such as `30m` can use, with their length */
export const DURATION_UNITS = [
  { unit: 's', label: 'seconds', ms: 1_000 },
  { unit: 'm', label: 'minutes', ms: 60_000 },
  { unit: 'h', label: 'hours', ms: 3_600_000 },
  { unit: 'd', label: 'days', ms: 86_400_000 },
] as const;

/** Splits a configured duration like `30m` into amount and unit, or null when it is none */
export function splitDuration(value: string): { amount: number; unit: string } | null {
  // Matches integer + unit: group 1 is the number, group 2 the unit
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  return match ? { amount: Number(match[1]), unit: match[2] } : null;
}

/** Parse a configured duration like `30m` into milliseconds */
export function parseDuration(value: string): number {
  const split = splitDuration(value);
  const unit = DURATION_UNITS.find((each) => each.unit === split?.unit);
  if (!split || !unit) throw new Error(`invalid duration: ${JSON.stringify(value)}`);
  return split.amount * unit.ms;
}

export function parseDurationWithFallback(value: string | undefined, fallback: string): number {
  return parseDuration(value ?? fallback);
}

const TIME_UNITS: [limit: number, size: number, name: string][] = [
  [60_000, 1_000, 'second'],
  [3_600_000, 60_000, 'minute'],
  [86_400_000, 3_600_000, 'hour'],
  [2_592_000_000, 86_400_000, 'day'],
  [31_536_000_000, 2_592_000_000, 'month'],
  [Infinity, 31_536_000_000, 'year'],
];

/** A non-negative span as "3 minutes", floored to the nearest whole unit, minimum 1 */
function spanOf(ms: number): string {
  const [, size, name] = TIME_UNITS.find(([limit]) => ms < limit)!;
  const n = Math.max(1, Math.floor(ms / size));
  return `${n} ${name}${n === 1 ? '' : 's'}`;
}

/**
 * Human-readable relative time like "3 minutes ago", for something that happened
 *
 * Returns "never" for null, NaN, or Infinity
 * Returns "just now" for future dates: a past event stamped by another clock can
 * land a moment ahead of this one, and that is skew, not time travel. A date
 * meant to lie ahead, like an expiry, wants `timeUntil`
 *
 * Not i18n
 */
export function relativeTime(value: Date | string | null, now: Date = new Date()): string {
  if (value === null) return 'never';
  const parsedDate = value instanceof Date ? value : new Date(value);
  const ms = now.getTime() - parsedDate.getTime();
  if (!Number.isFinite(ms)) return 'never';
  if (ms < 0) return 'just now';
  return `${spanOf(ms)} ago`;
}

/**
 * Human-readable time ahead like "in 7 hours", for something that will happen
 *
 * Returns "never" for null, NaN, or Infinity, and "now" once the date has passed
 *
 * Not i18n
 */
export function timeUntil(value: Date | string | null, now: Date = new Date()): string {
  if (value === null) return 'never';
  const parsedDate = value instanceof Date ? value : new Date(value);
  const ms = parsedDate.getTime() - now.getTime();
  if (!Number.isFinite(ms)) return 'never';
  if (ms <= 0) return 'now';
  return `in ${spanOf(ms)}`;
}

/** Human duration from a start to a finish, or until now while the run is still going */
export function elapsed(startedAt: Date | string, finishedAt: Date | string | null): string {
  const from = new Date(startedAt).getTime();
  const to = finishedAt === null ? Date.now() : new Date(finishedAt).getTime();
  const ms = to - from;
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** A coarse duration in whole units, largest first, falling back to milliseconds */
export function approximateDuration(ms: number): string {
  const units: [size: number, name: string][] = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
    [1_000, 'second'],
  ];
  for (const [size, name] of units) {
    if (ms < size) continue;
    const n = Math.round(ms / size);
    return `${n} ${name}${n === 1 ? '' : 's'}`;
  }
  return `${ms} ms`;
}

/** A stable machine-readable instant, or '' for null and unparseable values */
export function isoOf(value: Date | string | null): string {
  if (value === null) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/**
 * Full-jitter exponential backoff for the nth attempt, in milliseconds
 */
export function backoffMs(attempt: number, base: number, cap: number): number {
  const ceiling = Math.min(base * 2 ** (attempt - 1), cap);
  return Math.round(Math.random() * ceiling);
}

/**
 * `Retry-After` HTTP header to milliseconds
 */
export function retryAfterHeaderToMs(header: string | null): number | null {
  if (!header) return null;

  const stated = header.trim();
  if (stated === '') return null;

  const seconds = Number(stated);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;

  const at = Date.parse(stated);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

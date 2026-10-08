/**
 * Date expiry for config sources and grants
 *
 * A bare YYYY-MM-DD date is treated as end-of-day UTC; anything
 * `new Date()` accepts is also valid
 */

/**
 * Parse a string into a Date, or null if it is not a valid datetime
 *
 * YYYY-MM-DD becomes 23:59:59.999Z so the date is the last moment of that day
 */
export function parseUntil(value: string): Date | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T23:59:59.999Z`);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * True when `until` is a past datetime or could not be parsed
 *
 * An undefined value (unset) is never expired
 */
export function isExpired(until: string | undefined, now: Date): boolean {
  if (until === undefined) return false;
  const parsed = parseUntil(until);
  return parsed === null || parsed.getTime() < now.getTime();
}

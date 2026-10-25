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

/**
 * A review date in relative words
 * E.g. "expires tomorrow", "expired 2 months ago", or "no expiry"
 */
export function describeExpiry(until: string | undefined, now: Date = new Date()): string {
  if (until === undefined) return 'no expiry';
  const parsed = parseUntil(until);
  if (parsed === null) return 'not a valid date';

  const day = 86_400_000;
  const endOfToday = new Date(now);
  endOfToday.setUTCHours(23, 59, 59, 999);
  const days = Math.round((parsed.getTime() - endOfToday.getTime()) / day);

  if (days === 0) return 'expires today';
  if (days === 1) return 'expires tomorrow';
  if (days === -1) return 'expired yesterday';
  const span = describeDays(Math.abs(days));
  return days > 0 ? `expires in ${span}` : `expired ${span} ago`;
}

/**
 * A number of days in relative words, rounded to months or years when appropriate
 * E.g. "2 days", "3 months", "1 year"
 */
function describeDays(days: number): string {
  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? '' : 's'}`;
  if (days < 30) return unit(days, 'day');
  if (days < 365) return unit(Math.floor(days / 30), 'month');
  return unit(Math.floor(days / 365), 'year');
}

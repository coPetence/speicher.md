/**
 * Bucket boundaries in a time zone
 *
 * A bucket is midnight (daily) or the top of the hour (hourly) in the given zone
 * Boundaries are computed in that zone's wall clock, not UTC
 *
 * Not using date-fns-tz to avoid pulling in its dependency tree
 */

export type Granularity = 'day' | 'hour';

export function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const PARTS = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = PARTS.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    PARTS.set(timeZone, cached);
  }
  return cached;
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(at: Date, timeZone: string): Wall {
  const parts = formatter(timeZone).formatToParts(at);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),

    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

function offsetAt(at: Date, timeZone: string): number {
  const w = wallClock(at, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);

  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

export function bucketStart(at: Date, timeZone: string, granularity: Granularity): Date {
  // DST: guessed offset may differ from real one; compute twice
  const compute = (offset: number): Date => {
    const local = new Date(at.getTime() + offset);
    const utcMs = Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate(),
      granularity === 'hour' ? local.getUTCHours() : 0,
    );
    return new Date(utcMs - offset);
  };

  const first = compute(offsetAt(at, timeZone));
  return compute(offsetAt(first, timeZone));
}

export function bucketLabel(bucket: Date, timeZone: string, granularity: Granularity): string {
  const w = wallClock(bucket, timeZone);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const day = `${w.year}-${pad(w.month)}-${pad(w.day)}`;
  return granularity === 'hour' ? `${day} ${pad(w.hour)}:00` : day;
}

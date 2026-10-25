import { describeExpiry, isExpired, parseUntil } from '../../src/common/until';

const NOW = new Date('2026-06-01T12:00:00Z');

describe('a review date', () => {
  it('is the last moment of the day it names', () => {
    expect(parseUntil('2026-06-01')?.toISOString()).toBe('2026-06-01T23:59:59.999Z');
    expect(isExpired('2026-06-01', NOW)).toBe(false);
    expect(isExpired('2026-05-31', NOW)).toBe(true);
  });

  it('is said from where today stands', () => {
    expect(describeExpiry(undefined, NOW)).toBe('no expiry');
    expect(describeExpiry('soon', NOW)).toBe('not a valid date');
    expect(describeExpiry('2026-06-01', NOW)).toBe('expires today');
    expect(describeExpiry('2026-06-02', NOW)).toBe('expires tomorrow');
    expect(describeExpiry('2026-06-10', NOW)).toBe('expires in 9 days');
    expect(describeExpiry('2026-09-01', NOW)).toBe('expires in 3 months');
    expect(describeExpiry('2028-06-01', NOW)).toBe('expires in 2 years');
    expect(describeExpiry('2026-05-31', NOW)).toBe('expired yesterday');
    expect(describeExpiry('2026-05-20', NOW)).toBe('expired 12 days ago');
    expect(describeExpiry('2025-01-01', NOW)).toBe('expired 1 year ago');
  });
});

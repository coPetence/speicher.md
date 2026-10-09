import { backoffMs, retryAfterHeaderToMs } from '../../src/common/time';

describe('exponential backoff', () => {
  it('doubles its ceiling per attempt', () => {
    for (const [attempt, ceiling] of [
      [1, 500],
      [2, 1_000],
      [3, 2_000],
      [4, 4_000],
    ] as const) {
      const waits = Array.from({ length: 200 }, () => backoffMs(attempt, 500, 20_000));

      expect(Math.max(...waits)).toBeLessThanOrEqual(ceiling);
      expect(Math.min(...waits)).toBeGreaterThanOrEqual(0);
      // Full jitter spreads across the window rather than sitting at its edge
      expect(Math.max(...waits)).toBeGreaterThan(ceiling / 2);
    }
  });

  it('stops growing at the cap', () => {
    const waits = Array.from({ length: 200 }, () => backoffMs(12, 500, 20_000));

    expect(Math.max(...waits)).toBeLessThanOrEqual(20_000);
  });

  it('takes the base and cap from the caller, not from itself', () => {
    expect(backoffMs(1, 0, 20_000)).toBe(0);
    expect(backoffMs(9, 500, 10)).toBeLessThanOrEqual(10);
  });

  it('answers whole milliseconds, which is what a sleep is given', () => {
    const waits = Array.from({ length: 50 }, () => backoffMs(3, 500, 20_000));

    expect(waits.every(Number.isInteger)).toBe(true);
  });
});

describe('a Retry-After header', () => {
  it('is read as whole seconds', () => {
    expect(retryAfterHeaderToMs('30')).toBe(30_000);
    expect(retryAfterHeaderToMs(' 30 ')).toBe(30_000);
    expect(retryAfterHeaderToMs('0')).toBe(0);
  });

  it('is read as an HTTP-date too, which is the form the copies used to ignore', () => {
    const at = new Date(Date.now() + 42_000).toUTCString();

    // Second resolution, and `Date.now()` moves between the two calls
    expect(retryAfterHeaderToMs(at)).toBeGreaterThan(40_000);
    expect(retryAfterHeaderToMs(at)).toBeLessThanOrEqual(43_000);
  });

  it('is zero for a date that has already passed, because the window simply elapsed', () => {
    expect(retryAfterHeaderToMs(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });

  it('says nothing for a negative wait, rather than retrying instantly', () => {
    // Nonsense, unlike a past date -- so the caller falls back to its own backoff
    expect(retryAfterHeaderToMs('-5')).toBeNull();
  });

  it('says nothing for an absent or unreadable header', () => {
    expect(retryAfterHeaderToMs(null)).toBeNull();
    expect(retryAfterHeaderToMs('')).toBeNull();
    expect(retryAfterHeaderToMs('   ')).toBeNull();
    expect(retryAfterHeaderToMs('soon')).toBeNull();
  });
});

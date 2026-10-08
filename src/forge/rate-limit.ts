/**
 * Token bucket rate limiter and per-key manager for forge API requests
 *
 * The TokenBucket holds a fixed capacity refilled at a steady rate
 * RateLimiter keeps one bucket per key (typically an installation ID)
 * Not a leaky bucket: the burst-and-refill shape matches GitHub's own
 * rate-limit model
 *
 * Callers acquire a token before each request then observe response headers
 * so a forge can force a hard block via blockUntil on exhaustion
 */

import { Logger, rootLogger } from '../common/logger';

export class TokenBucket {
  private tokens: number;
  private lastRefill = 0;

  private blockedUntil = 0;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = capacity;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const now = this.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.lastRefill = now;
  }

  /** Milliseconds until a token is available, or 0 if one can be taken now */
  delay(): number {
    const now = this.now();
    if (now < this.blockedUntil) return this.blockedUntil - now;
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
  }

  /** Consume one token */
  take(): void {
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  /** Forbid any request until the given epoch millisecond */
  blockUntil(epochMs: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, epochMs);
    this.tokens = 0;
  }
}

export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly log: Logger = rootLogger.child('forge.ratelimit');

  constructor(
    private readonly capacity = 60,
    private readonly refillPerSecond = 10,
  ) {}

  private bucket(key: string): TokenBucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.capacity, this.refillPerSecond);
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  /** Wait until a token is available, then consume one */
  async acquire(key: string): Promise<void> {
    const bucket = this.bucket(key);
    for (;;) {
      const wait = bucket.delay();
      if (wait <= 0) break;
      this.log.debug('rate limited, backing off', { key, wait_ms: wait });
      await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
    }
    bucket.take();
  }

  /** Inspect response headers and hard-block the bucket if the forge says we are
      exhausted */
  observe(key: string, headers: Headers): void {
    const remaining = Number(headers.get('x-ratelimit-remaining') ?? NaN);
    const reset = Number(headers.get('x-ratelimit-reset') ?? NaN);
    if (Number.isFinite(remaining) && remaining <= 1 && Number.isFinite(reset)) {
      this.bucket(key).blockUntil(reset * 1000);
      this.log.warn('forge rate limit exhausted; pausing until reset', { key, reset });
    }
    const retryAfter = Number(headers.get('retry-after') ?? NaN);
    if (Number.isFinite(retryAfter)) {
      this.bucket(key).blockUntil(Date.now() + retryAfter * 1000);
    }
  }
}

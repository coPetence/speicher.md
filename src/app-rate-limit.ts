/**
 * Rate limiting for anonymous callers
 *
 * Only query-bearing requests are metered: those with URL query params or a
 * non-GET/HEAD method
 *
 * Signed-in callers (with session, API key, or OAuth token) are exempt
 *
 * The limit per minute per client IP comes from SPEICHER_ANON_RATE_LIMIT
 *
 * The 429 response is plain text to avoid being served as a rendered page
 */
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { reflectsCallerInput } from './app-setup';
import { env } from './common/env';
import { Logger, rootLogger } from './common/logger';

@Injectable()
/** Rate-limits anonymous callers per client IP per minute */
export class RateLimitMiddleware implements NestMiddleware {
  private readonly log: Logger = rootLogger.child('rate-limit');
  private readonly windows = new Map<string, Window>(); // Client IP to window state

  /** Cap on tracked IPs to bound memory */
  private static readonly MAX_KEYS = 20_000;
  private lastCapWarning = 0; // Last time the cap warning was logged, to throttle

  /** Enforce the rate limit for this request */
  use(req: Request, res: Response, next: NextFunction): void {
    const limit = env('SPEICHER_ANON_RATE_LIMIT');
    if (limit <= 0 || !this.applies(req)) {
      next();
      return;
    }

    const now = Date.now();
    const key = clientKey(req);
    const state = this.windowFor(key, now);
    if (state === null) {
      next();
      return;
    }

    state.count += 1;
    if (state.count <= limit) {
      next();
      return;
    }

    const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));

    res.setHeader('Retry-After', String(retryAfter));

    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(429).send('Too many requests. Sign in, or try again shortly.\n');
  }

  /** Whether this request gets metered: anonymous caller with caller-specific input */
  private applies(req: Request): boolean {
    const caller = req.caller;
    if (caller?.identity) return false;
    return reflectsCallerInput(req);
  }

  /** Get or create the window for a key, or null if the address cap is reached */
  private windowFor(key: string, now: number): Window | null {
    const existing = this.windows.get(key);
    if (existing && existing.resetAt > now) return existing;
    if (!existing && this.windows.size >= RateLimitMiddleware.MAX_KEYS) {
      this.sweep(now);
      if (this.windows.size >= RateLimitMiddleware.MAX_KEYS) {
        if (now - this.lastCapWarning > WINDOW_MS) {
          this.lastCapWarning = now;
          this.log.warn('rate limiter at its address cap; new addresses are not counted', {
            tracked: this.windows.size,
          });
        }
        return null;
      }
    }
    const fresh: Window = { count: 0, resetAt: now + WINDOW_MS };
    this.windows.set(key, fresh);
    return fresh;
  }

  /** Remove all expired windows */
  private sweep(now: number): void {
    for (const [key, state] of this.windows) {
      if (state.resetAt <= now) this.windows.delete(key);
    }
  }
}

/** State for one client IP within a one-minute window */
interface Window {
  count: number; // Request count in this window

  resetAt: number; // Epoch ms when the window resets
}

/** Window duration in milliseconds */
const WINDOW_MS = 60_000;

/** Client IP resolved through trust proxy, with fallback */
function clientKey(req: Request): string {
  return req.ip ?? 'unknown';
}

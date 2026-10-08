/**
 * Structured JSON-line logger with redaction and async context
 *
 * Secrets matched by key name are always redacted
 * Principal references (user:..., group:...) redacted outside debug
 * AsyncLocalStorage carries per-request log fields
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { env, type LogLevel } from './env';

export type { LogLevel };

// Numeric ordering for level threshold comparison
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Matches field names that suggest a secret value
// Group 1 (unused): the matched keyword
const SECRET_KEY = /(token|secret|password|private_key|api_key|authorization|cookie|hash)/i;
// Matches values prefixed with "group:" or "user:"
// Group 1 (unused): "group" or "user"
const PRINCIPAL_LIKE = /^(group|user):/;

// Always redacts secrets; at non-debug levels also redacts principal references
function redactValue(key: string, value: unknown, level: LogLevel): unknown {
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (level === 'debug') return value;
  if (typeof value === 'string' && PRINCIPAL_LIKE.test(value)) return '[principal]';
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' && PRINCIPAL_LIKE.test(v) ? '[principal]' : v));
  }
  return value;
}

/** Arbitrary key-value log fields */
export interface LogFields {
  [key: string]: unknown;
}

/** Structured logger emitting JSON lines to stdout or stderr */
export class Logger {
  constructor(
    private readonly context: string,
    private readonly base: LogFields = {},
  ) {}

  /** Creates a sub-context logger with merged base fields */
  child(context: string, fields: LogFields = {}): Logger {
    return new Logger(context, { ...this.base, ...fields });
  }

  debug(message: string, fields?: LogFields) {
    this.write('debug', message, fields);
  }
  info(message: string, fields?: LogFields) {
    this.write('info', message, fields);
  }
  warn(message: string, fields?: LogFields) {
    this.write('warn', message, fields);
  }
  error(message: string, fields?: LogFields) {
    this.write('error', message, fields);
  }

  // Filters by configured level, merges async context with base and call-site fields,
  // redacts sensitive values, and writes JSON to stdout or stderr
  private write(level: LogLevel, message: string, fields: LogFields = {}) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[env('SPEICHER_LOG_LEVEL')]) return;

    const merged: LogFields = { ...store.getStore(), ...this.base, ...fields };
    const safe: LogFields = {};
    for (const [key, value] of Object.entries(merged)) {
      safe[key] = redactValue(key, value, level);
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      ctx: this.context,
      msg: message,
      ...safe,
    });
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }
}

/** Root logger for the speicher process */
export const rootLogger = new Logger('speicher');

// Async context for per-request log fields
const store = new AsyncLocalStorage<LogFields>();

/** Wraps execution with initial log context */
export function runWithLogContext<T>(fields: LogFields, fn: () => T): T {
  return store.run({ ...fields }, fn);
}

/** Merges fields into the current async log context */
export function addLogContext(fields: LogFields): void {
  const current = store.getStore();
  if (!current) return;
  Object.assign(current, fields);
}

/** Snapshot of the current async log context */
export function currentLogContext(): LogFields {
  return { ...store.getStore() };
}

/**
 * Structured logger with redaction and async context
 *
 * Writes JSON lines, or aligned human-readable lines when SPEICHER_LOG_FORMAT is pretty
 * Secrets matched by key name are always redacted
 * Principal references (user:..., group:...) redacted outside debug
 * AsyncLocalStorage carries per-request log fields
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { env, type LogLevel } from './env';

export type { LogLevel };

// Numeric ordering for level threshold comparison
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const LEVEL_COLOUR: Record<LogLevel, string> = { debug: '90', info: '36', warn: '33', error: '31' };

const BLOCK_INDENT = '  ';

function inline(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : JSON.stringify(value);
}

function blockLines(value: unknown): string[] | null {
  if (typeof value === 'string') return value.includes('\n') ? value.split('\n') : null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return value.map((item) => `- ${inline(item)}`);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return null;
    return entries.map(([key, item]) => `${key}: ${inline(item)}`);
  }
  return null;
}

// Formats one log line for reading in a terminal
function prettyLine(
  level: LogLevel,
  context: string,
  message: string,
  fields: LogFields,
  colour: boolean,
): string {
  const paint = (code: string, text: string) => (colour ? `\x1b[${code}m${text}\x1b[0m` : text);
  const head = [
    paint('2', new Date().toTimeString().slice(0, 8)),
    paint(LEVEL_COLOUR[level], level.toUpperCase()),
    paint('35', context),
  ].join(' ');
  const lines = [head, BLOCK_INDENT + message];
  const fieldIndent = BLOCK_INDENT.repeat(2);
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const show = (text: string) => (key === 'error' ? paint('31', text) : text);
    const block = blockLines(value);
    if (block) {
      lines.push(fieldIndent + paint('2', `${key}:`));
      for (const line of block) lines.push(fieldIndent + BLOCK_INDENT + show(line));
    } else {
      lines.push(`${fieldIndent}${paint('2', `${key}:`)} ${show(inline(value))}`);
    }
  }
  return lines.join('\n');
}

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

/** Structured logger emitting JSON or pretty lines to stdout or stderr */
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
  // redacts sensitive values, and writes JSON or a pretty line to stdout or stderr
  private write(level: LogLevel, message: string, fields: LogFields = {}) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[env('SPEICHER_LOG_LEVEL')]) return;

    const merged: LogFields = { ...store.getStore(), ...this.base, ...fields };
    const safe: LogFields = {};
    for (const [key, value] of Object.entries(merged)) {
      safe[key] = redactValue(key, value, level);
    }
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    const line =
      env('SPEICHER_LOG_FORMAT') === 'pretty'
        ? prettyLine(level, this.context, message, safe, !!stream.isTTY && !process.env.NO_COLOR)
        : JSON.stringify({
            ts: new Date().toISOString(),
            level,
            ctx: this.context,
            msg: message,
            ...safe,
          });
    stream.write(line + '\n');
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

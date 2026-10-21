/**
 * Environment variable definitions and accessors
 *
 * Every supported env var is listed in ENV_REGISTRY with its parser, fallback, and
 * metadata. env() reads a var at runtime. assertKnownEnv() rejects unknown SPEICHER_*
 * variables at startup to catch misspellings. envReport() returns a table for an
 * admin endpoint.
 */
import { parseDuration } from './time';
import { ConfigError } from './errors';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFormat = 'json' | 'pretty';

export type Entrypoint = 'web' | 'worker' | 'both';

/**
 * How an entrypoint is spelled where somebody reads it.
 *
 * `both` is the registry's word and stays the registry's word — it is what a JSON
 * caller receives and what a `readBy === 'both'` filter compares against. It is a
 * poor thing to print: the page listing these variables is served by one of the two
 * processes it is talking about, and "both" leaves the reader to work out which two.
 * The README table and the environment page name them, through this one function, so
 * the two cannot come to spell it differently.
 */
export function readByLabel(readBy: Entrypoint): string {
  return readBy === 'both' ? 'web + worker' : readBy;
}

export interface EnvVar<T> {
  /** Human-readable explanation shown in /admin/env and docs */
  description: string;
  parse: (raw: string) => T;
  /** Default value when the env var is not set */
  fallback: T;
  required: boolean;
  readBy: Entrypoint;
  /** Hide the value in the env report; never logged */
  secret: boolean;
  /** Available to scripts that import env() rather than loading the instance config */
  alsoInScripts?: boolean;
  /** Override the default-label display in the env table, e.g. `15m` instead of `900000` */
  defaultLabel?: string;
}

function define<T>(spec: EnvVar<T>): EnvVar<T> {
  return spec;
}

const asString = (raw: string): string => raw;

const asBoolean = (raw: string): boolean => raw === 'true';

function integerFor(name: string) {
  return (raw: string): number => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      // integerFor accepts only positive ints
      throw new Error(`${name} must be a positive integer, not ${JSON.stringify(raw)}`);
    }
    return value;
  };
}

function durationFor(name: string) {
  return (raw: string): number => {
    try {
      return parseDuration(raw);
    } catch {
      throw new Error(`${name} must be <integer><s|m|h|d>, not ${JSON.stringify(raw)}`);
    }
  };
}

const asLogLevel = (raw: string): LogLevel => {
  const level = raw.toLowerCase();
  return (['debug', 'info', 'warn', 'error'] as const).includes(level as LogLevel)
    ? (level as LogLevel)
    : 'info';
};

const asLogFormat = (raw: string): LogFormat =>
  raw.toLowerCase() === 'pretty' ? 'pretty' : 'json';

const asConfigSource = (raw: string): 'file' | 'database' => {
  if (raw === 'file' || raw === 'database') return raw;
  throw new ConfigError(
    `SPEICHER_CONFIG_SOURCE must be "file" or "database", not ${JSON.stringify(raw)}`,
  );
};

export const ENV_REGISTRY = {
  SPEICHER_CONFIG: define({
    description:
      'Path to the instance configuration YAML file. Must exist when ' +
      '`SPEICHER_CONFIG_SOURCE` is `file`.',
    parse: asString,
    fallback: './speicher.instance.yaml',
    required: false,
    readBy: 'both',
    secret: false,
    alsoInScripts: true,
  }),
  SPEICHER_CONFIG_SOURCE: define({
    description:
      'Where the instance configuration is read from: `file` or `database`. `file` mode ' +
      'is read-only and requires a restart to pick up changes.',
    parse: asConfigSource,
    fallback: 'file' as 'file' | 'database',
    required: false,
    readBy: 'both',
    secret: false,
  }),
  SPEICHER_CONFIG_POLL: define({
    description:
      'How often to check the database for a newer configuration version, as a duration ' +
      'like `15m`. Set to `0` to disable polling.',
    // Zero disables polling; otherwise floor at 1s to avoid busy-spin
    parse: (raw: string): number =>
      raw === '0' ? 0 : Math.max(1000, durationFor('SPEICHER_CONFIG_POLL')(raw)),
    fallback: parseDuration('10s'),
    defaultLabel: '10s',
    required: false,
    readBy: 'both',
    secret: false,
  }),
  SPEICHER_DATABASE_URL: define({
    description:
      'PostgreSQL connection string. The database must be reachable at boot; a missing ' +
      'or refused connection prevents startup.',
    parse: asString,
    fallback: 'postgres://speicher:speicher@127.0.0.1:55432/speicher',
    required: false,
    readBy: 'both',
    // Credential; never logged or shown in the admin report
    secret: true,
    alsoInScripts: true,
  }),
  SPEICHER_DB_POOL: define({
    description:
      'Maximum connections in the PostgreSQL connection pool. Raise when the instance ' +
      'serves many concurrent requests.',
    parse: integerFor('SPEICHER_DB_POOL'),
    fallback: 10,
    required: false,
    readBy: 'both',
    secret: false,
  }),
  SPEICHER_ASSET_PATH: define({
    description:
      'Directory where uploaded assets are stored on disk. Must be writable by the ' + 'process.',
    parse: asString,
    fallback: './var/assets',
    required: false,
    readBy: 'both',
    secret: false,
    alsoInScripts: true,
  }),
  SPEICHER_MIRROR_ROOT: define({
    description:
      'Root directory for git mirrors. Must be writable and have enough disk space for ' +
      'cloned repositories.',
    parse: asString,
    fallback: './var/mirrors',
    required: false,
    readBy: 'worker',
    secret: false,
  }),
  SPEICHER_SYNC_CONCURRENCY: define({
    description:
      'Maximum number of repositories synced at the same time. Raise for faster ' +
      'indexing on capable hardware.',
    parse: integerFor('SPEICHER_SYNC_CONCURRENCY'),
    fallback: 4,
    required: false,
    readBy: 'worker',
    secret: false,
  }),
  SPEICHER_RECONCILE_INTERVAL: define({
    description:
      'How often the reconciler checks every tracked repository against its remote, as ' +
      'a duration like `15m`. Shorter intervals catch changes faster but increase load.',
    parse: durationFor('SPEICHER_RECONCILE_INTERVAL'),
    fallback: parseDuration('15m'),
    defaultLabel: '15m',
    required: false,
    readBy: 'worker',
    secret: false,
  }),
  SPEICHER_DISCOVER_INTERVAL: define({
    description:
      'How often to scan the forge for new repositories, as a duration like `6h`. ' +
      'Already-tracked repos are reconciled at `SPEICHER_RECONCILE_INTERVAL` ' +
      'regardless.',
    parse: durationFor('SPEICHER_DISCOVER_INTERVAL'),
    fallback: parseDuration('6h'),
    defaultLabel: '6h',
    required: false,
    readBy: 'worker',
    secret: false,
  }),
  SPEICHER_PUBLIC_URL: define({
    description:
      'The public URL of this instance, used in webhook deliveries, magic links, and ' +
      'the sitemap. When unset, the request host is used instead.',
    parse: asString,
    // Undefined fallback means no public URL is configured
    fallback: undefined as string | undefined,
    defaultLabel: 'unset',
    required: false,
    readBy: 'both',
    secret: false,
    alsoInScripts: true,
  }),
  SPEICHER_ANON_RATE_LIMIT: define({
    description:
      'Maximum requests per minute from an anonymous caller per client IP. Signed-in ' +
      'callers are exempt; set to `0` to disable rate limiting.',
    // Zero disables rate limiting; otherwise must be a positive integer
    parse: (raw: string): number => (raw === '0' ? 0 : integerFor('SPEICHER_ANON_RATE_LIMIT')(raw)),
    fallback: 60,
    required: false,
    readBy: 'web',
    secret: false,
  }),
  SPEICHER_PUBLIC_MAX_AGE: define({
    description:
      'Cache-Control `max-age` in seconds for anonymous responses. Set to `0` to ' +
      'disable public caching.',
    // Zero means no public cache; otherwise seconds must be a positive integer
    parse: (raw: string): number => (raw === '0' ? 0 : integerFor('SPEICHER_PUBLIC_MAX_AGE')(raw)),
    fallback: 60,
    required: false,
    readBy: 'web',
    secret: false,
  }),
  SPEICHER_TRUST_PROXY: define({
    description:
      'Which proxies to believe about the client address and protocol: `loopback`, ' +
      '`linklocal`, `uniquelocal`, IP addresses or subnets, comma-separated. In Docker, ' +
      'set `uniquelocal`; `true` and hop counts are not accepted.',
    parse: asString,
    fallback: 'loopback',
    required: false,
    readBy: 'web',
    secret: false,
  }),
  SPEICHER_LOG_LEVEL: define({
    description:
      'Minimum log level to emit: `debug`, `info`, `warn`, or `error`. SQL queries are ' +
      'logged only at `debug` level.',
    parse: asLogLevel,
    fallback: 'info' as LogLevel,
    required: false,
    readBy: 'both',
    secret: false,
    alsoInScripts: true, // for tests
  }),
  SPEICHER_LOG_FORMAT: define({
    description:
      'The log format decides how each log line is written: `json` writes one JSON object per line, and `pretty` writes an aligned, coloured line.',
    parse: asLogFormat,
    fallback: 'json' as LogFormat,
    required: false,
    readBy: 'both',
    secret: false,
    alsoInScripts: true, // set by scripts/dev-env.ts
  }),
  SPEICHER_DEV_LOGIN: define({
    description:
      'Show a development sign-in form that issues a session for any typed identity, ' +
      'without authentication. Never enable in production.',
    parse: asBoolean,
    fallback: false,
    required: false,
    readBy: 'web',
    secret: false,
    alsoInScripts: true,
  }),
  SPEICHER_INSECURE_COOKIES: define({
    description:
      'Omit the Secure flag on cookies, allowing them over HTTP. Never enable in production; ' +
      'without this flag, modern browsers refuse cookies over plain HTTP.',
    parse: asBoolean,
    fallback: false,
    required: false,
    readBy: 'web',
    secret: false,
    alsoInScripts: true,
  }),
  PORT: define({
    description: 'TCP port the HTTP server listens on.',
    parse: integerFor('PORT'),
    fallback: 3000,
    required: false,
    readBy: 'web',
    secret: false,
  }),
} as const;

export type EnvName = keyof typeof ENV_REGISTRY;

type EnvValue<K extends EnvName> = (typeof ENV_REGISTRY)[K] extends EnvVar<infer T> ? T : never;

export function env<K extends EnvName>(name: K): EnvValue<K> {
  const spec = ENV_REGISTRY[name] as unknown as EnvVar<EnvValue<K>>;
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    if (spec.required) {
      throw new Error(`${name} is required and is not set: ${spec.description}`);
    }
    return spec.fallback;
  }
  return spec.parse(raw);
}

/**
 * instanceUrl returns this instance's `SPEICHER_PUBLIC_URL` as a parsed URL, or null
 * when none is declared or it is not a valid URL.
 */
export function instanceUrl(): URL | null {
  const publicUrl = env('SPEICHER_PUBLIC_URL');
  if (!publicUrl) return null;
  try {
    return new URL(publicUrl);
  } catch {
    return null;
  }
}

/**
 * instanceBaseUrl returns this instance's URL as a string without a trailing slash,
 * for appending paths to, or null when no valid URL is declared.
 */
export function instanceBaseUrl(): string | null {
  return instanceUrl()?.href.replace(/\/+$/, '') ?? null;
}

/**
 * instanceHost returns the host of this instance's URL, including its port, or an
 * empty string when no valid URL is declared.
 */
export function instanceHost(): string {
  return instanceUrl()?.host ?? '';
}

export function isProduction(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.NODE_ENV === 'production';
}

export function assertKnownEnv(environment: NodeJS.ProcessEnv = process.env): void {
  const known = Object.keys(ENV_REGISTRY);
  const unknown = Object.keys(environment).filter(
    (name) => name.startsWith('SPEICHER_') && !known.includes(name),
  );
  if (unknown.length === 0) return;

  const lines = unknown.map((name) => {
    const suggestion = nearest(name, known);
    return suggestion ? `  ${name} — did you mean ${suggestion}?` : `  ${name}`;
  });
  throw new Error(
    `${unknown.length === 1 ? 'An environment variable is' : 'Environment variables are'} ` +
      'set that Speicher does not read:\n' +
      lines.join('\n') +
      '\nThe SPEICHER_ prefix is reserved for the variables in src/common/env.ts. ' +
      'A ${VAR} reference in the instance config must use a name outside it.',
  );
}

// Levenshtein distance to suggest a correction for a misspelled SPEICHER_ var
function nearest(name: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  // Suggest only when the edit distance is within a third of the name length
  return best !== null && bestDistance <= Math.ceil(name.length / 3) ? best : null;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

export interface EnvReportRow {
  name: string;
  description: string;
  /** Display value; null when secret */
  value: string | null;
  /** Whether the value came from an env var or the fallback */
  origin: 'environment' | 'default';
  secret: boolean;
  readBy: Entrypoint;
}

export function envReport(environment: NodeJS.ProcessEnv = process.env): EnvReportRow[] {
  return (Object.keys(ENV_REGISTRY) as EnvName[]).map((name) => {
    const spec = ENV_REGISTRY[name] as unknown as EnvVar<unknown>;
    const raw = environment[name];
    const set = raw !== undefined && raw !== '';
    return {
      name,
      description: spec.description,
      value: spec.secret ? null : set ? raw : defaultLabel(spec),
      origin: set ? 'environment' : 'default',
      secret: spec.secret,
      readBy: spec.readBy,
    };
  });
}

function defaultLabel(spec: EnvVar<unknown>): string {
  if (spec.defaultLabel !== undefined) return spec.defaultLabel;
  return spec.fallback === undefined ? 'unset' : String(spec.fallback);
}

/** The env table for the docs: every variable, or only `names` in the order given */
export function renderEnvTable(names?: string[]): string {
  const known = Object.keys(ENV_REGISTRY);
  const unknown = (names ?? []).filter((name) => !known.includes(name));
  if (unknown.length > 0) throw new Error(`unknown env var: ${unknown.join(', ')}`);
  const rows = ((names ?? known) as EnvName[]).map((name) => {
    const spec = ENV_REGISTRY[name] as unknown as EnvVar<unknown>;
    const shown = spec.required
      ? '*required*'
      : spec.fallback === undefined
        ? '—'
        : `\`${defaultLabel(spec)}\``;
    return `| \`${name}\` | ${shown} | ${readByLabel(spec.readBy)} | ${spec.description} |`;
  });
  return [
    '| Variable | Default | Read by | Description |',
    '| -------- | ------- | ------- | ----------- |',
    ...rows,
  ].join('\n');
}

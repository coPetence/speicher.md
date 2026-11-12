/** Parse, validate, and report environment settings */
import { parseDuration } from './time';
import { CodedError, ConfigError } from './errors';
import { problem } from './config-problems';
import { AzureCredentialKind, isAzureCredentialKind } from './azure-credential';

/** Environment error codes */
export type EnvCode = 'env.invalid-value' | 'env.required' | 'env.unknown';

/** Environment validation error */
export class EnvError extends CodedError<EnvCode> {
  constructor(
    code: EnvCode,
    message: string,
    /** Affected variable, if any */
    readonly variable: string | null = null,
    /** Unknown names and suggested replacements */
    readonly unknown: { name: string; suggestion: string | null }[] = [],
  ) {
    super(code, message);
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFormat = 'json' | 'pretty';

export type Entrypoint = 'web' | 'worker' | 'both';

/** Display `both` as `web + worker` */
export function readByLabel(readBy: Entrypoint): string {
  return readBy === 'both' ? 'web + worker' : readBy;
}

export interface EnvVar<T> {
  /** Admin and documentation text */
  description: string;
  parse: (raw: string) => T;
  /** Value when unset or empty */
  fallback: T;
  required: boolean;
  readBy: Entrypoint;
  /** Redact from reports and logs */
  secret: boolean;
  /** Used by scripts too */
  alsoInScripts?: boolean;
  /** Display default, e.g. `15m` */
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
      throw new EnvError(
        'env.invalid-value',
        `${name}: expected an integer greater than 0; got ${JSON.stringify(raw)}.`,
        name,
      );
    }
    return value;
  };
}

function durationFor(name: string) {
  return (raw: string): number => {
    try {
      return parseDuration(raw);
    } catch {
      throw new EnvError(
        'env.invalid-value',
        `${name}: expected an integer followed by s, m, h, or d (e.g. 15m); got ${JSON.stringify(raw)}.`,
        name,
      );
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
    problem('config.source-invalid', null, {
      text: `SPEICHER_CONFIG_SOURCE: invalid value ${JSON.stringify(raw)}. Use "file" or "database".`,
    }),
  );
};

/** PostgreSQL auth via URL password or Azure Entra token */
export type DatabaseAuth = 'password' | AzureCredentialKind;

function asDatabaseAuth(raw: string): DatabaseAuth {
  if (raw === 'password' || isAzureCredentialKind(raw)) return raw;
  throw new EnvError(
    'env.invalid-value',
    `SPEICHER_DATABASE_AUTH: invalid value ${JSON.stringify(raw)}. ` +
      'Use "password", "managed_identity", "workload_identity", or "default".',
    'SPEICHER_DATABASE_AUTH',
  );
}

export const ENV_REGISTRY = {
  SPEICHER_CONFIG: define({
    description: 'Instance YAML path. Must exist when `SPEICHER_CONFIG_SOURCE` is `file`.',
    parse: asString,
    fallback: './speicher.instance.yaml',
    required: false,
    readBy: 'both',
    secret: false,
    alsoInScripts: true,
  }),
  SPEICHER_CONFIG_SOURCE: define({
    description:
      'Configuration source: `file` or `database`. File mode is read-only; restart to apply changes.',
    parse: asConfigSource,
    fallback: 'file' as 'file' | 'database',
    required: false,
    readBy: 'both',
    secret: false,
  }),
  SPEICHER_CONFIG_POLL: define({
    description:
      'Interval between database configuration checks (e.g. `15m`). Use `0` to disable polling.',
    // Zero disables polling; otherwise enforce a 1s minimum
    parse: (raw: string): number =>
      raw === '0' ? 0 : Math.max(1000, durationFor('SPEICHER_CONFIG_POLL')(raw)),
    fallback: parseDuration('10s'),
    defaultLabel: '10s',
    required: false,
    readBy: 'both',
    secret: false,
  }),
  SPEICHER_DATABASE_URL: define({
    description: 'PostgreSQL URL. Database must be reachable at startup.',
    parse: asString,
    fallback: 'postgres://speicher:speicher@127.0.0.1:55432/speicher',
    required: false,
    readBy: 'both',
    // URL includes credentials
    secret: true,
    alsoInScripts: true,
  }),
  SPEICHER_DATABASE_AUTH: define({
    description:
      'PostgreSQL authentication: `password` uses the URL password. For Azure Entra tokens, use ' +
      '`managed_identity` or `workload_identity`).',
    parse: asDatabaseAuth,
    fallback: 'password' as DatabaseAuth,
    required: false,
    readBy: 'both',
    secret: false,
    alsoInScripts: true,
  }),
  SPEICHER_DATABASE_CLIENT_ID: define({
    description:
      'Entra client ID for a user-assigned managed identity or workload identity app. ' +
      'If unset, uses the system-assigned identity or `AZURE_CLIENT_ID`.',
    parse: asString,
    fallback: undefined as string | undefined,
    defaultLabel: 'unset',
    required: false,
    readBy: 'both',
    secret: false,
    alsoInScripts: true,
  }),
  SPEICHER_DB_POOL: define({
    description: 'Maximum PostgreSQL connections in the pool.',
    parse: integerFor('SPEICHER_DB_POOL'),
    fallback: 10,
    required: false,
    readBy: 'both',
    secret: false,
  }),
  SPEICHER_ASSET_PATH: define({
    description: 'Upload directory. The process needs write access.',
    parse: asString,
    fallback: './var/assets',
    required: false,
    readBy: 'both',
    secret: false,
    alsoInScripts: true,
  }),
  SPEICHER_MIRROR_ROOT: define({
    description:
      'Directory into which a sync downloads the data from git. The data is removed after each sync. Must be writable.',
    parse: asString,
    fallback: './var/mirrors',
    required: false,
    readBy: 'worker',
    secret: false,
  }),
  SPEICHER_SYNC_CONCURRENCY: define({
    description: 'Maximum number of repositories to sync at once.',
    parse: integerFor('SPEICHER_SYNC_CONCURRENCY'),
    fallback: 4,
    required: false,
    readBy: 'worker',
    secret: false,
  }),
  SPEICHER_RECONCILE_INTERVAL: define({
    description:
      'Interval between remote checks for tracked repositories (e.g. `15m`). Shorter intervals increase load.',
    parse: durationFor('SPEICHER_RECONCILE_INTERVAL'),
    fallback: parseDuration('15m'),
    defaultLabel: '15m',
    required: false,
    readBy: 'worker',
    secret: false,
  }),
  SPEICHER_DISCOVER_INTERVAL: define({
    description:
      'Interval between forge scans for new repositories (e.g. `6h`). ' +
      'Tracked repositories use `SPEICHER_RECONCILE_INTERVAL` instead.',
    parse: durationFor('SPEICHER_DISCOVER_INTERVAL'),
    fallback: parseDuration('6h'),
    defaultLabel: '6h',
    required: false,
    readBy: 'worker',
    secret: false,
  }),
  SPEICHER_PUBLIC_URL: define({
    description:
      'Public instance URL for webhooks, magic links, and the sitemap. Uses the request host if unset.',
    parse: asString,
    fallback: undefined as string | undefined,
    defaultLabel: 'unset',
    required: false,
    readBy: 'both',
    secret: false,
    alsoInScripts: true,
  }),
  SPEICHER_ANON_RATE_LIMIT: define({
    description:
      'Anonymous requests allowed per minute per client IP. Signed-in users are exempt. Use `0` for no limit.',
    parse: (raw: string): number => (raw === '0' ? 0 : integerFor('SPEICHER_ANON_RATE_LIMIT')(raw)),
    fallback: 60,
    required: false,
    readBy: 'web',
    secret: false,
  }),
  SPEICHER_PUBLIC_MAX_AGE: define({
    description:
      'Cache-Control `max-age` for anonymous responses, in seconds. Use `0` to disable public caching.',
    parse: (raw: string): number => (raw === '0' ? 0 : integerFor('SPEICHER_PUBLIC_MAX_AGE')(raw)),
    fallback: 60,
    required: false,
    readBy: 'web',
    secret: false,
  }),
  SPEICHER_TRUST_PROXY: define({
    description:
      'Trusted proxies for client IP and protocol: comma-separated `loopback`, `linklocal`, ' +
      '`uniquelocal`, IPs, or subnets. Use `uniquelocal` in Docker. No `true` or hop counts.',
    parse: asString,
    fallback: 'loopback',
    required: false,
    readBy: 'web',
    secret: false,
  }),
  SPEICHER_LOG_LEVEL: define({
    description:
      'Minimum log level: `debug`, `info`, `warn`, or `error`. SQL queries appear only at `debug`.',
    parse: asLogLevel,
    fallback: 'info' as LogLevel,
    required: false,
    readBy: 'both',
    secret: false,
    alsoInScripts: true, // Used by tests
  }),
  SPEICHER_LOG_FORMAT: define({
    description:
      'Log format: `json` for one JSON object per line, or `pretty` for aligned, coloured text.',
    parse: asLogFormat,
    fallback: 'json' as LogFormat,
    required: false,
    readBy: 'both',
    secret: false,
    alsoInScripts: true, // Set in scripts/dev-env.ts
  }),
  SPEICHER_DEV_LOGIN: define({
    description:
      'Enable sign-in as any identity without authentication. Development only; never enable in production.',
    parse: asBoolean,
    fallback: false,
    required: false,
    readBy: 'web',
    secret: false,
    alsoInScripts: true,
  }),
  SPEICHER_INSECURE_COOKIES: define({
    description:
      'Remove the Secure cookie flag to allow cookies over HTTP. Development only; never enable in production.',
    parse: asBoolean,
    fallback: false,
    required: false,
    readBy: 'web',
    secret: false,
    alsoInScripts: true,
  }),
  PORT: define({
    description: 'HTTP server TCP port.',
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
      throw new EnvError('env.required', `${name} is required. Set a non-empty value.`, name);
    }
    return spec.fallback;
  }
  return spec.parse(raw);
}

/** Public URL, or null if unset or invalid */
export function instanceUrl(): URL | null {
  const publicUrl = env('SPEICHER_PUBLIC_URL');
  if (!publicUrl) return null;
  try {
    return new URL(publicUrl);
  } catch {
    return null;
  }
}

/** Public URL without trailing slashes, or null if unset or invalid */
export function instanceBaseUrl(): string | null {
  return instanceUrl()?.href.replace(/\/+$/, '') ?? null;
}

/** Public host and port, or empty string if unset or invalid */
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

  const named = unknown.map((name) => ({ name, suggestion: nearest(name, known) }));
  const lines = named.map(({ name, suggestion }) =>
    suggestion ? `  ${name} — did you mean ${suggestion}?` : `  ${name}`,
  );
  throw new EnvError(
    'env.unknown',
    `Unknown environment ${unknown.length === 1 ? 'variable' : 'variables'}:\n` +
      lines.join('\n') +
      '\nRemove or correct these names. SPEICHER_ is reserved; custom ${VAR} references must use another prefix.',
    null,
    named,
  );
}

// Suggest the closest name by edit distance
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
  // Reject distances above one-third of the name length, rounded up
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
  /** Display value, or null for secrets */
  value: string | null;
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

/** Render a docs table for all variables or `names` in order */
export function renderEnvTable(names?: string[]): string {
  const known = Object.keys(ENV_REGISTRY);
  const unknown = (names ?? []).filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    throw new EnvError(
      'env.unknown',
      `Unknown environment ${unknown.length === 1 ? 'variable' : 'variables'}: ${unknown.join(', ')}.`,
      null,
      unknown.map((name) => ({ name, suggestion: null })),
    );
  }
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

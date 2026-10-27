import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import {
  ENV_REGISTRY,
  EnvName,
  assertKnownEnv,
  env,
  envReport,
  readByLabel,
  renderEnvTable,
} from '../../src/common/env';

const ROOT = resolve(__dirname, '../..');
const SRC = join(ROOT, 'src');

const REGISTRY_FILE = join('src', 'common', 'env.ts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

const OFFENDING = [/process\.env\.SPEICHER_/, /process\.env\[/];

function offenders(): { file: string; line: number; text: string }[] {
  const found: { file: string; line: number; text: string }[] = [];
  for (const path of sourceFiles(SRC)) {
    const file = relative(ROOT, path).split(sep).join(sep);
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        if (OFFENDING.some((pattern) => pattern.test(text))) {
          found.push({ file, line: i + 1, text: text.trim() });
        }
      });
  }
  return found;
}

describe('the environment scan', () => {
  it('finds nothing outside src/common/env.ts', () => {
    const outside = offenders().filter((hit) => hit.file !== REGISTRY_FILE);
    expect(outside.map((hit) => `${hit.file}:${hit.line} ${hit.text}`)).toEqual([]);
  });

  it('does find the reads inside it, so the scan is known to match', () => {
    expect(offenders().filter((hit) => hit.file === REGISTRY_FILE).length).toBeGreaterThan(0);
  });
});

describe('assertKnownEnv', () => {
  it('accepts an environment of registered variables and unrelated ones', () => {
    expect(() =>
      assertKnownEnv({ SPEICHER_LOG_LEVEL: 'error', HOME: '/root', PATH: '/bin' }),
    ).not.toThrow();
  });

  it('refuses a SPEICHER_ variable nobody reads, and names the nearest match', () => {
    expect(() => assertKnownEnv({ SPEICHER_DATABSE_URL: 'postgres://x' })).toFailWith(
      'env.unknown',
      { unknown: [{ name: 'SPEICHER_DATABSE_URL', suggestion: 'SPEICHER_DATABASE_URL' }] },
    );
  });

  it('suggests nothing when nothing is close', () => {
    let message = '';
    try {
      assertKnownEnv({ SPEICHER_QQQQQQQQQQQQ: '1' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('SPEICHER_QQQQQQQQQQQQ');
    expect(message).not.toContain('did you mean');
  });

  it('says the prefix is reserved, because a ${VAR} secret is the innocent case', () => {
    // Refused though nothing is near it: the name is under the reserved prefix
    expect(() => assertKnownEnv({ SPEICHER_GITHUB_KEY: 'x' })).toFailWith('env.unknown', {
      unknown: [{ name: 'SPEICHER_GITHUB_KEY', suggestion: null }],
    });
  });

  it('leaves the running environment alone', () => {
    expect(() => assertKnownEnv()).not.toThrow();
  });
});

describe('env', () => {
  const NAME = 'SPEICHER_DB_POOL';
  const original = process.env[NAME];
  afterEach(() => {
    if (original === undefined) delete process.env[NAME];
    else process.env[NAME] = original;
  });

  it('returns the declared default when unset', () => {
    delete process.env[NAME];
    expect(env(NAME)).toBe(10);
  });

  it('treats empty as unset, uniformly', () => {
    process.env[NAME] = '';
    expect(env(NAME)).toBe(10);
  });

  it('parses what is set', () => {
    process.env[NAME] = '25';
    expect(env(NAME)).toBe(25);
  });

  it('refuses a value that is not a positive integer', () => {
    process.env[NAME] = 'ten';
    expect(() => env(NAME)).toFailWith('env.invalid-value', { variable: NAME });
  });

  it('refuses a config source it does not recognise, as a ConfigError', () => {
    const before = process.env.SPEICHER_CONFIG_SOURCE;
    process.env.SPEICHER_CONFIG_SOURCE = 'postgres';
    try {
      expect(() => env('SPEICHER_CONFIG_SOURCE')).toRefuseWith('config.source-invalid');
    } finally {
      if (before === undefined) delete process.env.SPEICHER_CONFIG_SOURCE;
      else process.env.SPEICHER_CONFIG_SOURCE = before;
    }
  });

  it('falls back rather than throwing on an unrecognised log level', () => {
    const before = process.env.SPEICHER_LOG_LEVEL;
    process.env.SPEICHER_LOG_LEVEL = 'chatty';
    try {
      expect(env('SPEICHER_LOG_LEVEL')).toBe('info');
    } finally {
      if (before === undefined) delete process.env.SPEICHER_LOG_LEVEL;
      else process.env.SPEICHER_LOG_LEVEL = before;
    }
  });
});

describe('envReport', () => {
  it('never carries a secret value, set or unset', () => {
    const set = envReport({ SPEICHER_DATABASE_URL: 'postgres://u:hunter2@db/x' });
    const row = set.find((r) => r.name === 'SPEICHER_DATABASE_URL');
    expect(row).toMatchObject({ value: null, origin: 'environment', secret: true });
    expect(JSON.stringify(set)).not.toContain('hunter2');

    const unset = envReport({});
    expect(unset.find((r) => r.name === 'SPEICHER_DATABASE_URL')).toMatchObject({
      value: null,
      origin: 'default',
    });
  });

  it('reports what this process resolved, not what the documentation says', () => {
    const rows = envReport({ SPEICHER_TRUST_PROXY: 'loopback' });
    expect(rows.find((r) => r.name === 'SPEICHER_TRUST_PROXY')).toMatchObject({
      value: 'loopback',
      origin: 'environment',
    });
    expect(envReport({}).find((r) => r.name === 'SPEICHER_TRUST_PROXY')).toMatchObject({
      origin: 'default',
    });
  });

  it('covers every registered variable', () => {
    expect(envReport({}).map((r) => r.name)).toEqual(Object.keys(ENV_REGISTRY));
  });
});

describe('the registry', () => {
  it('owns every name it polices, and only PORT is outside the prefix', () => {
    const outsiders = (Object.keys(ENV_REGISTRY) as EnvName[]).filter(
      (name) => !name.startsWith('SPEICHER_'),
    );
    expect(outsiders).toEqual(['PORT']);
  });

  it('gives every variable a one-line description, because the table prints it', () => {
    for (const [name, spec] of Object.entries(ENV_REGISTRY)) {
      expect(spec.description.length).toBeGreaterThan(0);
      expect(spec.description).not.toContain('\n');
      expect(name).toBe(name.toUpperCase());
    }
  });
});

describe('the scripts outside the registry', () => {
  const NAMES = /SPEICHER_[A-Z0-9_]+/g;

  function tokensInScripts(): string[] {
    const dir = join(ROOT, 'scripts');
    const found = new Set<string>();
    for (const entry of readdirSync(dir)) {
      if (!statSync(join(dir, entry)).isFile()) continue;
      const text = readFileSync(join(dir, entry), 'utf8');
      for (const match of text.match(NAMES) ?? []) found.add(match);
    }
    return [...found].sort();
  }

  it('name only variables the registry knows, and has flagged', () => {
    const registered = new Set(Object.keys(ENV_REGISTRY));
    for (const name of tokensInScripts()) {
      expect(registered.has(name)).toBe(true);
      expect((ENV_REGISTRY[name as EnvName] as { alsoInScripts?: boolean }).alsoInScripts).toBe(
        true,
      );
    }
  });

  it('are actually being read, so the check is known to match', () => {
    expect(tokensInScripts().length).toBeGreaterThan(0);
  });
});

describe('how an entrypoint is spelled', () => {
  it('names the two processes rather than saying "both"', () => {
    expect(readByLabel('both')).toBe('web + worker');
    expect(readByLabel('web')).toBe('web');
    expect(readByLabel('worker')).toBe('worker');
  });

  it('is how the documentation spells it too', () => {
    expect(renderEnvTable()).toContain('| web + worker |');
    expect(renderEnvTable()).not.toContain('| both |');
  });
});

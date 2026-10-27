/**
 * Resolves ${VAR_NAME} in config values before validation.
 * Reports all missing or empty variables together.
 */

import { problem } from '../common/config-problems';
import { ConfigError } from '../common/errors';

// Matches ${VAR_NAME}; captures the variable name.
const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function interpolateEnv<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  const missing = new Set<string>();
  const out = walk(value, env, missing);
  if (missing.size > 0) {
    throw new ConfigError(
      problem('config.env-missing', null, {
        text: 'Config uses unset or empty environment variables.',
        dashboard:
          'Config uses unset or empty environment variables. Set them where Speicher runs, or replace the references with values here.',
      }),
      [...missing].sort().map((n) =>
        problem('env.unset', null, {
          text: `\${${n}} is unset or empty.`,
          facts: { variable: n },
        }),
      ),
    );
  }
  return out as T;
}

// Resolves references recursively and collects missing variables.
function walk(value: unknown, env: NodeJS.ProcessEnv, missing: Set<string>): unknown {
  if (typeof value === 'string') {
    return value.replace(VAR_PATTERN, (_match, name: string) => {
      const replacement = env[name];
      // Empty environment values count as missing.
      if (replacement === undefined || replacement === '') {
        missing.add(name);
        return '';
      }
      return replacement;
    });
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, env, missing));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = walk(v, env, missing);
    }
    return out;
  }
  return value;
}

export function containsInterpolation(source: string): boolean {
  VAR_PATTERN.lastIndex = 0;
  return VAR_PATTERN.test(source);
}

export function interpolationLine(source: string): number | null {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    VAR_PATTERN.lastIndex = 0;
    if (VAR_PATTERN.test(lines[i])) return i + 1;
  }
  return null;
}

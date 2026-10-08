/**
 * Environment variable interpolation in config values
 *
 * Strings in config may contain `${VAR_NAME}` references, this module replaces
 * them from process.env at load time, before validation
 *
 * Not implemented as a JSON reviver because we need to collect all missing
 * variables before throwing, not fail on the first one
 */

import { ConfigError } from '../common/errors';

// Matches ${VAR_NAME} where VAR_NAME starts with a letter or underscore and
// contains only alphanumeric or underscore characters
// Group 1: the variable name (without braces)
const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function interpolateEnv<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  const missing = new Set<string>();
  const out = walk(value, env, missing);
  if (missing.size > 0) {
    throw new ConfigError(
      'instance config references environment variables that are not set',
      [...missing].sort().map((n) => `\${${n}} is not set`),
    );
  }
  return out as T;
}

// Recursively walks a config tree, replacing ${VAR} in strings
// Missing or empty variables are collected but not immediately rejected
function walk(value: unknown, env: NodeJS.ProcessEnv, missing: Set<string>): unknown {
  if (typeof value === 'string') {
    return value.replace(VAR_PATTERN, (_match, name: string) => {
      const replacement = env[name];
      // Empty string is treated as missing because the caller likely meant to
      // set the var and forgot; an explicit empty var would use "" in the value
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

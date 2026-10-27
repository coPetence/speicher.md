/** Validate config schemas and format Ajv errors */
import Ajv2020, { ErrorObject, ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import { ConfigProblem, problem, wordingFor } from '../common/config-problems';
import instanceSchema from './schema/instance.schema.json';
import speicherSchema from './schema/speicher.schema.json';
import frontmatterSchema from './schema/frontmatter.schema.json';

const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  allowUnionTypes: true,
  validateFormats: true,
});
addFormats(ajv, { mode: 'full' });

export const validateInstanceSchema: ValidateFunction = ajv.compile(instanceSchema);
export const validateSpeicherSchema: ValidateFunction = ajv.compile(speicherSchema);
export const validateFrontmatterSchema: ValidateFunction = ajv.compile(frontmatterSchema);

/** Match a group list item's instance path */
const GROUP_ITEM = /^\/groups\/[^/]+\/\d+$/;

/** Names reserved for future group logic */
const RESERVED_COMBINATORS = new Set([
  'any',
  'all',
  'not',
  'and',
  'or',
  'except',
  'xor',
  'nor',
  'nand',
]);

/** Convert errors to deduplicated config problems, pointing missing keys to their fields */
export function ajvProblems(errors: ErrorObject[] | null | undefined): ConfigProblem[] {
  if (!errors?.length) return [];
  const seen = new Set<string>();
  const out: ConfigProblem[] = [];
  for (const err of errors) {
    const at = err.instancePath.replace(/^\//, '').replace(/\//g, '.');
    let path: string | null = at || null;
    let text = err.message ?? 'is not valid';
    if (err.keyword === 'additionalProperties') {
      const key = (err.params as { additionalProperty: string }).additionalProperty;
      text = `unknown key "${key}"`;
      if (GROUP_ITEM.test(err.instancePath) && RESERVED_COMBINATORS.has(key)) {
        text += `. The name "${key}" is reserved for future advanced logical expressions in group configuration.`;
      }
    }
    if (err.keyword === 'enum') {
      const allowed = (err.params as { allowedValues: unknown[] }).allowedValues;
      text = `expected one of: ${allowed.map((v) => JSON.stringify(v)).join(', ')}`;
    }
    if (err.keyword === 'required') {
      const key = (err.params as { missingProperty: string }).missingProperty;
      path = at ? `${at}.${key}` : key;
      text = 'is missing';
    }
    // Field labels omit the key
    const dashboard =
      err.keyword === 'required' ? 'Required' : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
    const p = problem(`schema.${err.keyword}`, path, { text, dashboard });
    const line = wordingFor(p, 'yaml');
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(p);
  }
  return out;
}

/** Format schema errors for repository files */
export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  return ajvProblems(errors).map((p) => wordingFor(p, 'yaml'));
}

export function splitUnknownKeyErrors(errors: ErrorObject[] | null | undefined): {
  unknownKeys: { path: string; key: string }[];
  rest: ErrorObject[];
} {
  const unknownKeys: { path: string; key: string }[] = [];
  const rest: ErrorObject[] = [];
  for (const err of errors ?? []) {
    if (err.keyword === 'additionalProperties') {
      unknownKeys.push({
        path: err.instancePath.replace(/^\//, '').replace(/\//g, '.'),
        key: (err.params as { additionalProperty: string }).additionalProperty,
      });
    } else {
      rest.push(err);
    }
  }
  return { unknownKeys, rest };
}

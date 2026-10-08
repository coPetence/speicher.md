/**
 * JSON Schema validation with Ajv 2020
 *
 * Three schemas are compiled: instance, speicher, and frontmatter
 * Errors are formatted for human-readable output with deduplication
 * Unknown-key errors are separated from schema violations for partial validation
 */
import Ajv2020, { ErrorObject, ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

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

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const err of errors) {
    const path = err.instancePath.replace(/^\//, '').replace(/\//g, '.') || '<root>';
    let message = `${path}: ${err.message}`;
    if (err.keyword === 'additionalProperties') {
      message = `${path}: unknown key "${(err.params as { additionalProperty: string }).additionalProperty}"`;
    }
    if (err.keyword === 'enum') {
      const allowed = (err.params as { allowedValues: unknown[] }).allowedValues;
      message = `${path}: must be one of ${allowed.map((v) => JSON.stringify(v)).join(', ')}`;
    }
    if (seen.has(message)) continue;
    seen.add(message);
    out.push(message);
  }
  return out;
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

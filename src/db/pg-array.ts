/**
 * Serialize and deserialize string arrays as PostgreSQL text array literals
 *
 * PostgreSQL text arrays are written as {elem1,elem2,...} with double-quoted
 * elements for values that contain commas, quotes or special characters
 *
 * Always double-quotes every element so serialization and parsing are symmetric
 * without inspecting values
 */

/** Serialize a string array to a PostgreSQL text array literal */
export function toPgTextArray(values: readonly string[]): string {
  if (values.length === 0) return '{}';
  return `{${values.map(quoteElement).join(',')}}`;
}

/** Escape backslashes first, then double quotes, then wrap in double quotes
 *
 * Escaping backslash before quote prevents the quote escape from doubling the
 * backslash already inserted */
function quoteElement(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Parse a PostgreSQL text array literal back into a string array
 *
 * Passes through if the driver already parsed value into an array
 * Returns empty array for non-string input
 */
export function fromPgTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value !== 'string') return [];
  const trimmed = value.replace(/^\{|\}$/g, '');
  if (trimmed === '') return [];
  return trimmed.split(',').map((v) => v.replace(/^"|"$/g, '').replace(/\\"/g, '"'));
}

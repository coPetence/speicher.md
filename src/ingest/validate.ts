/**
 * Validate config and content files during ingest
 *
 * `validateConfigFile` validates `.speicher.yaml` against schema and repo-level rules
 * `parseContentFile` parses Markdown files with optional YAML frontmatter
 *
 * Both produce findings and return null on rejection
 */
import { YamlError, parseStrictYaml } from '../common/yaml';
import { containsInterpolation, interpolationLine } from '../config/env-interpolation';
import {
  formatAjvErrors,
  splitUnknownKeyErrors,
  validateFrontmatterSchema,
  validateSpeicherSchema,
} from '../config/schemas';
import { Frontmatter, SpeicherConfig } from '../config/types';
import { FindingList } from './findings';

export interface ParsedConfigFile {
  config: SpeicherConfig;
  lineOf: (keyPath: string) => number | null; // Maps dotted key path to YAML source line
}

export interface ValidateConfigOptions {
  /** Source identifier for error messages, typically a file path */
  source: string;
  /** True when this is the repo root config */
  isRoot: boolean;
  /** Version from the root config, for validating folder configs match */
  rootVersion?: number;
}

/**
 * Validate a raw `.speicher.yaml` against schema and repo rules
 * Interpolation is forbidden: instance-config only
 * `content_branch` is reserved: v1 uses forge default branch
 * Folder configs reject root keys and must match root version
 */
export function validateConfigFile(
  raw: string,
  options: ValidateConfigOptions,
  findings: FindingList,
): ParsedConfigFile | null {
  // ${VAR} interpolation is instance-config only
  if (containsInterpolation(raw)) {
    findings.reject({
      code: 'interpolation-forbidden',
      source: options.source,
      line: interpolationLine(raw) ?? undefined,
      message:
        '${VAR} interpolation is not permitted in a repo or folder config. ' +
        'Environment interpolation is instance-config only.',
    });
    return null;
  }

  let parsed: ParsedConfigFile;
  try {
    const result = parseStrictYaml<SpeicherConfig>(raw);
    parsed = { config: (result.value ?? {}) as SpeicherConfig, lineOf: result.lineOf };
  } catch (err) {
    // Report YAML parse failure with line number
    findings.reject({
      code: 'yaml-malformed',
      source: options.source,
      line: err instanceof YamlError ? (err.line ?? undefined) : undefined,
      message: `malformed YAML: ${(err as Error).message}`,
    });
    return null;
  }

  if (parsed.config === null || typeof parsed.config !== 'object' || Array.isArray(parsed.config)) {
    findings.reject({
      code: 'schema-invalid',
      source: options.source,
      message: 'config must be a mapping',
    });
    return null;
  }

  if ('content_branch' in parsed.config) {
    findings.reject({
      code: 'content-branch-reserved',
      source: options.source,
      line: parsed.lineOf('content_branch') ?? undefined,
      message:
        '`content_branch` is reserved and rejected in v1. speicher.md tracks the forge default ' +
        'branch; a repo that needs to publish from elsewhere changes its default branch.',
    });
    return null;
  }

  const valid = validateSpeicherSchema(parsed.config);
  const { unknownKeys, rest } = splitUnknownKeyErrors(validateSpeicherSchema.errors);

  for (const { path, key } of unknownKeys) {
    findings.warn({
      code: 'unknown-key',
      source: options.source,
      line: parsed.lineOf(path ? `${path}.${key}` : key) ?? undefined,
      message: `unknown key "${path ? `${path}.${key}` : key}" — ignored`,
    });
    deleteAt(parsed.config as Record<string, unknown>, path, key);
  }

  if (!valid && rest.length > 0) {
    for (const message of formatAjvErrors(rest)) {
      findings.reject({
        code: 'schema-invalid',
        source: options.source,
        line: parsed.lineOf(message.split(':')[0]) ?? undefined,
        message,
      });
    }
    return null;
  }

  if (!options.isRoot) {
    if (parsed.config.ingest_root !== undefined) {
      findings.reject({
        code: 'root-key-in-folder',
        source: options.source,
        line: parsed.lineOf('ingest_root') ?? undefined,
        message: '`ingest_root` is a repo-root key and is rejected in a folder config',
      });
      return null;
    }
    if (parsed.config.maintainers !== undefined) {
      findings.reject({
        code: 'root-key-in-folder',
        source: options.source,
        line: parsed.lineOf('maintainers') ?? undefined,
        message: '`maintainers` is a repo-root key and is rejected in a folder config',
      });
      return null;
    }
    if (parsed.config.version !== undefined) {
      // Version in a folder must match the root config version
      if (options.rootVersion !== undefined && parsed.config.version !== options.rootVersion) {
        findings.reject({
          code: 'version-mismatch',
          source: options.source,
          line: parsed.lineOf('version') ?? undefined,
          message:
            `\`version: ${parsed.config.version}\` differs from the repo root's ` +
            `\`version: ${options.rootVersion}\``,
        });
        return null;
      }
      findings.info({
        code: 'version-in-folder',
        source: options.source,
        line: parsed.lineOf('version') ?? undefined,
        message: '`version` in a folder config is ignored; the repo root declares it',
      });
    }
  } else if (parsed.config.version === undefined) {
    findings.reject({
      code: 'schema-invalid',
      source: options.source,
      message: 'the repo root config must declare `version: 1`',
    });
    return null;
  }

  return parsed;
}

const FRONTMATTER_DELIMITER = /^---\r?\n/;

export interface ParsedContentFile {
  frontmatter: Frontmatter;
  /** Text content after the frontmatter block */
  body: string;
  /** Line offset of the body within the original file, for accurate error reporting */
  bodyLineOffset: number;
}

/**
 * Parse a Markdown file with optional YAML frontmatter
 * Frontmatter delimited by `---` lines; rest becomes body
 * Access-related keys in frontmatter rejected: access is directory-level
 * Returns parsed content or null on rejection
 */
export function parseContentFile(
  raw: string,
  source: string,
  findings: FindingList,
): ParsedContentFile | null {
  if (!FRONTMATTER_DELIMITER.test(raw)) {
    return { frontmatter: {}, body: raw, bodyLineOffset: 0 };
  }

  const rest = raw.replace(FRONTMATTER_DELIMITER, '');
  // Strip the opening --- delimiter

  // Matches closing --- (start-of-line) and captures line ending or end-of-string (Group 1)
  const end = rest.search(/^---\s*(\r?\n|$)/m);
  // Treat an unclosed frontmatter block as plain Markdown
  if (end === -1) {
    findings.warn({
      code: 'yaml-malformed',
      source,
      line: 1,
      message: 'frontmatter block is not closed by `---`; treating the file as plain Markdown',
    });
    return { frontmatter: {}, body: raw, bodyLineOffset: 0 };
  }

  const block = rest.slice(0, end);
  // Extract body content after the closing ---
  const after = rest.slice(end).replace(/^---\s*(\r?\n|$)/m, '');
  const bodyLineOffset = raw.slice(0, raw.length - after.length).split('\n').length - 1;

  let value: unknown;
  try {
    // Parse the frontmatter block as YAML
    value = parseStrictYaml(block).value ?? {};
  } catch (err) {
    findings.reject({
      code: 'yaml-malformed',
      source,
      line: err instanceof YamlError && err.line !== null ? err.line + 1 : 1,
      message: `malformed frontmatter: ${(err as Error).message}`,
    });
    return null;
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    findings.warn({
      code: 'schema-invalid',
      source,
      line: 1,
      message: 'frontmatter is not a mapping — ignored',
    });
    return { frontmatter: {}, body: after, bodyLineOffset };
  }

  const record = value as Record<string, unknown>;

  for (const forbidden of ['access', 'maintainers', 'groups', 'users']) {
    if (forbidden in record) {
      findings.reject({
        code: 'access-in-frontmatter',
        source,
        line: 1,
        message:
          `\`${forbidden}\` in frontmatter is rejected. Frontmatter never affects access — ` +
          'permissions are set per directory in `.speicher.yaml`.',
      });
      return null;
    }
  }

  const ok = validateFrontmatterSchema(record);
  const { unknownKeys, rest: realErrors } = splitUnknownKeyErrors(validateFrontmatterSchema.errors);
  for (const { key } of unknownKeys) {
    findings.warn({
      code: 'unknown-key',
      source,
      line: 1,
      message: `unknown frontmatter key "${key}" — ignored`,
    });
    delete record[key];
  }
  if (!ok && realErrors.length > 0) {
    for (const message of formatAjvErrors(realErrors)) {
      findings.reject({
        code: 'schema-invalid',
        source,
        line: 1,
        message: `frontmatter ${message}`,
      });
    }
    return null;
  }

  return { frontmatter: record as Frontmatter, body: after, bodyLineOffset };
}

function deleteAt(root: Record<string, unknown>, path: string, key: string): void {
  if (!path) {
    delete root[key];
    return;
  }
  let node: unknown = root;
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object') return;
    node = (node as Record<string, unknown>)[part];
  }
  if (node && typeof node === 'object') delete (node as Record<string, unknown>)[key];
}

/** Export config with secret references unless withSecrets is enabled */

import { ConfigError } from '../../../common/errors';
import { loadDocument, Path, serialise } from './document';
import { buildSections } from './fields';
import { allFields } from './model';
import { problem } from '../../../common/config-problems';

/** Header used to identify and replace previous export headers */
export const EXPORT_HEADER = '# Speicher instance configuration export';

export interface ConfigExport {
  yaml: string;
  /** Environment variables used in place of secrets */
  variables: string[];
}

export interface ExportOptions {
  /** Include secret values instead of variable references */
  withSecrets?: boolean;
  /** Instance host shown in the export header */
  host?: string;
  version?: number | null;
}

/** Convert a field path to an uppercase, underscore-separated variable name */
export function convertPathToVariableName(path: string): string {
  return path.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}

/** Remove an existing export header */
function withoutHeader(yaml: string): string {
  if (!yaml.startsWith(EXPORT_HEADER)) return yaml;
  const lineEnd = yaml.indexOf('\n');
  return lineEnd === -1 ? '' : yaml.slice(lineEnd + 1);
}

export function exportConfig(yaml: string, options: ExportOptions = {}): ConfigExport {
  const cleanedYamlData = withoutHeader(yaml);

  let doc;
  try {
    doc = loadDocument(cleanedYamlData);
  } catch (err) {
    // Unparseable YAML can only be exported with secrets unchanged
    if (options.withSecrets === true) return { yaml: cleanedYamlData, variables: [] };
    throw new ConfigError(
      problem('config.export-unparseable', null, {
        text: 'The configuration could not be parsed, so its secrets cannot be replaced. To export it with secrets, use the --with-secrets option.',
      }),
      // Preserve the parse error and its code when available
      err instanceof ConfigError
        ? [{ ...err.summary, path: null, text: err.message.split('\n')[0].replace(/:$/, '') }]
        : [problem('config.yaml-invalid', null, { text: (err as Error).message.split('\n')[0] })],
    );
  }

  const variables: string[] = [];
  if (options.withSecrets !== true) {
    for (const field of allFields(buildSections(doc))) {
      if (field.kind !== 'secret' || !field.secretHidden) continue;
      const name = convertPathToVariableName(field.path);
      const path: Path = field.path
        .split('.')
        .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
      doc.setIn(path, `\${${name}}`);
      variables.push(name);
    }
  }

  const body = variables.length > 0 ? serialise(doc) : cleanedYamlData;
  return { yaml: `${header(options)}\n${body}`, variables };
}

function header(options: ExportOptions): string {
  const connectionInfo = [
    options.host,
    options.version === null ? null : `version ${options.version}`,
  ]
    .filter(Boolean)
    .join(', ');

  return `${EXPORT_HEADER}${connectionInfo ? ` — ${connectionInfo}` : ''}`;
}

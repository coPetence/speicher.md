/**
 * Turns the stored configuration into a file that another instance can be started
 * from. Every literal secret is replaced by an environment variable reference, so the
 * file holds no secret values. With `withSecrets` the
 * secrets are written in as they are stored.
 */

import { ConfigError } from '../../../common/errors';
import { loadDocument, Path, serialise } from './document';
import { buildSections } from './fields';
import { allFields } from './model';

/** The first line of every exported file, which a later export recognises and replaces */
export const EXPORT_HEADER = '# Speicher instance configuration export';

export interface ConfigExport {
  yaml: string;
  /** The environment variables the document references in place of secrets */
  variables: string[];
}

export interface ExportOptions {
  /** Write secrets into the file rather than referencing them */
  withSecrets?: boolean;
  /** The host of the instance, written into the header comment of the exported file */
  host?: string;
  version?: number | null;
}

/**
 * variableNameFor returns the name of the environment variable that an exported
 * document references in place of the secret at the given path. The name is
 * the whole path in upper case, for example `AUTH_PROVIDERS_ENTRA_CLIENT_SECRET` for
 * `auth.providers.entra.client_secret`.
 */
export function convertPathToVariableName(path: string): string {
  return path.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}

/** Drop a header this function wrote earlier, so exports do not stack. */
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
    // When the document is unparseable, we cannot replace the secrets with their variable names. Therefore it is only possible to export the document with secrets in this case.
    if (options.withSecrets === true) return { yaml: cleanedYamlData, variables: [] };
    throw new ConfigError(
      'The configuration could not be parsed, so its secrets cannot be replaced. To export it with secrets, use the --with-secrets option.',
      [(err as Error).message.split('\n')[0].replace(/:$/, '')],
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

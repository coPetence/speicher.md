/**
 * Generated block syntax:
 * - cli [without:a,b]: CLI commands
 * - env-vars [NAME,NAME…]: all or selected environment variables
 * - schema <name>[#pointer] [key]: full reference or a table at a pointer
 * - schema <name> [without:a,b]: reference excluding top-level keys
 * - mcp-tools: MCP tools and parameters
 *
 * Schema tables use the pointer as the key path; use `key` to override it
 * `without:` excludes unreleased commands or top-level schema keys
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { COMMANDS } from '../../src/cli/commands';
import { renderEnvTable } from '../../src/common/env';
import { TOOL_DEFINITIONS } from '../../src/mcp/tools';
import { BlockSpec, DocsError } from './markers';
import { SchemaDoc, renderEntries, renderFacts, renderTable } from './schema-table';

const SCHEMA_DIR = resolve(__dirname, '../../src/config/schema');

export function generate(spec: BlockSpec): string {
  const without = new Set(
    spec.args.filter((a) => a.startsWith('without:')).flatMap((a) => a.slice(8).split(',')),
  );
  const kind = spec.kind;
  const args = spec.args.filter((a) => !a.startsWith('without:'));
  switch (kind) {
    case 'cli':
      expectArgs(kind, args, 0);
      return renderCli(without);
    case 'env-vars':
      expectArgs(kind, args, 1);
      return renderEnvTable(args[0]?.split(','));
    case 'schema':
      if (args.length < 1)
        throw new DocsError(
          'docs.schema-name-missing',
          'Missing schema name. Example: `schema instance`.',
        );
      expectArgs(kind, args, 2);
      return renderSchema(args[0], args[1], without);
    case 'mcp-tools':
      expectArgs(kind, args, 0);
      return renderMcpTools();
    default:
      throw new DocsError('docs.unknown-kind', `Unknown generated block type: ${kind}`);
  }
}

export function renderCli(without: ReadonlySet<string> = new Set()): string {
  unknownNames(without, Object.keys(COMMANDS));
  return Object.entries(COMMANDS)
    .filter(([name]) => !without.has(name))
    .map(([name, command]) =>
      [
        `## ${name}`,
        '',
        '```sh',
        `speicher ${name} ${command.args}`.trimEnd(),
        '```',
        '',
        command.summary,
      ].join('\n'),
    )
    .join('\n\n');
}

export function renderMcpTools(): string {
  return TOOL_DEFINITIONS.map((tool) => {
    // Skip the schema root row to show only parameters
    const [, ...parameters] = new SchemaDoc(tool.inputSchema).table('#', '').rows;
    const table = parameters.length > 0 ? renderTable({ rows: parameters, branches: [] }) : '';
    return [
      `## ${tool.name}`,
      `**${tool.title}**${tool.annotations.readOnlyHint ? ' · read-only' : ''}`,
      tool.description,
      table,
    ]
      .filter(Boolean)
      .join('\n\n');
  }).join('\n\n');
}

function renderSchema(
  target: string,
  key: string | undefined,
  without: ReadonlySet<string>,
): string {
  const [name, pointer] = target.split('#');
  const doc = new SchemaDoc(
    JSON.parse(readFileSync(resolve(SCHEMA_DIR, `${name}.schema.json`), 'utf8')),
  );
  if (without.size > 0 && pointer !== undefined) {
    throw new DocsError('docs.without-not-schema', 'Cannot use `without:` with a schema pointer.');
  }
  if (pointer !== undefined) return renderTable(doc.table(`#${pointer}`, key));
  if (key !== undefined)
    throw new DocsError('docs.key-without-pointer', 'A key argument requires a schema pointer.');
  const sections = doc.sections();
  unknownNames(
    without,
    sections.map((section) => section.key),
  );
  return sections
    .filter((section) => !without.has(section.key))
    .map(({ key: section, self, table }) =>
      [`## ${section}`, renderFacts(self), self.description, renderEntries(table)]
        .filter(Boolean)
        .join('\n\n'),
    )
    .join('\n\n');
}

/** Reject unknown exclusions to catch typos */
function unknownNames(without: ReadonlySet<string>, known: string[]): void {
  const unknown = [...without].filter((name) => !known.includes(name));
  if (unknown.length > 0)
    throw new DocsError(
      'docs.without-unknown',
      `Unknown names in \`without:\`: ${unknown.join(', ')}`,
    );
}

function expectArgs(kind: string, args: string[], max: number): void {
  if (args.length > max)
    throw new DocsError(
      'docs.too-many-arguments',
      `${kind}: expected at most ${max} ${max === 1 ? 'argument' : 'arguments'}, got ${args.length}: ${args.join(' ')}`,
    );
}

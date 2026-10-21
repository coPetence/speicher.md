/**
 * What each kind of generated block renders
 *
 *   <!-- generated: cli [without:a,b] -->              every command of the `speicher` CLI
 *   <!-- generated: env-vars [NAME,NAME…] -->          the env table, or only the named rows
 *   <!-- generated: schema <name>[#pointer] [key] -->  a key table from src/config/schema/<name>.schema.json
 *   <!-- generated: schema <name> [without:a,b] -->    the reference page, leaving out the named top-level keys
 *   <!-- generated: mcp-tools -->                      every tool of the MCP server, with its parameters
 *
 * A schema block without a pointer is a reference page: one section per top-level
 * key, and a heading for every key below it. With a pointer it is the table a guide
 * page ends with, its keys spelled from the pointer, or from `key` where the pointer
 * cannot say (a `$defs` entry has no place in the document until something refers
 * to it).
 *
 * `without:` leaves out commands or top-level keys that exist in code but are not
 * released yet, so the docs do not describe what readers cannot use.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { COMMANDS } from '../../src/cli/commands';
import { renderEnvTable } from '../../src/common/env';
import { TOOL_DEFINITIONS } from '../../src/mcp/tools';
import { BlockSpec } from './markers';
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
      if (args.length < 1) throw new Error('schema needs a schema name, e.g. `schema instance`');
      expectArgs(kind, args, 2);
      return renderSchema(args[0], args[1], without);
    case 'mcp-tools':
      expectArgs(kind, args, 0);
      return renderMcpTools();
    default:
      throw new Error(`unknown generated block kind: ${kind}`);
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
    // The tool's input schema is a document of its own, its parameters the top-level keys
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
    throw new Error('without: applies to a whole schema only');
  }
  if (pointer !== undefined) return renderTable(doc.table(`#${pointer}`, key));
  if (key !== undefined) throw new Error('a key needs a pointer to apply to');
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

/** A misspelt name in `without:` would quietly leave the thing in, so it is refused */
function unknownNames(without: ReadonlySet<string>, known: string[]): void {
  const unknown = [...without].filter((name) => !known.includes(name));
  if (unknown.length > 0) throw new Error(`without: names nothing called ${unknown.join(', ')}`);
}

function expectArgs(kind: string, args: string[], max: number): void {
  if (args.length > max)
    throw new Error(`${kind} takes at most ${max} argument(s), got: ${args.join(' ')}`);
}

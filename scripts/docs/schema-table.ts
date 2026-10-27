/** Render JSON schemas as dotted-key tables with branch tables and requirement notes */
import { DocsError } from './markers';

type Schema = { [keyword: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Row {
  key: string;
  type: string;
  default: string;
  required: string;
  description: string;
}

/** Object rows and nested branch tables */
export interface Table {
  rows: Row[];
  branches: { title: string; table: Table }[];
}

export class SchemaDoc {
  constructor(private readonly root: Schema) {}

  /** Look up a schema node by JSON pointer */
  at(pointer: string): Schema {
    const path = pointer.replace(/^#\/?/, '');
    if (path === '') return this.root;
    let node: unknown = this.root;
    for (const token of path.split('/')) {
      const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
      node = (node as Schema | undefined)?.[key];
      if (node === undefined)
        throw new DocsError('docs.schema-node-missing', `Schema node not found: ${pointer}`);
    }
    return node as Schema;
  }

  /** Convert a schema pointer to a dotted key path */
  static keyOf(pointer: string): string {
    const tokens = pointer.replace(/^#\/?/, '').split('/').filter(Boolean);
    const parts: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === 'properties' || tokens[i] === '$defs') parts.push(tokens[++i]);
      else if (tokens[i] === 'additionalProperties') parts.push('<name>');
      else if (tokens[i] === 'items') parts[parts.length - 1] += '[]';
    }
    return parts.join('.');
  }

  /** Build a table for a node and its descendants, node first */
  table(pointer: string, key = SchemaDoc.keyOf(pointer)): Table {
    const node = this.resolve(this.at(pointer));
    const table: Table = { rows: [this.row(node, key, '')], branches: [] };
    this.children(node, key, table);
    return table;
  }

  /** Build a reference section for each top-level key */
  sections(): { key: string; self: Row; table: Table }[] {
    return Object.keys(this.root.properties ?? {}).map((key) => {
      const { rows, branches } = this.table(`#/properties/${key}`, key);
      const required = (this.root.required ?? []).includes(key) ? 'yes' : '';
      return { key, self: { ...rows[0], required }, table: { rows: rows.slice(1), branches } };
    });
  }

  private resolve(node: Schema): Schema {
    let current = node;
    for (let hops = 0; typeof current.$ref === 'string'; hops++) {
      if (hops > 20)
        throw new DocsError(
          'docs.ref-cycle',
          `Schema reference chain too deep (possible cycle): ${current.$ref}`,
        );
      const { $ref, ...siblings } = current;
      if (!$ref.startsWith('#/'))
        throw new DocsError('docs.ref-not-local', `Schema reference must start with #/: ${$ref}`);
      // Sibling keywords override the referenced definition
      current = { ...this.at($ref), ...siblings };
    }
    return current;
  }

  private row(node: Schema, key: string, required: string): Row {
    const notes = [text(node.description ?? '')];
    const choice = requiredChoice(node);
    if (choice) notes.push(choice);
    const range = rangeOf(node);
    if (range) notes.push(range);
    if (Array.isArray(node.examples) && node.examples.length > 0) {
      notes.push(`Example: ${node.examples.map(code).join(', ')}.`);
    }
    return {
      key: code(key),
      type: this.typeOf(node),
      default: node.default === undefined ? '' : code(node.default),
      required,
      description: notes.filter(Boolean).join(' '),
    };
  }

  private children(node: Schema, key: string, table: Table): void {
    const required = new Set<string>(node.required ?? []);
    const conditions = conditionalRequired(node);
    for (const [name, child] of Object.entries<Schema>(node.properties ?? {})) {
      const childKey = key ? `${key}.${name}` : name;
      const resolved = this.resolve(child);
      const when = conditions.get(name);
      const needed = required.has(name) ? 'yes' : when ? `if ${when.join(' or ')}` : '';
      table.rows.push(this.row(resolved, childKey, needed));
      this.children(resolved, childKey, table);
    }

    if (isSchema(node.additionalProperties)) {
      const placeholder = /Id$/.test(refName(node.propertyNames) ?? '') ? '<id>' : '<name>';
      const childKey = `${key}.${placeholder}`;
      const value = this.resolve(node.additionalProperties);
      table.rows.push(this.row(value, childKey, ''));
      this.children(value, childKey, table);
    }

    if (isSchema(node.items)) {
      const item = this.resolve(node.items);
      const itemRow = this.row(item, `${key}[]`, '');
      // Add an item row only for a described object
      if (item.properties && itemRow.description) table.rows.push(itemRow);
      this.children(item, `${key}[]`, table);
    }

    for (const branch of this.branches(node)) {
      // Merge branches without a distinct label into this table
      if (branch.label === 'object') {
        this.children(branch.schema, key, table);
        continue;
      }
      const inner: Table = { rows: [], branches: [] };
      this.children(branch.schema, key, inner);
      table.branches.push({ title: `${code(key)} with ${branch.label}`, table: inner });
    }
  }

  /** Get `oneOf`/`anyOf` branches that define properties */
  private branches(node: Schema): { label: string; schema: Schema }[] {
    const options: Schema[] = node.oneOf ?? node.anyOf ?? [];
    return options
      .map((option) => this.resolve(option))
      .filter((schema) => schema.properties)
      .map((schema) => ({ label: discriminator(schema), schema }));
  }

  private typeOf(node: Schema): string {
    if (node.const !== undefined) return code(node.const);
    if (Array.isArray(node.enum)) return node.enum.map(code).join(', ');
    const options: Schema[] | undefined = node.oneOf ?? node.anyOf;
    if (options && !node.type && options.some((o) => o.type || o.$ref)) {
      const branches = this.branches(node);
      if (branches.length === options.length && branches.every((b) => b.label !== 'object')) {
        return `one of ${branches.map((b) => b.label).join(', ')}`;
      }
      return unique(options.map((o) => this.typeOf(this.resolve(o)))).join(' or ');
    }
    const types: string[] = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
    if (types.length === 0 && (node.properties || node.additionalProperties)) types.push('object');
    if (types.length === 0) return 'any';
    return types
      .map((type) => {
        if (type === 'array') {
          return node.items ? `list of ${this.typeOf(this.resolve(node.items))}` : 'list';
        }
        if (type === 'object' && isSchema(node.additionalProperties) && !node.properties)
          return 'map';
        if (type === 'string' && node.format) return `string (${node.format})`;
        return type;
      })
      .join(' or ');
  }
}

/** Render a Markdown table with branch headings starting at `level` */
export function renderTable(table: Table, level = 3): string {
  const parts: string[] = [];
  if (table.rows.length > 0) {
    const lines = [
      '| Key | Type | Default | Required | Description |',
      '| --- | --- | --- | --- | --- |',
    ];
    for (const row of table.rows) {
      const cells = [row.key, row.type, row.default, row.required, row.description];
      lines.push(`| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`);
    }
    parts.push(lines.join('\n'));
  }
  for (const branch of table.branches) {
    parts.push(`${'#'.repeat(level)} ${branch.title}`, renderTable(branch.table, level + 1));
  }
  return parts.join('\n\n');
}

/** Render keys as reference headings with facts and prose descriptions */
export function renderEntries(table: Table, level = 3): string {
  const parts: string[] = [];
  const heading = '#'.repeat(level);
  for (const row of table.rows) {
    parts.push(`${heading} ${row.key}`, renderFacts(row));
    if (row.description) parts.push(row.description);
  }
  for (const branch of table.branches) {
    parts.push(`${heading} ${branch.title}`, renderEntries(branch.table, level + 1));
  }
  return parts.join('\n\n');
}

/** Render type, default and requirement on one line */
export function renderFacts(row: Row): string {
  const facts = [`**Type:** ${row.type}`];
  if (row.default) facts.push(`**Default:** ${row.default}`);
  if (row.required === 'yes') facts.push('**Required**');
  else if (row.required) facts.push(`**Required ${row.required.replace(/^if /, 'if** ')}`);
  return facts.join(' · ');
}

/** Label a branch by its first const property, title or `object` */
function discriminator(schema: Schema): string {
  for (const [name, property] of Object.entries<Schema>(schema.properties ?? {})) {
    if (property.const !== undefined) return code(`${name}: ${property.const}`);
  }
  return schema.title ?? 'object';
}

/** Map required keys to their `allOf`/`if`/`then` conditions */
function conditionalRequired(node: Schema, outer: string[] = []): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const part of (node.allOf ?? []) as Schema[]) {
    const condition = describeIf(part.if);
    if (!condition || !part.then) continue;
    const all = [...outer, condition];
    for (const name of (part.then.required ?? []) as string[]) {
      found.set(name, [...(found.get(name) ?? []), all.join(' and ')]);
    }
    for (const [name, inner] of conditionalRequired(part.then, all)) {
      found.set(name, [...(found.get(name) ?? []), ...inner]);
    }
  }
  return found;
}

function describeIf(test: Schema | undefined): string | undefined {
  const entries = Object.entries<Schema>(test?.properties ?? {});
  if (entries.length !== 1) return undefined;
  const [name, property] = entries[0];
  if (property.const !== undefined) return code(`${name}: ${property.const}`);
  if (Array.isArray(property.enum)) return `${code(name)} is ${property.enum.map(code).join(', ')}`;
  return undefined;
}

/** Describe `oneOf` choices that only specify required keys */
function requiredChoice(node: Schema): string | undefined {
  const options: Schema[] | undefined = node.oneOf;
  if (!options || !options.every((o) => o.required && !o.properties && !o.type && !o.$ref)) {
    return undefined;
  }
  const sets = options.map((o) => (o.required as string[]).map(code).join(' + '));
  return `Set exactly one of: ${sets.join(', ')}.`;
}

/** Describe numeric bounds */
function rangeOf(node: Schema): string | undefined {
  const { minimum: min, maximum: max } = node;
  if (min !== undefined && max !== undefined) return `Between ${min} and ${max}.`;
  if (min !== undefined) return `At least ${min}.`;
  if (max !== undefined) return `At most ${max}.`;
  return undefined;
}

function refName(node: Schema | undefined): string | undefined {
  return typeof node?.$ref === 'string' ? node.$ref.split('/').pop() : undefined;
}

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function code(value: unknown): string {
  return '`' + (typeof value === 'string' ? value : JSON.stringify(value)) + '`';
}

/** Flatten descriptions and escape `<` outside code spans */
export function text(description: string): string {
  return description
    .replace(/\s*\n\s*/g, ' ')
    .trim()
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/</g, '&lt;')))
    .join('');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

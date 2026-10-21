/**
 * Renders a JSON schema as key tables for the docs
 *
 * Every key becomes a row named by its full dotted path from the document root, so a
 * table on a guide page reads the same as the matching rows of the reference page.
 * A map's key is shown as `<id>` or `<name>`, a list item as `[]`. A `oneOf` whose
 * branches carry properties (the auth providers) gets one table per branch, since
 * the branches share key names that mean different things; a `oneOf` that only picks
 * required keys becomes a note on its row. `if`/`then` pairs that make a key required
 * show up in the Required column as the condition.
 */

type Schema = { [keyword: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Row {
  key: string;
  type: string;
  default: string;
  required: string;
  description: string;
}

/** The rows of one object, and a table per `oneOf` branch found below it */
export interface Table {
  rows: Row[];
  branches: { title: string; table: Table }[];
}

export class SchemaDoc {
  constructor(private readonly root: Schema) {}

  /** The schema node at a JSON pointer such as `#/properties/mail` */
  at(pointer: string): Schema {
    const path = pointer.replace(/^#\/?/, '');
    if (path === '') return this.root;
    let node: unknown = this.root;
    for (const token of path.split('/')) {
      const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
      node = (node as Schema | undefined)?.[key];
      if (node === undefined) throw new Error(`no schema node at ${pointer}`);
    }
    return node as Schema;
  }

  /** The key path a pointer stands for, e.g. `#/properties/auth/properties/providers` is `auth.providers` */
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

  /** The node at `pointer` and everything below it, the node's own row first */
  table(pointer: string, key = SchemaDoc.keyOf(pointer)): Table {
    const node = this.resolve(this.at(pointer));
    const table: Table = { rows: [this.row(node, key, '')], branches: [] };
    this.children(node, key, table);
    return table;
  }

  /** One section per top-level key, the shape of a reference page */
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
      if (hops > 20) throw new Error(`$ref cycle at ${current.$ref}`);
      const { $ref, ...siblings } = current;
      if (!$ref.startsWith('#/')) throw new Error(`only local $refs are supported: ${$ref}`);
      // A sibling of the $ref describes this use of the shared definition, so it wins
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
      // The item only earns a row when it says something its list's row does not
      if (item.properties && itemRow.description) table.rows.push(itemRow);
      this.children(item, `${key}[]`, table);
    }

    for (const branch of this.branches(node)) {
      // A branch with nothing to tell it apart, like `access` as a list or an object, adds to this table
      if (branch.label === 'object') {
        this.children(branch.schema, key, table);
        continue;
      }
      const inner: Table = { rows: [], branches: [] };
      this.children(branch.schema, key, inner);
      table.branches.push({ title: `${code(key)} with ${branch.label}`, table: inner });
    }
  }

  /** The `oneOf`/`anyOf` branches that declare properties of their own */
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

/** A table, followed by one table per branch under a heading of `level`, for a guide page */
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

/**
 * The same keys as a heading each, for a reference page: every key gets an anchor to
 * link to, and a long description reads as prose rather than wrapping in a cell
 */
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

/** Type, default and whether it is required, as one line under a key's heading */
export function renderFacts(row: Row): string {
  const facts = [`**Type:** ${row.type}`];
  if (row.default) facts.push(`**Default:** ${row.default}`);
  if (row.required === 'yes') facts.push('**Required**');
  else if (row.required) facts.push(`**Required ${row.required.replace(/^if /, 'if** ')}`);
  return facts.join(' · ');
}

/** `type: oidc` for a branch whose `type` is a const, else its title or JSON type */
function discriminator(schema: Schema): string {
  for (const [name, property] of Object.entries<Schema>(schema.properties ?? {})) {
    if (property.const !== undefined) return code(`${name}: ${property.const}`);
  }
  return schema.title ?? 'object';
}

/** Keys an `allOf` of `if`/`then` pairs makes required, with the conditions under which they are */
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

/** A `oneOf` that only chooses which keys are required, e.g. `subject` + `note` or `email` */
function requiredChoice(node: Schema): string | undefined {
  const options: Schema[] | undefined = node.oneOf;
  if (!options || !options.every((o) => o.required && !o.properties && !o.type && !o.$ref)) {
    return undefined;
  }
  const sets = options.map((o) => (o.required as string[]).map(code).join(' + '));
  return `Set exactly one of: ${sets.join(', ')}.`;
}

/** `Between 1 and 50.` for a number with bounds, so a table states the limits the validator enforces */
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

/**
 * A description as one line of Markdown. A table cell cannot hold a line break, and
 * a bare `<provider>` outside a code span would be read as an HTML tag and dropped.
 */
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

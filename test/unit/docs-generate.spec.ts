import { relative, resolve } from 'node:path';

import { COMMANDS } from '../../src/cli/commands';
import { renderEnvTable } from '../../src/common/env';
import { TOOL_DEFINITIONS } from '../../src/mcp/tools';
import { staleDocs } from '../../scripts/docs-generate';
import { generate, renderCli, renderMcpTools } from '../../scripts/docs/generators';
import { regenerate } from '../../scripts/docs/markers';
import {
  SchemaDoc,
  renderEntries,
  renderFacts,
  renderTable,
  text,
} from '../../scripts/docs/schema-table';

const ROOT = resolve(__dirname, '../..');

describe('a generated block', () => {
  const echo = ({ kind, args }: { kind: string; args: string[] }) => `${kind}(${args.join(',')})`;

  it('is rewritten between its markers and nothing else is touched', () => {
    const before = 'intro\n<!-- generated: thing a b -->\nstale\n<!-- /generated -->\noutro\n';
    expect(regenerate(before, echo, 'x.md')).toBe(
      'intro\n<!-- generated: thing a b -->\n<!-- prettier-ignore-start -->\nthing(a,b)\n' +
        '<!-- prettier-ignore-end -->\n<!-- /generated -->\noutro\n',
    );
  });

  it('comes out the same when generated twice', () => {
    const once = regenerate('<!-- generated: a -->\n<!-- /generated -->', echo, 'x.md');
    expect(regenerate(once, echo, 'x.md')).toBe(once);
  });

  it('names the file and line when its end marker is missing or its kind is unknown', () => {
    expect(() => regenerate('\n\n<!-- generated: a -->\n', echo, 'x.md')).toFailWith(
      'docs.unclosed-block',
      { file: 'x.md', line: 3 },
    );
    expect(() =>
      regenerate('<!-- generated: nope -->\n<!-- /generated -->', generate, 'y.md'),
    ).toFailWith('docs.unknown-kind', { file: 'y.md', line: 1 });
  });
});

describe('the env table', () => {
  it('can be narrowed to the variables a page is about, in the order given', () => {
    const rows = renderEnvTable(['PORT', 'SPEICHER_TRUST_PROXY']).split('\n').slice(2);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^\| `PORT` /);
    expect(rows[1]).toMatch(/^\| `SPEICHER_TRUST_PROXY` /);
  });

  it('refuses a variable the registry does not know', () => {
    expect(() => renderEnvTable(['SPEICHER_NOPE'])).toFailWith('env.unknown', {
      unknown: [{ name: 'SPEICHER_NOPE', suggestion: null }],
    });
  });
});

describe('the CLI reference', () => {
  it('has a section for every command, with its arguments', () => {
    const reference = renderCli();
    for (const [name, command] of Object.entries(COMMANDS)) {
      expect(reference).toContain(`## ${name}\n`);
      expect(reference).toContain(`speicher ${name} ${command.args}`.trimEnd());
    }
  });
});

describe('leaving out what is not released', () => {
  it('drops the named commands and top-level keys', () => {
    expect(generate({ kind: 'cli', args: ['without:reembed,claim'] })).not.toMatch(
      /## (reembed|claim)\n/,
    );
    const reference = generate({ kind: 'schema', args: ['instance', 'without:embedding'] });
    expect(reference).not.toContain('## embedding');
    expect(reference).toContain('## mail');
  });

  it('refuses a name that matches nothing, which would leave the thing in', () => {
    expect(() => generate({ kind: 'cli', args: ['without:reembedd'] })).toFailWith(
      'docs.without-unknown',
    );
    expect(() =>
      generate({ kind: 'schema', args: ['instance#/properties/mail', 'without:mail'] }),
    ).toFailWith('docs.without-not-schema');
  });
});

describe('the MCP tools reference', () => {
  it('lists every tool with its parameters and their limits', () => {
    const reference = renderMcpTools();
    for (const tool of TOOL_DEFINITIONS) expect(reference).toContain(`## ${tool.name}\n`);
    expect(reference).toContain('| `query` | string |  | yes | The text to search for. |');
    expect(reference).toContain('| `limit` | integer | `10` |  | Between 1 and 50. |');
  });
});

describe('a schema table', () => {
  const doc = new SchemaDoc({
    type: 'object',
    properties: {
      store: {
        type: 'object',
        required: ['driver'],
        properties: {
          driver: { enum: ['disk', 's3'], default: 'disk' },
          bucket: { type: 'string', description: 'Named like `<bucket>`, not <bucket>.' },
        },
        allOf: [
          { if: { properties: { driver: { const: 's3' } } }, then: { required: ['bucket'] } },
        ],
      },
      providers: {
        type: 'object',
        propertyNames: { $ref: '#/$defs/shortId' },
        additionalProperties: { oneOf: [{ $ref: '#/$defs/oidc' }, { $ref: '#/$defs/link' }] },
      },
      users: { type: 'array', items: { $ref: '#/$defs/grant' } },
    },
    $defs: {
      shortId: { type: 'string' },
      oidc: { type: 'object', properties: { type: { const: 'oidc' }, issuer: { type: 'string' } } },
      link: { type: 'object', properties: { type: { const: 'link' } } },
      grant: {
        type: 'object',
        oneOf: [{ required: ['subject', 'note'] }, { required: ['email'] }],
        properties: { email: { type: 'string', format: 'email' } },
      },
    },
  });

  it('spells every key as its full path and shows the condition that makes it required', () => {
    const { rows } = doc.table('#/properties/store');
    expect(rows.map((r) => [r.key, r.type, r.default, r.required])).toEqual([
      ['`store`', 'object', '', ''],
      ['`store.driver`', '`disk`, `s3`', '`disk`', 'yes'],
      ['`store.bucket`', 'string', '', 'if `driver: s3`'],
    ]);
  });

  it('gives each branch of a oneOf its own table, under the map key', () => {
    const table = doc.table('#/properties/providers');
    expect(table.rows[1]).toMatchObject({
      key: '`providers.<id>`',
      type: 'one of `type: oidc`, `type: link`',
    });
    expect(table.branches.map((b) => b.title)).toEqual([
      '`providers.<id>` with `type: oidc`',
      '`providers.<id>` with `type: link`',
    ]);
    expect(table.branches[0].table.rows.map((r) => r.key)).toContain('`providers.<id>.issuer`');
    expect(renderTable(table)).toContain('### `providers.<id>` with `type: oidc`');
  });

  it('notes on a list item which keys it needs one set of', () => {
    const { rows } = doc.table('#/properties/users');
    expect(rows.map((r) => r.key)).toEqual(['`users`', '`users[]`', '`users[].email`']);
    expect(rows[1].description).toBe('Set exactly one of: `subject` + `note`, `email`.');
    expect(rows[2].type).toBe('string (email)');
  });

  it('takes the key from the block when the pointer is a definition', () => {
    expect(doc.table('#/$defs/oidc', 'auth.providers.<id>').rows.map((r) => r.key)).toEqual([
      '`auth.providers.<id>`',
      '`auth.providers.<id>.type`',
      '`auth.providers.<id>.issuer`',
    ]);
  });

  it('gives every key a heading of its own on a reference page', () => {
    const entries = renderEntries(doc.table('#/properties/store'));
    expect(entries).toContain(
      '### `store.bucket`\n\n**Type:** string · **Required if** `driver: s3`\n\n' +
        'Named like `<bucket>`, not &lt;bucket>.',
    );
    expect(entries).toContain(
      '### `store.driver`\n\n**Type:** `disk`, `s3` · **Default:** `disk` · **Required**',
    );
    expect(renderEntries(doc.table('#/properties/providers'))).toContain(
      '### `providers.<id>` with `type: oidc`\n\n#### `providers.<id>.type`',
    );
  });

  it('says nothing about a key that is neither required nor defaulted', () => {
    expect(renderFacts(doc.table('#/properties/users').rows[2])).toBe('**Type:** string (email)');
  });

  it('keeps a description on one line and out of reach of the HTML parser', () => {
    expect(text('Named like `<bucket>`,\n  not <bucket>.')).toBe(
      'Named like `<bucket>`, not &lt;bucket>.',
    );
  });
});

describe('the generated docs in this repository', () => {
  it('are what the generators render now; run `npm run docs:generate` if not', () => {
    expect(staleDocs().map(({ path }) => relative(ROOT, path))).toEqual([]);
  });
});

interface LintMessage {
  ruleId: string | null;
  message: string;
}
interface LintResult {
  messages: LintMessage[];
}
interface ESLintInstance {
  lintText(code: string, options: { filePath: string }): Promise<LintResult[]>;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { ESLint } = require('eslint') as {
  ESLint: new (options: { cwd: string }) => ESLintInstance;
};

const lint = new ESLint({ cwd: process.cwd() });

async function messagesFor(code: string, filePath = 'src/__lint_probe__.ts'): Promise<string[]> {
  const [result] = await lint.lintText(code, { filePath });
  return result.messages
    .filter((m: LintMessage) => m.ruleId === 'no-restricted-syntax')
    .map((m: LintMessage) => m.message);
}

describe('the content-table lint rule', () => {
  it('catches a template literal, which is how every query here is written', async () => {
    const messages = await messagesFor(
      'declare const db: any;\nexport const q = () => db.query(`SELECT 1 FROM documents WHERE x = :y`);\n',
    );
    expect(messages).toHaveLength(1);
  });

  it('still catches a plain string literal', async () => {
    const messages = await messagesFor(
      "declare const db: any;\nexport const q = () => db.query('SELECT 1 FROM documents');\n",
    );
    expect(messages).toHaveLength(1);
  });

  it.each(['documents', 'folders', 'assets', 'document_edges', 'document_terms', 'chunks'])(
    'guards %s',
    async (table) => {
      const messages = await messagesFor(
        `declare const db: any;\nexport const q = () => db.query(\`SELECT 1 FROM ${table}\`);\n`,
      );
      expect(messages).toHaveLength(1);
    },
  );

  it('leaves a query against a non-content table alone', async () => {
    const messages = await messagesFor(
      'declare const db: any;\nexport const q = () => db.query(`SELECT 1 FROM sync_runs`);\n',
    );
    expect(messages).toEqual([]);
  });

  // The exemption is a directory, so it is a glob, and a glob is one edit away from
  // covering its parent. Both halves: the access path itself is exempt, and a file
  // beside it in `src/authz/` is not.
  it('exempts src/authz/content/ and nothing next to it', async () => {
    const query =
      'declare const db: any;\nexport const q = () => db.query(`SELECT 1 FROM documents`);\n';
    expect(await messagesFor(query, 'src/authz/content/__lint_probe__.ts')).toEqual([]);
    expect(await messagesFor(query, 'src/authz/__lint_probe__.ts')).toHaveLength(1);
  });
});

describe('the error-wording lint rule', () => {
  const inTest = (code: string, file = 'test/unit/__lint_probe__.spec.ts') =>
    messagesFor(`declare const f: () => void;\ndeclare const p: Promise<void>;\n${code}\n`, file);

  it.each([
    ['a regex', 'expect(f).toThrow(/wording/);'],
    ['a string', "expect(f).toThrow('wording');"],
    ['a template literal', 'expect(f).toThrow(`wording`);'],
    ['a rejection', 'void expect(p).rejects.toThrow(/wording/);'],
    ['toThrowError', 'expect(f).toThrowError(/wording/);'],
  ])('catches an error asserted by %s', async (_, code) => {
    expect(await inTest(code)).toHaveLength(1);
  });

  it('leaves an error asserted by what it is alone', async () => {
    expect(
      await inTest(
        'expect(f).toThrow(Error);\nexpect(f).toThrow();\nexpect(f).toRefuseWith("admins.none");\nexpect(f).toFailWith("usage.unknown-argument");',
      ),
    ).toEqual([]);
  });

  // There is no file list: an error that has no code gets one, rather than a test
  // file that may assert its wording
  it('applies to every test file, with no file exempt', async () => {
    expect(await inTest('expect(f).toThrow(/usage/);', 'test/unit/cli.spec.ts')).toHaveLength(1);
  });

  it('is a rule for tests, not for the code under them', async () => {
    expect(await inTest('expect(f).toThrow(/wording/);', 'src/__lint_probe__.ts')).toEqual([]);
  });
});

describe('the check-status lint rule', () => {
  const inTest = (code: string) =>
    messagesFor(
      `declare const status: { code: string; level: string; label: string; detail: string };\ndeclare const field: { status?: typeof status } | undefined;\n${code}\n`,
      'test/unit/__lint_probe__.spec.ts',
    );

  it.each([
    ['a label', "expect(status.label).toBe('Connected');"],
    ['a detail', "expect(status.detail).toContain('does not exist');"],
    ['a detail by regex', 'expect(status.detail).toMatch(/not saved/);'],
    ['an optional chain', "expect(field?.status?.label).toBe('Connected');"],
    ['a status object', "expect(status).toMatchObject({ level: 'ok', label: 'Connected' });"],
  ])('catches a status asserted by %s', async (_, code) => {
    expect(await inTest(code)).toHaveLength(1);
  });

  it('leaves a status asserted by its code and facts alone', async () => {
    expect(
      await inTest(
        "expect(status).toMatchObject({ code: 'store.missing', level: 'fail', facts: { target: 'x' } });\nexpect(status.code).toBe('store.missing');",
      ),
    ).toEqual([]);
  });

  it('leaves an object without a level alone, which is not a status', async () => {
    expect(await inTest("expect(status).toEqual({ value: '', label: 'Not configured' });")).toEqual(
      [],
    );
  });
});

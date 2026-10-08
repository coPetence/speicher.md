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

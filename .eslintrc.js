module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true, jest: true },
  ignorePatterns: ['dist/', 'node_modules/', 'test/fixtures/**/*.md'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'arrow-body-style': ['error', 'as-needed'],
    'no-restricted-syntax': [
      'error',
      // Require content SQL to use src/authz/content/ for authorization
      // Cover strings and templates; test/unit/lint-rule.spec.ts checks both
      // Graph tables and chunks need authorization joins; analytics tables hold private activity
      {
        selector:
          "CallExpression[callee.property.name='query'] > Literal[value=/\\b(from|join|into|update)\\s+(documents|folders|assets|document_edges|document_terms|chunks|page_views|search_misses)\\b/i]",
        message:
          'Direct SQL against content tables is forbidden. Go through the repositories in src/authz/content/.',
      },
      {
        selector:
          "CallExpression[callee.property.name='query'] > TemplateLiteral > TemplateElement[value.raw=/\\b(from|join|into|update)\\s+(documents|folders|assets|document_edges|document_terms|chunks|page_views|search_misses)\\b/i]",
        message:
          'Direct SQL against content tables is forbidden. Go through the repositories in src/authz/content/.',
      },
    ],
  },
  // Centralize exemptions for authorization, writes, and non-content operations
  overrides: [
    {
      // Repositories enforce principals via authorizedSql or visibleFolderSql
      // ContentReports documents its exception; graph and chunk reads require authorization joins
      files: ['src/authz/content/**'],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      // Write-only paths build effective_principals; no reads on a caller's behalf
      files: ['src/ingest/write/**', 'src/cli/rebuild.ts'],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      // Route-gated admin access checks intentionally ignore caller principals
      files: ['src/authz/explain.ts'],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      // Magic-link eligibility check returns only an EXISTS boolean
      files: ['src/auth/magic-link.service.ts'],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      // Route-gated admin read counts expose paths, not content or reader identities
      files: ['src/dashboard/analytics/analytics.repository.ts'],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      // Record activity and delete old rows; no content reads
      files: [
        'src/dashboard/analytics/analytics.service.ts',
        'src/dashboard/analytics/retention.ts',
      ],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      // Route-gated pre-rename usage check returns repositories and counts, not paths or titles
      files: ['src/dashboard/configurator/member-usage.ts'],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      // Embedding writes, index DDL, and re-embedding; no caller-facing content reads
      // Re-embedding touches embeddings, not text; semantic reads must use the repository
      files: ['src/embed/embed.service.ts', 'src/embed/vector-index.ts', 'src/embed/reembed.ts'],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      // Tests need direct row access to verify isolation
      // This override replaces the SQL rule with error-assertion checks
      // Use toFailWith(code) or toRefuseWith(code), not error wording
      // External error text requires a justified inline eslint-disable
      // Cover strings and templates; test/unit/lint-rule.spec.ts checks both
      files: ['test/**/*.ts'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector:
              "CallExpression[callee.property.name=/^toThrow(Error)?$/][arguments.0.type='Literal']",
            message:
              'Assert an error by its code, not its wording: toFailWith(code), or toRefuseWith(code) for a config refusal.',
          },
          {
            selector:
              "CallExpression[callee.property.name=/^toThrow(Error)?$/][arguments.0.type='TemplateLiteral']",
            message:
              'Assert an error by its code, not its wording: toFailWith(code), or toRefuseWith(code) for a config refusal.',
          },
          // A live check is asserted by its code and facts, not its label or detail
          {
            selector:
              'CallExpression[callee.property.name=/^(toBe|toContain|toMatch|toEqual)$/][arguments.0.type=/^(Literal|TemplateLiteral)$/][callee.object.arguments.0.property.name=/^(label|detail)$/]',
            message:
              "Assert a check's status by its code and facts, not its label or detail: toMatchObject({ code, facts }).",
          },
          {
            selector:
              'CallExpression[callee.property.name=/^(toBe|toContain|toMatch|toEqual)$/][arguments.0.type=/^(Literal|TemplateLiteral)$/][callee.object.arguments.0.expression.property.name=/^(label|detail)$/]',
            message:
              "Assert a check's status by its code and facts, not its label or detail: toMatchObject({ code, facts }).",
          },
          {
            selector:
              "CallExpression[callee.property.name=/^(toMatchObject|toEqual|toStrictEqual)$/] ObjectExpression:has(> Property[key.name='level']) > Property[key.name=/^(label|detail)$/][value.type=/^(Literal|TemplateLiteral)$/]",
            message:
              "Assert a check's status by its code and facts, not its label or detail: toMatchObject({ code, facts }).",
          },
        ],
      },
    },
  ],
};

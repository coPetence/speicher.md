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
      // No SQL against content tables outside `src/authz/content/`, whose read paths
      // all take `principals` first. That directory is the first exemption below.
      //
      // Two selectors, because queries here are template literals and a `Literal`
      // selector does not match those. The rule caught nothing until the second form
      // was added -- a guard that silently matches nothing is worse than none.
      // `test/unit/lint-rule.spec.ts` keeps that from happening again.
      //
      // `documents`/`folders`/`assets` carry `effective_principals` and are what a
      // reader is filtered against. `document_edges`/`document_terms`/`chunks` hold
      // no principals -- their authorization is the pair of joins in the repository,
      // so reading them elsewhere leaks page existence/names, or chunk text verbatim.
      // `page_views`/`search_misses` are a path someone opened and text someone typed.
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
  // Exemptions, each named with its reason. A file list rather than scattered
  // eslint-disable comments, so claims live where the invariant is stated.
  // The rule is about *reading content on a caller's behalf*; writing, deleting, and
  // operational questions that return no content are different acts.
  overrides: [
    {
      // The access path itself. Every repository here takes `principals` as a
      // required first argument and routes through `authorizedSql` /
      // `visibleFolderSql`; `ContentReports` is the one class that takes none, and
      // its doc comment says why it lives here rather than beside its callers.
      //
      // The graph tables and `chunks` are in the rule even though they hold no
      // `effective_principals` of their own — *because* they hold none. An edge is
      // exactly as visible as the two pages it joins, a chunk exactly as visible as
      // the page its text came off, and the only thing enforcing either is a join
      // written in this directory. A query elsewhere reading `document_edges` alone
      // would be reading which pages exist and what they are called; one reading
      // `chunks` alone would be reading their text verbatim.
      files: ['src/authz/content/**'],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      // Write path: materialises `effective_principals`, never consults them (no caller).
      // Write phases only — anything in `src/ingest/write/` that reads on a caller's
      // behalf would be hiding behind this line.
      files: ['src/ingest/write/**', 'src/cli/rebuild.ts'],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      // Answers "who can read this" for admins about content they cannot read, so it
      // deliberately does not filter by caller principals; the route gates it.
      files: ['src/authz/explain.ts'],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      // EXISTS probe for whether an unknown address is worth a magic link. Returns a
      // boolean, never a row.
      files: ['src/auth/magic-link.service.ts'],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      // Read-counts report; admin-only, gated by the route, no caller principals.
      // Names paths (like /-/graph calls paths) but never page content, and no row
      // says who read one.
      files: ['src/dashboard/analytics/analytics.repository.ts'],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      // The recorder's writes and retention sweep. Never reads content on a caller's
      // behalf; retention deletes by age and selects no row.
      files: [
        'src/dashboard/analytics/analytics.service.ts',
        'src/dashboard/analytics/retention.ts',
      ],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      // What a member's name still reaches, before a rename. Answers repositories and
      // counts, never a path or a title; gated by the route like `explain`.
      files: ['src/dashboard/configurator/member-usage.ts'],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      // Embedding write path, its DDL, and re-embed. Same sentence as ingest: never
      // reads content on a caller's behalf. `vector-index.ts` reads no content but names
      // the table the rule matches; `reembed.ts` touches embedding columns, never `text`.
      // The read side (semantic queries) is NOT exempt and must use the repository.
      files: ['src/embed/embed.service.ts', 'src/embed/vector-index.ts', 'src/embed/reembed.ts'],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      // Tests assert against materialised rows -- that is the point. isolation.spec.ts
      // must see what a principal cannot, or it could not prove they cannot.
      files: ['test/**/*.ts'],
      rules: { 'no-restricted-syntax': 'off' },
    },
  ],
};

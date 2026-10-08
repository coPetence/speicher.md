/**
 * Write env vars from `src/common/env.ts` to `README.md`.
 *
 *   npm run docs:env
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ENV_TABLE_END, ENV_TABLE_START, renderEnvTable } from '../src/common/env';

const README = resolve(__dirname, '../README.md');

export function withEnvTable(markdown: string): string {
  const start = markdown.indexOf(ENV_TABLE_START);
  const end = markdown.indexOf(ENV_TABLE_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README.md has no ${ENV_TABLE_START} … ${ENV_TABLE_END} block`);
  }
  return (
    markdown.slice(0, start) +
    ENV_TABLE_START +
    '\n\n' +
    renderEnvTable() +
    '\n\n' +
    markdown.slice(end)
  );
}

if (require.main === module) {
  const before = readFileSync(README, 'utf8');
  const after = withEnvTable(before);
  if (after === before) {
    process.stdout.write('README.md is already up to date\n');
  } else {
    writeFileSync(README, after);
    process.stdout.write('README.md deployment table rewritten\n');
  }
}

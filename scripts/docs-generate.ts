/**
 * Rewrite the generated blocks in README.md and documentation/
 *
 *   npm run docs:generate            rewrite every block
 *   npm run docs:generate -- --check exit 1 if any block is out of date
 *
 * What a block can hold is listed in scripts/docs/generators.ts.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { generate } from './docs/generators';
import { regenerate } from './docs/markers';

const ROOT = resolve(__dirname, '..');

/** README.md and every Markdown file under documentation/ */
export function docFiles(): string[] {
  const docs = readdirSync(join(ROOT, 'documentation'), { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.mdx?$/i.test(path))
    .map((path) => join(ROOT, 'documentation', path))
    .sort();
  return [join(ROOT, 'README.md'), ...docs];
}

/** The files whose generated blocks differ from what the generators render now */
export function staleDocs(): { path: string; current: string; fresh: string }[] {
  return docFiles()
    .map((path) => {
      const current = readFileSync(path, 'utf8');
      return { path, current, fresh: regenerate(current, generate, relative(ROOT, path)) };
    })
    .filter(({ current, fresh }) => current !== fresh);
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  const stale = staleDocs();
  for (const { path, fresh } of stale) {
    if (check) process.stdout.write(`out of date: ${relative(ROOT, path)}\n`);
    else {
      writeFileSync(path, fresh);
      process.stdout.write(`rewrote ${relative(ROOT, path)}\n`);
    }
  }
  if (stale.length === 0) process.stdout.write('generated docs are up to date\n');
  else if (check) {
    process.stdout.write('run `npm run docs:generate` to update them\n');
    process.exit(1);
  }
}

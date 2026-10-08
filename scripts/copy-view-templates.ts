/*
 * Copy .eta templates from /src to /dist (tsc does not do that)
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = join(__dirname, '..');
const src = join(root, 'src');
const dist = join(root, 'dist');

const templates = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter((path) => path.endsWith('.eta'))
  .sort();

if (templates.length === 0) {
  process.stderr.write('no templates found under src/\n');
  process.exit(1);
}

for (const path of templates) {
  mkdirSync(dirname(join(dist, path)), { recursive: true });
  copyFileSync(join(src, path), join(dist, path));
}
process.stdout.write(`copied ${templates.length} templates to dist/\n`);

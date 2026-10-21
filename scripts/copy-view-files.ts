/*
 * Copy the files views read at runtime from /src to /dist (tsc does not do that):
 * .eta templates, and the .svg marks under dashboard/ui/marks
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = join(__dirname, '..');
const src = join(root, 'src');
const dist = join(root, 'dist');

const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter((path) => path.endsWith('.eta') || path.endsWith('.svg'))
  .sort();

if (!files.some((path) => path.endsWith('.eta'))) {
  process.stderr.write('no templates found under src/\n');
  process.exit(1);
}

for (const path of files) {
  mkdirSync(dirname(join(dist, path)), { recursive: true });
  copyFileSync(join(src, path), join(dist, path));
}
process.stdout.write(`copied ${files.length} view files to dist/\n`);

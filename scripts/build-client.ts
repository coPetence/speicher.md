/*
 * Build the client islands.
 *
 *   npm run build:client
 *
 * Each island is a new entry point, minified, with its content hash in the
 * filename.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import * as esbuild from 'esbuild';

const root = join(__dirname, '..');
const outdir = join(root, 'dist', 'client');

const ISLANDS = ['tree', 'covers', 'config', 'setup', 'history', 'status', 'repo-status', 'fold'];
const THEME_DIR = join(root, 'src', 'global-ui', 'theme');
const SCHEMES = ['light', 'dark'];
const DARK_QUERY = '@media\\s*\\(\\s*prefers-color-scheme\\s*:\\s*dark\\s*\\)';

const IMPORT = /@import\s+(?:url\()?["']([^"']+)["']\)?[^;]*;/g;

const inlineImports = (path: string): string =>
  readFileSync(path, 'utf8').replace(IMPORT, (_statement, target: string) =>
    inlineImports(join(dirname(path), target)),
  );

const themeSource = (name: string): string => inlineImports(join(THEME_DIR, `${name}.css`));

function templateSheet(name: string): string {
  return name === 'default' ? themeSource(name) : `${themeSource('default')}\n${themeSource(name)}`;
}

function entryFile(key: string, css: string): string {
  const file = join(outdir, `.${key}.entry.css`);
  writeFileSync(file, css);
  return file;
}

export function buildClient(): void {
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });

  const TEMPLATES = readdirSync(THEME_DIR)
    .filter((f) => f.endsWith('.css'))
    .map((f) => f.replace(/\.css$/, ''))
    .sort();

  for (const name of TEMPLATES) {
    if (SCHEMES.some((scheme) => name.startsWith(`${scheme}-`))) {
      throw new Error(
        `a template may not be called "${name}": "light-" and "dark-" name the scheme ` +
          'variants this build generates for every template.',
      );
    }
  }

  const STYLES: [string, string][] = [];
  for (const name of TEMPLATES) {
    const css = templateSheet(name);
    if (!new RegExp(DARK_QUERY).test(css)) {
      throw new Error(
        `template "${name}" defines no dark palette, so its scheme variants would be ` +
          'copies of it. Every template answers both schemes — see theme.spec.ts.',
      );
    }
    STYLES.push([`theme-${name}`, entryFile(`theme-${name}`, css)]);
    for (const scheme of SCHEMES) {
      STYLES.push([
        `theme-${scheme}-${name}`,
        entryFile(
          `theme-${scheme}-${name}`,
          css.replace(
            new RegExp(DARK_QUERY, 'g'),
            scheme === 'dark' ? '@media all' : '@media not all',
          ),
        ),
      ]);
    }
  }

  STYLES.push(['sheet-dashboard', join(root, 'src', 'dashboard', 'ui', 'dashboard.css')]);
  STYLES.push([
    'sheet-setup',
    join(root, 'src', 'dashboard', 'ui', 'views', 'setup', 'setup-claim', 'setup-claim.css'),
  ]);

  esbuild.buildSync({
    entryPoints: ISLANDS.map((name) =>
      join(root, 'src', 'global-ui', 'client-side-islands', `${name}.ts`),
    ),
    outdir,
    bundle: true,
    minify: true,
    sourcemap: true,
    format: 'esm',
    target: ['es2020'],
    legalComments: 'none',
  });

  esbuild.buildSync({
    entryPoints: Object.fromEntries(STYLES.map(([name, file]) => [name, file])),
    outdir,
    bundle: true,
    minify: true,
    loader: { '.css': 'css' },
  });

  const manifest: Record<string, string> = {};
  for (const [name] of STYLES) {
    const source = join(outdir, `${name}.css`);
    const contents = readFileSync(source);
    const hash = createHash('sha256').update(contents).digest('hex').slice(0, 12);
    const hashed = `${name}-${hash}.css`;
    renameSync(source, join(outdir, hashed));
    claim(name, hashed);
    process.stdout.write(
      `  ${name.padEnd(22)} ${String(contents.length).padStart(6)} bytes -> ${hashed}\n`,
    );
  }

  function claim(name: string, hashed: string): void {
    if (manifest[name]) {
      throw new Error(
        `two client artifacts are both called "${name}": ${manifest[name]} and ${hashed}. ` +
          'Stylesheets and islands share one manifest; give one of them another name.',
      );
    }
    manifest[name] = hashed;
  }

  for (const name of ISLANDS) {
    const source = join(outdir, `${name}.js`);
    const contents = readFileSync(source);
    const hash = createHash('sha256').update(contents).digest('hex').slice(0, 12);
    const hashed = `${name}-${hash}.js`;
    renameSync(source, join(outdir, hashed));
    claim(name, hashed);
    process.stdout.write(
      `  ${name.padEnd(22)} ${String(contents.length).padStart(6)} bytes -> ${hashed}\n`,
    );
  }

  writeFileSync(join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  for (const file of readdirSync(outdir)) {
    const orphan =
      (file.endsWith('.js.map') && !ISLANDS.some((name) => file.startsWith(`${name}-`))) ||
      file.endsWith('.css.map') ||
      file.startsWith('.');
    if (orphan) rmSync(join(outdir, file));
  }
}

if (require.main === module) buildClient();

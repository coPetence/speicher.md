import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(__dirname, '../../dist/client');
const MANIFEST_PATH = join(OUT, 'manifest.json');

const MANIFEST: Record<string, string> = existsSync(MANIFEST_PATH)
  ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  : {};

const contentsOf = (key: string): string => readFileSync(join(OUT, MANIFEST[key]), 'utf8');

const readerKeys = (): string[] => [
  ...Object.keys(MANIFEST).filter((key) => key.startsWith('theme-')),
  'tree',
  'covers',
];

describe('the bytes a reader downloads', () => {
  it('was built, or nothing below is an assertion about anything', () => {
    expect(Object.keys(MANIFEST).length).toBeGreaterThan(0);
    expect(readerKeys().length).toBeGreaterThan(1);
    expect(MANIFEST['sheet-dashboard']).toBeDefined();
  });

  it('carries no chart, in the stylesheet or in the script', () => {
    for (const key of readerKeys()) {
      expect(contentsOf(key)).not.toContain('spr-chart');
    }
  });

  it('carries no admin CSS at all', () => {
    for (const key of readerKeys().filter((key) => key.startsWith('theme-'))) {
      expect(contentsOf(key)).not.toContain('.spr-field');
    }
  });

  it('keeps the admin sheet a separate request, never inlined into a template', () => {
    expect(contentsOf('sheet-dashboard')).toContain('spr-chart');
  });

  it('keeps the reader island small enough that a chart library would be obvious', () => {
    expect(readFileSync(join(OUT, MANIFEST['tree'])).length).toBeLessThan(24_000);
    expect(readFileSync(join(OUT, MANIFEST['covers'])).length).toBeLessThan(2_000);
  });
});

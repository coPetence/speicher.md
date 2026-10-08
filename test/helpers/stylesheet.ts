import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const IMPORT = /@import\s+(?:url\()?["']([^"']+)["']\)?[^;]*;/g;

export function readStylesheet(path: string): string {
  return readFileSync(path, 'utf8').replace(IMPORT, (_statement, target: string) =>
    readStylesheet(resolve(dirname(path), target)),
  );
}

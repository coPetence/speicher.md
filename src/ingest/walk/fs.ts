import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import { FindingList } from '../findings';
import { CONFIG_FILENAMES } from '../paths';

export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === '') return true;
  return !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

export async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function realPathOrNull(path: string): Promise<string | null> {
  try {
    return await fs.realpath(path);
  } catch {
    return null;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/** A config file that was read, plus any lower-priority config files beside it that were not */
export interface ConfigFile {
  name: string;
  raw: string;
  ignored: string[];
}

/** Read the first config file that exists in `dir`; null when there is none */
export async function readConfigFile(dir: string): Promise<ConfigFile | null> {
  for (const [index, name] of CONFIG_FILENAMES.entries()) {
    const raw = await readFileOrNull(join(dir, name));
    if (raw === null) continue;
    const ignored: string[] = [];
    for (const other of CONFIG_FILENAMES.slice(index + 1)) {
      if (await fileExists(join(dir, other))) ignored.push(other);
    }
    return { name, raw, ignored };
  }
  return null;
}

/** Warn that config files beside the one in use are ignored */
export function warnIgnoredConfigs(
  findings: FindingList,
  file: ConfigFile,
  repoRelativeDir: string,
): void {
  const source = repoRelativeDir ? `${repoRelativeDir}/${file.name}` : file.name;
  for (const name of file.ignored) {
    findings.warn({
      code: 'duplicate-config',
      source,
      message: `\`${name}\` is ignored because \`${file.name}\` exists in the same directory; keep only one.`,
    });
  }
}

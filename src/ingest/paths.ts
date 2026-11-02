/**
 * Path utilities for the ingestion pipeline
 *
 * Slug generation from file and directory names, with numeric prefix for ordering
 * Relative path resolution with guards against directory traversal
 * MIME type lookup by file extension for asset registration
 * HTML sentinel replaced with the repo's public base URL at render time
 */

import { extname } from 'node:path';

import { slugify, splitNumericPrefix } from '../common/slug';

/**
 * Placeholder in stored HTML replaced with the repo's public base URL at render time
 *
 * Starts with `/` so an unrewritten link fails visibly under the site root
 */
export const REPO_BASE_SENTINEL = '/~repo~';

/** Replaces the sentinel with the repo's public base in stored HTML */
export function withRepoBase(html: string, base: string): string {
  const normalized = base.replace(/\/+$/, '');
  return html.split(REPO_BASE_SENTINEL).join(normalized);
}

/** Slug and numeric order from a markdown content file name */
export function slugForContentFile(fileName: string): { order: number | null; slug: string } {
  const stem = fileName.replace(MARKDOWN_EXTENSION, '');
  const { order, rest } = splitNumericPrefix(stem);
  return { order, slug: slugify(rest) };
}

/** Slug and numeric order from a directory name */
export function slugForDirectory(name: string): { order: number | null; slug: string } {
  const { order, rest } = splitNumericPrefix(name);
  return { order, slug: slugify(rest) };
}

/** Slug from an asset file name, preserving the extension */
export function slugForAssetFile(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  const stem = ext ? fileName.slice(0, -ext.length) : fileName;
  const { rest } = splitNumericPrefix(stem);
  const slug = slugify(rest) || 'asset';
  return `${slug}${ext}`;
}

/** Slug a relative asset path, directory-slugging each part except the final file */
export function slugAssetPath(relativePath: string): string {
  const parts = relativePath.split('/').filter(Boolean);
  return parts
    .map((part, i) =>
      i === parts.length - 1 ? slugForAssetFile(part) : slugForDirectory(part).slug,
    )
    .join('/');
}

/**
 * Resolve a target path relative to a directory
 *
 * Returns null when the target climbs above the root: prevents path traversal
 * A leading slash treats the target as relative to the repo root
 */
export function resolveRelative(fromDir: string, target: string): string | null {
  const base = fromDir.split('/').filter(Boolean);
  const parts = target.split('/');
  const stack = target.startsWith('/') ? [] : [...base];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}

/** Split a URL target into path and fragment/query suffix */
export function splitTarget(target: string): { path: string; suffix: string } {
  // Captures everything before `#` or `?` as the path (Group 1)
  // and everything from the first `#` or `?` as the suffix (Group 2)
  const match = /^([^#?]*)([#?].*)?$/.exec(target);
  return { path: match?.[1] ?? target, suffix: match?.[2] ?? '' };
}

/** Known file extension to MIME type mappings, used when registering assets */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/vnd.microsoft.icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.svg': 'image/svg+xml',
};

/** MIME type for a file path, based on extension; defaults to application/octet-stream */
export function mimeForPath(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Whether the file path has an `.svg` extension */
export function isSvg(path: string): boolean {
  return extname(path).toLowerCase() === '.svg';
}

/** Matches `.md` and `.mdx` files, case-insensitive */
export const MARKDOWN_EXTENSION = /\.mdx?$/i;
/** Matches `.mdx` files only, case-insensitive */
export const MDX_EXTENSION = /\.mdx$/i;

/** Whether the file path is a markdown file (`.md` or `.mdx`) */
export function isMarkdown(path: string): boolean {
  return MARKDOWN_EXTENSION.test(path);
}

/** Configuration file names for the Speicher system, in lookup order */
export const CONFIG_FILENAMES = ['.speicher.yaml', '.speicher.yml'] as const;
/** Default filenames that a directory resolves to when its path is visited */
export const INDEX_FILENAMES = ['index.md', 'index.mdx'];

export function isConfigFilename(name: string): boolean {
  return (CONFIG_FILENAMES as readonly string[]).includes(name);
}

/**
 * isMisnamedConfigFilename checks whether the .speicher.yaml is just mispelled
 */
export function isMisnamedConfigFilename(name: string): boolean {
  if (isConfigFilename(name)) return false;
  return (CONFIG_FILENAMES as readonly string[]).includes(
    `.${name.replace(/^\./, '').toLowerCase()}`,
  );
}

/** Path of a repo file relative to the ingest root; null if outside the ingest root */
export function relativeToIngestRoot(ingestRoot: string, repoRelativePath: string): string | null {
  if (ingestRoot === '') return repoRelativePath;
  if (repoRelativePath === ingestRoot) return '';
  if (!repoRelativePath.startsWith(`${ingestRoot}/`)) return null;
  return repoRelativePath.slice(ingestRoot.length + 1);
}

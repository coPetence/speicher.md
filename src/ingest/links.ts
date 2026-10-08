/**
 * The two link targets that are not a path in this repository.
 *
 * A **wikilink** may name a page rather than a path — `[[Shared env secrets]]` is
 * how most Obsidian vaults link, and the name is resolved against the repo's own
 * basenames. A **cross-repository** target names another repository on this
 * instance: `@kb-dev-tools:dotenvx/index`.
 *
 * Nothing here reads anything. A cross-repo target becomes a URL from instance
 * config alone — which is the whole of why it can be resolved during a render that
 * must stay synchronous, and why the walk still touches no database. The *page* half
 * of such a target is never validated: asking the other repository whether a path
 * exists would answer "does this page exist" to the author of a repository that may
 * not read it, which is rule 1 with a different number on it. A cross-repo link to
 * nothing therefore 404s rather than reporting at ingest, exactly as a link to a page
 * whose audience the reader is outside of already does.
 */
import { extname } from 'node:path';

import { slugify, splitPath } from '../common/slug';
import { isMarkdown, slugForContentFile, slugForDirectory } from './paths';

/** `@[forge/][namespace/]slug:path`, taken apart. */
export interface RepoTarget {
  /** `null` means the primary forge. */
  forgeKey: string | null;
  /** `null` means the forge's default namespace. */
  namespace: string | null;
  slug: string;
  /** Slug path inside that repository. `''` is its landing page. */
  path: string;
}

/**
 * The instance facts a cross-repo URL is built from — and both are in the
 * resolution hash (`computeResolutionHash`'s forge projection carries `primary` and
 * `default_repository_owner`), which is what makes it safe to write the result into stored
 * HTML. Move either and every repo on the instance reingests, recomputing this.
 */
export interface RepoAddressPolicy {
  primaryForgeId: string | null;
  /** URL slug of that forge's default repository owner, or `undefined` if it has none. */
  defaultRepositoryOwnerSlug(forgeKey: string): string | undefined;
}

/**
 * The address is delimited from the path by `:`, and that delimiter is the whole
 * reason the namespace may be left out.
 *
 * A URL is resolved by *probing* — `candidateSplits` tries namespace+slug before
 * default-namespace+slug and takes the first that matches a row — and the probe
 * includes the path segments. That is fine for a request, which either resolves or
 * 404s against an authoritative table. It is not fine here: this answer decides
 * which repository an edge points at, and a repository registered later could
 * change it with nothing re-running. `repos` identity is deliberately absent from
 * the resolution hash, so nothing would reingest and nothing would say so.
 *
 * With the path delimited off, the address is one, two or three segments and the
 * segment count picks the scheme — the same three schemes a URL has, counted
 * instead of guessed.
 */
const ADDRESS_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;

export function parseRepoTarget(target: string): RepoTarget | 'malformed' | null {
  if (!target.startsWith('@')) return null;

  const body = target.slice(1);
  const colon = body.indexOf(':');
  const address = colon === -1 ? body : body.slice(0, colon);
  const rawPath = colon === -1 ? '' : body.slice(colon + 1);

  const parts = address.split('/').filter(Boolean);
  if (parts.length === 0 || parts.length > 3) return 'malformed';
  if (!parts.every((part) => ADDRESS_SEGMENT.test(part))) return 'malformed';

  const segments = splitPath(rawPath);
  if (segments === null) return 'malformed';

  const [first, second, third] = parts;
  const addressed =
    parts.length === 3
      ? { forgeKey: first, namespace: second, slug: third }
      : parts.length === 2
        ? { forgeKey: null, namespace: first, slug: second }
        : { forgeKey: null, namespace: null, slug: first };

  return { ...addressed, path: targetSlugPath(segments) };
}

/**
 * The path half, as the other repository's slug path.
 *
 * Slugified rather than taken verbatim, because the two things an author has to
 * hand are the destination's URL and its file path, and both should land on the
 * same page: a numeric prefix is stripped and a Markdown extension dropped, which
 * is what `slugForContentFile` already does for the file it names. A trailing
 * `index` goes too — `index.md` has no URL of its own, it *is* the folder.
 *
 * It is also what makes this safe to write into stored HTML: every segment that
 * comes back is `[a-z0-9-]`, so nothing an author typed is interpolated into an
 * href. That rule is `navWidthTokens`' and the palette's, arriving here.
 */
function targetSlugPath(segments: string[]): string {
  const slugged = segments.map((segment, i) =>
    i === segments.length - 1 && isMarkdown(segment)
      ? slugForContentFile(segment).slug
      : slugForDirectory(segment).slug,
  );
  const trimmed = slugged.filter(Boolean);
  if (trimmed[trimmed.length - 1] === 'index') trimmed.pop();
  return trimmed.join('/');
}

/**
 * The URL path a cross-repo target becomes, or `null` when this instance cannot
 * say.
 *
 * The namespace is **written out** even where the author left it off, rather than
 * left to the reader's request to default. Both spellings resolve — `candidateSplits`
 * tries namespace+slug first — but an omitted namespace means "whatever the default
 * is *then*", and `default_repository_owner` moving would silently repoint every such link
 * at a different repository. Expanded here, the reingest that key's presence in the
 * resolution hash forces is what keeps the link pointing where it was written.
 *
 * It is dropped again when it *is* the default, so this agrees character for
 * character with `RoutingService.publicBaseFor` and the body link cannot differ
 * from the one the related column draws for the same page.
 */
export function repoTargetUrl(target: RepoTarget, policy: RepoAddressPolicy): string | null {
  const forgeKey = target.forgeKey ?? policy.primaryForgeId;
  if (forgeKey === null) return null;

  const defaultNamespace = policy.defaultRepositoryOwnerSlug(forgeKey);
  const namespace = target.namespace ?? defaultNamespace;
  if (namespace === undefined) return null;

  const segments: string[] = [];
  // A URL carries the forge only for a non-primary one: `candidateSplits` refuses
  // to read the first segment as a forge when it names the primary, so spelling it
  // out would produce a path that resolves to nothing.
  if (forgeKey !== policy.primaryForgeId) segments.push(slugify(forgeKey));
  if (slugify(namespace) !== defaultNamespace) segments.push(slugify(namespace));
  segments.push(slugify(target.slug));

  const base = `/${segments.filter(Boolean).join('/')}`;
  return target.path === '' ? `${base}/` : `${base}/${target.path}`;
}

/**
 * The source paths a target may name, in the order they are tried.
 *
 * The exact path first: an author who wrote the extension means that file. The rest
 * exist because a wikilink is extensionless by convention, and `[[guide]]` means
 * `guide.md` or the folder `guide/`.
 *
 * Deliberately **not** applied to ordinary Markdown links. An extensionless
 * `[setup](/docs/getting-started)` is a *URL*, and resolving it needs decisions
 * about `ingest_root` prefixes and slug paths that this does not make — it stays
 * the `KNOWN GAP` in `fieldkit.spec.ts`.
 */
export function pageCandidates(path: string): string[] {
  if (extname(path) !== '') return [path];
  return [path, `${path}.md`, `${path}.mdx`, `${path}/index.md`, `${path}/index.mdx`];
}

/**
 * The keys a file answers to by name.
 *
 * Obsidian's default link format is the bare note name, resolved vault-wide, so a
 * repository imported from a vault links that way throughout. Both the filename as
 * written and its slug are keys: a vault's `Shared Env Secrets.md` is linked as
 * `[[Shared Env Secrets]]` from inside Obsidian and may be linked as
 * `[[shared-env-secrets]]` by somebody reading the URL.
 */
export function nameKeysFor(sourcePath: string): string[] {
  const name = sourcePath.split('/').pop() ?? sourcePath;
  const stem = isMarkdown(name) ? name.replace(/\.mdx?$/i, '') : name;
  const keys = new Set([stem.toLowerCase(), slugForContentFile(name).slug]);
  keys.delete('');
  return [...keys];
}

/**
 * Name -> the files answering to it, each list in a stable order.
 *
 * Shortest path first, then lexicographic, so an ambiguous name resolves to the
 * same file on every sync of the same commit — the property that makes the whole
 * database derivable from a SHA. Obsidian picks one too; what is added here is
 * saying so.
 */
export function buildNameIndex<T>(files: T[], sourcePathOf: (file: T) => string): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const file of files) {
    for (const key of nameKeysFor(sourcePathOf(file))) {
      const bucket = index.get(key);
      if (bucket) bucket.push(file);
      else index.set(key, [file]);
    }
  }
  for (const bucket of index.values()) {
    bucket.sort((a, b) => {
      const left = sourcePathOf(a);
      const right = sourcePathOf(b);
      const depth = left.split('/').length - right.split('/').length;
      return depth !== 0 ? depth : left.localeCompare(right);
    });
  }
  return index;
}

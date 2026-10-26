---
icon: sliders-horizontal
---

# The `.speicher.yaml` file

Every repository Speicher publishes has a `.speicher.yaml` file at its root. It says who may read the repository, which files to publish, and how the repository is shown. Folders can have their own `.speicher.yaml` to change these settings for everything below them.

This page covers everything except who may read what, which is explained in [Access](02-access.md).

## Where the file goes

- **At the repository root.** This file is required: a repository without one is not published. It stays at the root even when you publish only a subfolder with `ingest_root`.
- **In any folder** that Speicher publishes. Its settings apply to that folder and everything below it.

The file can also be named `.speicher.yml`. If a folder has both, Speicher uses `.speicher.yaml` and reports the other as ignored.

## A complete example

```yaml
version: 1

access:
  groups: [staff]

# Publish only the docs/ folder
ingest_root: docs

# Which Markdown files to publish
sync:
  include: ['**/*.md', '**/*.mdx']
  exclude: ['**/README.md', 'drafts/**']

display:
  title: Engineering Handbook
  cover: cover.png
```

## `version`

Always `version: 1`. It is required in the root file. A folder file can leave it out.

## `ingest_root`

Publishes only one folder of the repository. With `ingest_root: docs`, Speicher reads nothing outside `docs/`, and URLs start below it: `docs/guides/setup.md` is served as `/guides/setup`.

The folder must exist in the repository. Write it without a leading slash.

## Choosing files with `sync`

`sync.include` and `sync.exclude` are lists of glob patterns that choose which Markdown files become pages. A file is published when it matches an `include` pattern and no `exclude` pattern.

Unless you or your administrator change them, these are the patterns:

```yaml
sync:
  include: ['**/*.md', '**/*.mdx']
  exclude: ['**/README.md']
```

- Patterns are matched against the file's path **below `ingest_root`**, also in a folder's `.speicher.yaml`. To exclude `docs/guides/old/` with `ingest_root: docs`, write `guides/old/**`, even in `docs/guides/.speicher.yaml`.
- Patterns are case-sensitive: `**/README.md` does not exclude `readme.md`.
- The patterns only choose Markdown files. Images and other files are published when a page links to them.
- A page with `draft: true` in its frontmatter is never published, whatever the patterns say.

In a folder's `.speicher.yaml`:

- `include` **replaces** the inherited list.
- `exclude` **adds** to the inherited list. A folder cannot remove an exclusion it inherited.

## `display`

### `title`

The name of the repository, when set in the root file, or of the folder, when set in a folder's file. A title is not inherited: subfolders keep their own names.

A folder's name comes from the first of these that exists:

1. the title of the folder's `index.md`
2. `display.title` in the folder's `.speicher.yaml`
3. the folder's name, for example `getting-started` becomes "Getting started"

### `cover`

An image shown on the repository's or folder's card in listings. Without one, Speicher draws a pattern instead.

- The path is relative to the `.speicher.yaml` it is written in, and must point to a file inside the repository. It may be outside `ingest_root`.
- SVG images are not allowed.
- Subfolders inherit the cover. The path keeps pointing to the same file, wherever the subfolder is.
- `cover: null` removes an inherited cover from a folder and the folders below it.

## `retrieval.indexable`

Set `indexable: false` to keep pages out of places that index them automatically:

- AI assistants connected through the MCP server don't find them when they search.
- They are left out of the sitemap.
- Public pages tell search engines not to index them.

The pages can still be read as usual, and they still appear in Speicher's own search.

`indexable` can only be turned off. Once a folder sets it to `false`, a subfolder cannot set it back to `true`. A single page can also turn it off with `indexable: false` in its frontmatter.

```yaml
# drafts/.speicher.yaml
retrieval:
  indexable: false
```

## How folders inherit settings

A folder's `.speicher.yaml` only needs the keys it changes. Everything else is inherited from the folder above.

| Key                                     | In a folder's `.speicher.yaml`                           |
| --------------------------------------- | -------------------------------------------------------- |
| `access`                                | Can only narrow access. See [Access](02-access.md).      |
| `sync.include`                          | Replaces the inherited list.                             |
| `sync.exclude`                          | Adds to the inherited list.                              |
| `display.title`                         | Names this folder only. Not inherited.                   |
| `display.cover`                         | Replaces the inherited cover. `null` removes it.         |
| `retrieval.indexable`                   | Can turn indexing off, not back on.                      |
| `version`, `ingest_root`, `maintainers` | Root only. `ingest_root` and `maintainers` are rejected. |

## When a file has a problem

Speicher checks every `.speicher.yaml` when it syncs a commit. **Sync status** in the dashboard lists each problem with its file and line.

- **An unknown key** is reported as a warning and ignored.
- **An invalid root file** stops the whole commit. Readers keep seeing the pages from the last successful sync.
- **An invalid folder file**, for example one that sets `ingest_root`, stops that folder and everything below it. The rest of the repository is updated, and readers keep seeing the old version of that folder.
- **A wrong cover**, such as a missing image or an SVG, is reported as an error, but the pages are still published.

## Defaults for every repository

Administrators can change the starting values for all repositories in the instance configuration, under **Configuration → Repository defaults** or the `defaults` key. A repository's root `.speicher.yaml` then changes them the same way a folder does.

For example, to publish MDX files in every repository:

```yaml
# speicher.instance.yaml
defaults:
  sync:
    include: ['**/*.md', '**/*.mdx']
    exclude: ['**/README.md']
```

A default `display.cover` is a path relative to each repository's root, so every repository needs that file.

<!-- generated: schema instance#/properties/defaults -->
<!-- prettier-ignore-start -->
| Key | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `defaults` | object |  |  | Starting values for every repository. A repository's root `.speicher.yaml` changes them the same way a folder's file does. |
| `defaults.sync` | object |  |  |  |
| `defaults.sync.include` | list of string |  |  | Glob patterns of Markdown files to publish in every repository. Defaults to `**/*.md`. |
| `defaults.sync.exclude` | list of string |  |  | Glob patterns of Markdown files never to publish in any repository. Defaults to `**/README.md`. |
| `defaults.retrieval` | object |  |  |  |
| `defaults.retrieval.indexable` | boolean |  |  | Set to `false` to keep every repository's pages out of AI assistant search, the sitemap and search engines, unless a repository's pages are already excluded. Repositories cannot turn it back on. |
| `defaults.display` | object |  |  |  |
| `defaults.display.cover` | string or null |  |  | A default cover image, as a path relative to each repository's root. Every repository needs that file. |
<!-- prettier-ignore-end -->
<!-- /generated -->

## All settings

Every key of `.speicher.yaml` is listed under [Repository configuration](../06-reference/04-repository-configuration.md).

<!-- generated: schema speicher#/properties/sync -->
<!-- prettier-ignore-start -->
| Key | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `sync` | object |  |  | Which Markdown files to publish. |
| `sync.include` | list of string |  |  | Glob patterns of Markdown files to publish, matched against the path below `ingest_root`. Defaults to `**/*.md` and `**/*.mdx`. In a folder, it replaces the inherited list. |
| `sync.exclude` | list of string |  |  | Glob patterns of Markdown files not to publish, matched against the path below `ingest_root`. Defaults to `**/README.md`. In a folder, it adds to the inherited list. Exclude wins over include. |
<!-- prettier-ignore-end -->
<!-- /generated -->

<!-- generated: schema speicher#/properties/display -->
<!-- prettier-ignore-start -->
| Key | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `display` | object |  |  | How this repository or folder is shown. |
| `display.title` | string |  |  | The name of the repository (in the root file) or of this folder. Not inherited by subfolders. A folder's `index.md` title takes precedence. |
| `display.cover` | string or null |  |  | An image shown on this repository's or folder's card, as a path relative to this file. It must be inside the repository and must not be an SVG. Subfolders inherit it; `null` removes an inherited cover. |
<!-- prettier-ignore-end -->
<!-- /generated -->

<!-- generated: schema speicher#/properties/retrieval -->
<!-- prettier-ignore-start -->
| Key | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `retrieval` | object |  |  | Whether pages are indexed automatically. |
| `retrieval.indexable` | boolean |  |  | Set to `false` to leave these pages out of AI assistant search, the sitemap and search engines. Pages can still be read and found in Speicher's own search. Once turned off, a subfolder cannot turn it back on. |
<!-- prettier-ignore-end -->
<!-- /generated -->

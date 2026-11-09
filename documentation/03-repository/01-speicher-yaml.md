---
icon: sliders-horizontal
---

# The `.speicher.yaml` file

Every repository speicher.md should sync needs a `.speicher.yaml` file at its root. It is used to define who can access a repository, which files to publish, and how the repository is shown. Folders can have their own `.speicher.yaml` to change these settings for everything below them.

## Where to put the file

- **Repository root (required):** a repository without is not synced. Also put it at the root even when you publish only a subfolder.
- **Any folder** that speicher.md publishes. Its settings apply to that folder and everything below it.

## Example

```yaml
version: 1

access:
  groups: [staff]

# Syncs only the docs/ folder
# Everything outside is ignored
ingest_root: docs

# Which Markdown files to publish
sync:
  include: ['**/*.md', '**/*.mdx']
  exclude: ['**/README.md', 'drafts/**']

display:
  title: Engineering Handbook
  cover: cover.png
```

## `ingest_root`

Syncd only one folder of the repository. With `ingest_root: <folder>`, speicher.md reads nothing outside `<folder>/`, and URLs start below it: `docs/guides/setup.md` is served as `/guides/setup`.

The folder must exist in the repository. Write it without a leading slash.

## Choosing files with `sync`

`sync.include` and `sync.exclude` are lists of glob patterns that choose which Markdown files become pages. A page is published when it matches an `include` pattern and no `exclude` pattern.

```yaml
sync:
  include: ['**/*.md', '**/*.mdx']
  exclude: ['**/README.md']
```

Images and other files do not need to be listed. A file is published when a page links to it, unless it matches an `exclude` pattern. A link to a file that is not in the repository, or that is excluded, is reported as a broken link.

:::tip
A page with `draft: true` in its frontmatter is never published.
:::

In a nested folder's `.speicher.yaml`:

- `include` **replaces** the inherited list.
- `exclude` **adds** to the inherited list. (A folder cannot remove an exclusion it inherited)

## `display`

### `title`

The name of the repository, when set in the root file, or of the folder, when set in a folder's file. A title is not inherited: subfolders keep their own names.

A folder's name comes from the first of these that exists:

1. the title of the folder's `index.md`
2. `display.title` in the folder's `.speicher.yaml`
3. the folder's name, for example `getting-started` becomes "Getting started"

### `cover`

An image shown on the repository's or folder's card in listings. Without one, speicher.md draws a pattern instead.

- The path is relative to the `.speicher.yaml` it is written in, and must point to a file inside the repository. It may be outside `ingest_root`.
- SVG images are not allowed.
- Subfolders inherit the cover. The path keeps pointing to the same file, wherever the subfolder is.
- `cover: null` removes an inherited cover from a folder and the folders below it.

## `retrieval.indexable`

Set `indexable: false` to keep pages out of places that index them automatically:

- AI assistants connected through the MCP server don't find them when they search.
- They are left out of the sitemap.
- Public pages tell search engines not to index them.

The pages can still be read as usual, and they still appear in speicher.md's own search.

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

speicher.md checks every `.speicher.yaml` when it syncs a commit. **Sync status** in the dashboard lists each problem with its file and line.

- **An unknown key** is reported as a warning and ignored.
- **An invalid root file** stops the whole commit. Readers keep seeing the pages from the last successful sync.
- **An invalid folder file**, for example one that sets `ingest_root`, stops that folder and everything below it. The rest of the repository is updated, and readers keep seeing the old version of that folder.
- **A wrong cover**, such as a missing image or an SVG, is reported as an error, but the pages are still published.

## Defaults for every repository

Administrators can change the starting values for all repositories in the instance configuration, under **Configuration → Repository defaults** or the `defaults` key. A repository's root `.speicher.yaml` then changes them the same way a folder does.

For example, to publish only `.md` files and no MDX in every repository:

```yaml
# speicher.instance.yaml
defaults:
  sync:
    include: ['**/*.md']
    exclude: ['**/README.md']
```

A default `display.cover` is a path relative to each repository's root, so every repository needs that file.

<!-- generated: schema instance#/properties/defaults -->
<!-- prettier-ignore-start -->
| Key | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `defaults` | object |  |  | Starting values for every repository. A repository's root `.speicher.yaml` changes them the same way a folder's file does. |
| `defaults.sync` | object |  |  |  |
| `defaults.sync.include` | list of string |  |  | The include list determines which Markdown files become pages in every git repository. Images and other files are downloaded when a page links to them, so they do not need to be listed. It defaults to `.md` and `.mdx` files. A repository that sets its own `sync.include` replaces this list. |
| `defaults.sync.exclude` | list of string |  |  | The exclude list determines which files will not be downloaded from any git repository, even when the include list selects them or a page links to them. It defaults to `**/README.md`. A repository that sets its own `sync.exclude` adds to this list. |
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
| `sync.include` | list of string |  |  | The include list determines which Markdown files become pages. Images and other files are downloaded when a page links to them, so they do not need to be listed. It defaults to `.md` and `.mdx` files. Patterns start at `ingest_root`: with `ingest_root: docs`, the pattern `guides/*.md` selects `docs/guides/*.md`. In a folder, it replaces the inherited list. |
| `sync.exclude` | list of string |  |  | The exclude list determines which files will not be downloaded, even when the include list selects them or a page links to them. It defaults to `**/README.md`. Patterns start at `ingest_root`, as in the include list. In a folder, it adds to the inherited list. |
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
| `retrieval.indexable` | boolean |  |  | Set to `false` to leave these pages out of AI assistant search, the sitemap and search engines. Pages can still be read and found in speicher.md's own search. Once turned off, a subfolder cannot turn it back on. |
<!-- prettier-ignore-end -->
<!-- /generated -->

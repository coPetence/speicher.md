---
icon: file-cog
---

# Repository configuration

Every key of `.speicher.yaml`, the configuration a repository carries at its root and in any folder.

<!-- generated: schema speicher -->
<!-- prettier-ignore-start -->
## version

**Type:** `1`

The format version of this file. Always `1`. Required in the root `.speicher.yaml`; a folder's file can leave it out.

## ingest_root

**Type:** string · **Default:** ``

Root only. Publishes only this folder of the repository, for example `docs`. Nothing outside it is read, and URLs start below it. Write it without a leading slash.

## access

**Type:** list of string or object

Who may read the pages at this level. Required in the root `.speicher.yaml`. In a folder, it can only narrow what the folder inherits: a reader must be allowed at every level from the root down.

### `access.groups`

**Type:** list of string

Group names whose members may read. Each name must be a group configured on the instance, or `public` if the instance lists this repository under `public.repos`.

### `access.users`

**Type:** list of object

Individual people who may read, each with an expiry date.

### `access.users[]`

**Type:** object

One person, named by `email` or by `subject` with a `note`. Set exactly one of: `subject` + `note`, `email`.

### `access.users[].provider`

**Type:** string

Short id of the identity provider the person signs in with. Can be left out when the instance has one provider or sets `auth.default_provider`.

### `access.users[].subject`

**Type:** string

The person's permanent id at the identity provider, the value of its subject claim. It never changes and is never reused. For a magic-link provider, it is the email address. Needs a `note`.

### `access.users[].email`

**Type:** string (email)

The person's email address, matched against the address the identity provider reports at sign-in. If the provider has a directory, it is resolved to the person's subject id during each sync.

### `access.users[].note`

**Type:** string

Who this grant is for, such as a name and role. Required with `subject`. Up to 200 characters.

### `access.users[].until`

**Type:** string (date) · **Required**

Date the grant ends, as `YYYY-MM-DD`. It is valid until the end of that day (UTC). The repository then syncs again and the grant is dropped.

## maintainers

**Type:** object

Root only. People who can see this repository's sync status and the problems of its last sync. Maintainers get no read access from this; to read the pages, they also need `access`.

### `maintainers.groups`

**Type:** list of string

Group names whose members maintain this repository. Cannot be `public`.

### `maintainers.users`

**Type:** list of object

Individual maintainers, each with an expiry date.

### `maintainers.users[]`

**Type:** object

One person, named by `email` or by `subject` with a `note`. Set exactly one of: `subject` + `note`, `email`.

### `maintainers.users[].provider`

**Type:** string

Short id of the identity provider the person signs in with. Can be left out when the instance has one provider or sets `auth.default_provider`.

### `maintainers.users[].subject`

**Type:** string

The person's permanent id at the identity provider, the value of its subject claim. It never changes and is never reused. For a magic-link provider, it is the email address. Needs a `note`.

### `maintainers.users[].email`

**Type:** string (email)

The person's email address, matched against the address the identity provider reports at sign-in. If the provider has a directory, it is resolved to the person's subject id during each sync.

### `maintainers.users[].note`

**Type:** string

Who this grant is for, such as a name and role. Required with `subject`. Up to 200 characters.

### `maintainers.users[].until`

**Type:** string (date) · **Required**

Date the grant ends, as `YYYY-MM-DD`. It is valid until the end of that day (UTC). The repository then syncs again and the grant is dropped.

## display

**Type:** object

How this repository or folder is shown.

### `display.title`

**Type:** string

The name of the repository (in the root file) or of this folder. Not inherited by subfolders. A folder's `index.md` title takes precedence.

### `display.cover`

**Type:** string or null

An image shown on this repository's or folder's card, as a path relative to this file. It must be inside the repository and must not be an SVG. Subfolders inherit it; `null` removes an inherited cover.

## retrieval

**Type:** object

Whether pages are indexed automatically.

### `retrieval.indexable`

**Type:** boolean

Set to `false` to leave these pages out of AI assistant search, the sitemap and search engines. Pages can still be read and found in Speicher's own search. Once turned off, a subfolder cannot turn it back on.

## sync

**Type:** object

Which Markdown files to publish.

### `sync.include`

**Type:** list of string

The include list determines which files will be downloaded from the git repository. Markdown files will be displayed as pages in the reader, while other files such as images can be linked from pages. It defaults to `.md`, `.mdx`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif` and `.svg` files. Patterns start at `ingest_root`: with `ingest_root: docs`, the pattern `guides/*.md` selects `docs/guides/*.md`. In a folder, it replaces the inherited list.

### `sync.exclude`

**Type:** list of string

The exclude list determines which files will not be downloaded, even when the include list selects them. It defaults to `**/README.md`. Patterns start at `ingest_root`, as in the include list. In a folder, it adds to the inherited list.
<!-- prettier-ignore-end -->
<!-- /generated -->

---
icon: file-code
---

# Frontmatter

Every key a page can set in its frontmatter.

<!-- generated: schema frontmatter -->
<!-- prettier-ignore-start -->
## title

**Type:** string

The page title. Defaults to the page's first `# Heading`, then to the file name.

## description

**Type:** string

A short summary of the page, used in search results and as its meta description.

## icon

**Type:** string

Name of a Lucide icon (https://lucide.dev/icons), such as `book-open`, shown next to the page in the navigation and folder listings. An unknown name is ignored with a warning. Example: `book-open`, `shield-check`, `circle-alert`.

## redirect_from

**Type:** list of string

Old addresses that redirect to this page, as full paths including the repository, such as `/handbook/old-page`. An address of an existing page or of another repository is ignored with a warning.

## draft

**Type:** boolean · **Default:** `false`

`true` leaves the file out of the site completely.

## indexable

**Type:** boolean

`false` keeps the page out of AI retrieval. It cannot turn retrieval back on where a `.speicher.yaml` turned it off.

## tags

**Type:** list of string

Topics that relate this page to others with the same tag. Matching ignores upper and lower case. Tags never affect who can read the page.

## sidebar_position

**Type:** number

Docusaurus's ordering key. Used only in folders where no file has a number prefix.

## sidebar

**Type:** object

Starlight's sidebar block. Only `order` is read; the rest is ignored.

### `sidebar.order`

**Type:** number

Starlight's ordering key, used like `sidebar_position`.
<!-- prettier-ignore-end -->
<!-- /generated -->

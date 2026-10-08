---
description: What this handbook covers and who it is for.
icon: sparkles
---

# Introduction

Numeric prefixes give ordering with no config key. This file is `01-introduction.md`
and serves `/introduction`, so renumbering reorders without changing the URL.

## Emphasis and inline marks

Ordinary **bold**, *italic*, ***both***, ~~struck through~~, `inline code`, and a
<kbd>Ctrl</kbd>+<kbd>C</kbd> keystroke. German text with umlauts near a search term:
Betriebsvereinbarung, Prüfung, Größe, Straße.

## Lists

- A bullet
- Another bullet
  - Nested one level
  - And a sibling
    - Two levels deep
- Back to the top level

1. First
2. Second
   1. Second, sub-one
   2. Second, sub-two
3. Third

Definition-style content, as a description list:

<dl>
  <dt>ingest_root</dt>
  <dd>Bounds everything the sync job reads.</dd>
  <dt>effective_principals</dt>
  <dd>The resolved read set, materialised on every row.</dd>
</dl>

## A table

| Strategy    | Fields                | Behaviour                                       |
| ----------- | --------------------- | ----------------------------------------------- |
| `override`  | `display.cover`       | Nearest ancestor wins                           |
| `append`    | `sync.exclude`        | Accumulates — add exclusions, never remove      |
| `replace`   | `sync.include`        | Child replaces wholesale                        |
| `intersect` | `access`              | Each level intersects with its parent           |
| `and`       | `retrieval.indexable` | `true → false` allowed; `false → true` ignored  |

With alignment, which exercises a different set of attributes:

| Left | Centre | Right |
| :--- | :----: | ----: |
| a    |   b    |     1 |
| cc   |   dd   |    22 |

## Code

A fenced block with a language, which becomes `class="language-yaml"`:

```yaml
access:
  groups: [commercial]
retrieval:
  indexable: false
```

An unfenced, indented block:

    SELECT slug_path FROM documents
     WHERE effective_principals && $1;

A fenced block that *contains* link syntax, which the Markdown rewriter must leave
alone because it is a sample rather than a link:

```md
See [the setup page](02-setup.md) for details.
```

## Quotes

> Restrictions accumulate in every direction. That single property is what makes
> delegating config to repos safe.
>
> > A nested quote, to check the renderer keeps the structure.

## An image

The repo cover, referenced from a page — an asset outside `ingest_root`, pulled in
because it is referenced even though `sync.include` matches only Markdown:

![The handbook cover](../cover.jpg)

## Links

An [internal link to setup](02-setup.md), a
[link with a fragment](02-setup.md#setup), an
[external link](https://example.test/somewhere), an
[anchor on this page](#code), and a [mailto](mailto:docs@example.test).

<details>
  <summary>A collapsed section</summary>

  Content inside a `details` block, which is on the sanitiser's allowlist because it
  carries no script and no styling.

</details>

## Rules

Three ways of writing one, all of which collapse to `<hr>`:

---

***

___

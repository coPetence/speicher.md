---
icon: book-open
---

# Reading experience

When speicher.md syncs a repository, it records which pages link to which. This link graph powers several features that help readers find their way: related pages beside an article, previews on links, tags, and better search ranking.

You find these settings in the dashboard under **Configuration → Reading experience**. All of them are on by default. Changes apply right away, without a new sync, because speicher.md always records the links.

:::note
None of these features reveal anything a reader cannot already see. A reader only ever sees links, previews and tags of pages they are allowed to read, and never how many entries were left out.
:::

## Link graph

**Link graph** (`graph.enabled`) turns all of the features below on or off at once. When it is off, the individual settings have no effect.

## Related column

**Related column** (`graph.related`) shows a column beside each article with two lists:

- the pages this article links to
- the pages that link to this article

**Related entries shown** (`graph.related_limit`) limits each list, to 8 entries by default and at most 50.

## Hover previews

**Hover previews** (`graph.previews`) shows the title and description of the target page when a reader hovers over a link to another page. The preview is part of the page itself, so it appears instantly and works without JavaScript.

A link to a page the reader cannot open has no preview.

## Tags

**Tags** (`graph.terms`) shows the `tags` from a page's frontmatter as chips on the page. Each chip leads to a list of all pages with that tag that the reader can open.

```yaml
---
title: Deploying to production
tags: [deployment, operations]
---
```

Tags only group pages. They never change who can read a page.

## Link-weighted search

**Link-weighted search** (`graph.search_boost`) ranks a search result higher when other results of the same search link to it. Pages that are central to a topic come first. It only changes the order of results, never which results appear.

## Configuration file

```yaml
graph:
  enabled: true
  related: true
  related_limit: 5
  previews: true
  terms: false
  search_boost: true
```

## Settings

<!-- generated: schema instance#/properties/graph -->
<!-- prettier-ignore-start -->
| Key | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `graph` | object |  |  | Features built from the links between pages: the related column, hover previews, tags and link-weighted search. speicher.md records links on every sync, so changes apply right away. A reader only sees links between pages they can read. |
| `graph.enabled` | boolean | `true` |  | Turns all link graph features on or off. When off, the settings below have no effect. |
| `graph.related` | boolean | `true` |  | Shows a column beside each article with the pages it links to and the pages that link to it. |
| `graph.previews` | boolean | `true` |  | Shows the title and description of the target page when a reader hovers over a link to another page. Links to pages the reader cannot open get no preview. |
| `graph.terms` | boolean | `true` |  | Shows a page's frontmatter `tags` as chips, each leading to a list of the pages with that tag that the reader can open. |
| `graph.search_boost` | boolean | `true` |  | Ranks a search result higher when other results of the same search link to it. It changes only the order of results. |
| `graph.related_limit` | integer | `8` |  | The most entries shown in each list of the related column. Between 1 and 50. |
<!-- prettier-ignore-end -->
<!-- /generated -->

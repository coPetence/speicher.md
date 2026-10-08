/**
 * Template previews in the admin config UI
 *
 * A fixed demo page so templates are judged on appearance, not content
 * The markdown exercises headings, code blocks, callouts, tables, lists, and links
 * The nav includes folders and pages with icons to show the sidebar in the preview
 * A preview is a full page: nav tree, chrome, article in selected template's stylesheet
 */

import type { Request } from 'express';

import type { ChildRow } from '../../authz/content/types';
import { headingSlug, renderMarkdown } from '../../ingest/markdown';
import { stylesheetUrl, templateNames } from '../../content-reader/assets.controller';
import { ChromeConfig, pageChrome } from '../../content-reader/chrome';
import { renderIconRef, renderSprite } from '../../content-reader/icons';
import { buildNavTree } from '../../content-reader/nav';
import { renderPage } from '../../global-ui/global-views/page-layout/page-layout';
import { renderPageBody } from '../../content-reader/views/content-page/content-page';

/**
 * The demo body, which opens at its *second* level.
 *
 * A reader's page draws its `<h1>` from `documents.title` and ingest takes the
 * body's own opening heading out, so a demo carrying one would show the card a
 * shape no real page has — and a template is picked by looking at this (rule 37).
 * The title travels beside it, the way a row's does.
 */
const DEMO_TITLE = 'Working with repositories';

const DEMO_MARKDOWN = `
A page is a Markdown file in a git repository. This one is not: it is a fixed
example, rendered here so a template can be judged on a page rather than on its
name.

## Adding a repository

Register the remote and the reader picks it up on the next
[reconcile](#), which is polling with the interval the repository chose.

\`\`\`yaml
repos:
  - id: handbook
    remote: ssh://git@example.com/ops/handbook.git
    branch: main
\`\`\`

> [!NOTE]
> Access is resolved when a page is ingested, never when it is read. Narrowing a
> folder therefore takes effect on the next sync.

## What a page may set

| Key | Meaning | Default |
| --- | --- | --- |
| \`title\` | The heading and the name in the tree | First \`#\` |
| \`icon\` | A Lucide name, shown beside the title | none |
| \`indexable\` | Whether search and MCP may return it | \`true\` |

Anything else in the frontmatter is left alone:

- Unknown keys are reported, not rejected — see [the sync report](#).
- An \`access\` key is a rejection: [frontmatter never affects access](#).
`;

const DEMO_NAV: ChildRow[] = [
  row('folder', 'guides', 'Guides', 'book-open'),
  row('page', 'guides/repositories', 'Working with repositories', 'git-branch'),
  row('page', 'guides/access', 'Access and groups', 'lock'),
  row('folder', 'reference', 'Reference', 'library'),
  row('page', 'reference/frontmatter', 'Frontmatter', 'file-text'),
  row('page', 'reference/config', 'Instance config', 'settings'),
  row('page', 'changelog', 'Changelog', 'history'),
];

function row(kind: 'page' | 'folder', slug: string, title: string, icon: string): ChildRow {
  return {
    kind,
    slug_path: slug,
    title,
    description: null,
    icon,
    sort_order: null,
    sort_key: slug,
  };
}

const CURRENT = 'guides/repositories';

const NOWHERE = '#'; // All links in the preview go to the page itself

let demoArticle: string | null = null;

function article(): string {
  if (demoArticle !== null) return demoArticle;
  const rendered = renderMarkdown(DEMO_MARKDOWN, { resolveLink: () => NOWHERE });
  demoArticle = renderPageBody({
    html: rendered.html,
    title: DEMO_TITLE,
    headingId: headingSlug(DEMO_TITLE),
    // The mark the nav draws the same page with, two inches to the left.
    icon: renderIconRef('git-branch'),
    crumbs: [
      { href: NOWHERE, title: 'Handbook' },
      { href: NOWHERE, title: 'Guides' },
    ],
    cover: null,
    children: [],
    aside: null,
    repoTitle: 'example/handbook',
    sourcePath: 'guides/repositories.md',
    sha: 'a1b2c3d4',
  });
  return demoArticle;
}

export function isPreviewableTemplate(name: string): boolean {
  return templateNames().includes(name);
}

export function renderTemplatePreview(
  req: Request,
  config: ChromeConfig,
  template: string,
  nonce: string,
): string {
  const tree = buildNavTree(DEMO_NAV, NOWHERE, CURRENT);
  const chrome = pageChrome(req, config);
  return renderPage(article(), {
    title: 'Template preview',
    nonce,
    nav: tree.html,
    sprite: renderSprite(tree.icons),
    article: true, // The demo is a reader page, so it is laid out as one
    docked: true,
    ...chrome,

    stylesheet: stylesheetUrl(template, chrome.scheme ?? null), // The template being previewed

    island: null, // Preview has no interactive component

    themeTokens: config.themeOverridesFor(chrome.scheme ?? null),

    attribution: false, // Preview is not a real read page
  });
}

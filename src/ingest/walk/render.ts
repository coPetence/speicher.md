/**
 * Converts scanned files into ingested documents, edges and terms
 *
 * Each file is rendered through markdown with link resolution
 * Renders all pages and then registers the referenced assets
 * Assets in rendered HTML are registered and given slug paths
 * Cross-repository links resolve against RepoLookup when present
 */
import { createHash } from 'node:crypto';

import { RepoRef } from '../../config/config.service';
import { iconExists, suggestIcon } from '../../content-reader/icons';
import { FindingList } from '../findings';
import { IngestedDocument, IngestedEdge, IngestedTerm } from '../ingested';
import { RepoAddressPolicy, buildNameIndex } from '../links';
import { RenderResult, renderMarkdown, rewriteMarkdownLinks, stripLeadingH1 } from '../markdown';
import { MDX_EXTENSION } from '../paths';
import { AssetRegistry, collectPendingAssets, replacePendingAsset } from './assets';
import { reportLinkFindings } from './link-findings';
import {
  PageLinks,
  addressPolicy,
  buildEdges,
  emptyPageLinks,
  pageTitle,
  resolvePageLink,
} from './link-resolution';
import { ScanState, ScannedFile } from './state';
import { RepoLookup, WalkOptions } from './walk';

interface RenderedContent {
  documents: IngestedDocument[];
  edges: IngestedEdge[];
  terms: IngestedTerm[];
}

export interface RenderContext {
  scan: ScanState; // Scan state with findings and root config
  assets: AssetRegistry; // Registry for asset files

  covers: Map<string, string | null>; // Cover image per directory slugPath
  bySourcePath: Map<string, ScannedFile>; // Files indexed by sourcePath for link resolution

  byName: Map<string, ScannedFile[]>; // Files indexed by filename stem for wikilinks

  policy: RepoAddressPolicy; // Cross-repo URL formatting for this instance

  repoIds: Map<string, { repoId: string; slugPath: string } | null>; // Cross-repo cache
  repos?: RepoLookup; // Resolver for cross-repo targets

  ownRepo: RepoRef; // The repository being rendered

  unlinkedDomains: ReadonlySet<string>;
}

export async function renderPages(
  scan: ScanState,
  assets: AssetRegistry,
  covers: Map<string, string | null>,
  options: WalkOptions,
): Promise<RenderedContent> {
  const bySourcePath = new Map<string, ScannedFile>();
  for (const file of scan.files) bySourcePath.set(file.sourcePath, file);

  const ctx: RenderContext = {
    scan,
    assets,
    covers,
    bySourcePath,
    byName: buildNameIndex(scan.files, (file) => file.sourcePath),
    policy: addressPolicy(options.config),
    repoIds: new Map(),
    repos: options.repos,
    ownRepo: options.repo,
    unlinkedDomains: options.config.autolinkExcludedDomains,
  };
  const drafts = scan.files.map((file) => draftPage(ctx, file));
  await assets.fetchLinked(drafts.flatMap((draft) => draft.pendingAssets));

  const content: RenderedContent = { documents: [], edges: [], terms: [] };
  for (const draft of drafts) {
    const page = await renderPage(ctx, draft);
    content.documents.push(page.document);
    content.edges.push(...page.edges);
    content.terms.push(...page.terms);
  }
  return content;
}

/** Rendered page (assets not registered yet) */
interface PageDraft {
  file: ScannedFile;
  dir: string;
  links: PageLinks;
  rendered: RenderResult;
  pendingAssets: string[];
}

/** Render a scanned file's markdown, leaving its assets as pending placeholders */
function draftPage(ctx: RenderContext, file: ScannedFile): PageDraft {
  const dir = file.sourcePath.split('/').slice(0, -1).join('/');
  const links = emptyPageLinks();
  const rendered = renderMarkdown(file.body, {
    resolveLink: (target, kind) => resolvePageLink(ctx, file, dir, links, target, kind),
    mdx: MDX_EXTENSION.test(file.sourcePath),
    unlinkedDomains: ctx.unlinkedDomains,
  });
  return { file, dir, links, rendered, pendingAssets: collectPendingAssets(rendered.html) };
}

/** Register assets from the drafts and then create the documents */
async function renderPage(
  ctx: RenderContext,
  { file, dir, links, rendered, pendingAssets }: PageDraft,
): Promise<{ document: IngestedDocument; edges: IngestedEdge[]; terms: IngestedTerm[] }> {
  const findings = ctx.scan.root.findings;

  let html = rendered.html;
  for (const repoRelative of pendingAssets) {
    const slugPath = await ctx.assets.register(repoRelative, file.sourcePath);
    html = replacePendingAsset(html, repoRelative, slugPath);
    if (slugPath === null) links.broken.push(repoRelative);
  }

  // Remove leading H1, its text is already used as the page title
  html = stripLeadingH1(html);

  reportLinkFindings(findings, file, links, rendered);
  reportMdxFindings(findings, file, rendered);

  const title = pageTitle(file);

  const coverPath = ctx.covers.get(file.isIndex ? file.slugPath : file.parentPath) ?? null;
  const icon = resolveIcon(file, findings);
  const discarded = emptyPageLinks();
  const markdown = rewriteMarkdownLinks(file.body, (target, kind) =>
    resolvePageLink(ctx, file, dir, discarded, target, kind),
  );

  const document: IngestedDocument = {
    sourcePath: file.sourcePath,
    slugPath: file.slugPath,
    parentPath: file.parentPath,
    title,
    description: file.frontmatter.description ?? null,
    html,
    markdown,
    plain: rendered.plain,
    isIndex: file.isIndex,

    indexable: file.resolved.indexable && file.frontmatter.indexable !== false,
    principals: file.resolved.principals,
    configSource: {
      chain: file.resolved.chain,
      dropped_grants: file.resolved.droppedGrants,
    },
    contentHash: createHash('sha256').update(file.raw).digest('hex'),
    sortOrder: file.sortOrder,
    sortKey: title.toLowerCase(),
    coverPath,
    icon,
    redirectFrom: file.frontmatter.redirect_from ?? [],
  };

  return { document, edges: await buildEdges(ctx, file, links), terms: termsOf(file) };
}

/** Report unknown MDX components and JS expressions as findings */
function reportMdxFindings(findings: FindingList, file: ScannedFile, rendered: RenderResult): void {
  for (const name of rendered.mdxComponents) {
    findings.warn({
      code: 'mdx-component',
      source: file.sourcePath,
      message:
        `<${name}> is not a component this site can draw. Its tags are left out and ` +
        'anything written between them is shown as ordinary content.',
    });
  }
  for (const expression of new Set(rendered.mdxExpressions)) {
    findings.warn({
      code: 'mdx-expression',
      source: file.sourcePath,
      message:
        `"${expression}" is a JavaScript expression, which cannot run here, so it is ` +
        'left out of the page. Write what it produces as Markdown instead.',
    });
  }
}

/** Validate icon from frontmatter against the installed Lucide set */
function resolveIcon(file: ScannedFile, findings: FindingList): string | null {
  if (!file.frontmatter.icon) return null;
  const candidate = file.frontmatter.icon.toLowerCase();
  if (iconExists(candidate)) return candidate;
  findings.warn({
    code: 'unknown-icon',
    source: file.sourcePath,
    line: 1,
    message: `"${file.frontmatter.icon}" is not a valide Lucide icon name. See all Lucide icons [here](https://lucide.dev/icons/)`,
    suggestion: suggestIcon(candidate) ?? undefined,
  });
  return null;
}

/** Extract deduplicated terms from frontmatter tags */
function termsOf(file: ScannedFile): IngestedTerm[] {
  const terms: IngestedTerm[] = [];
  const seen = new Set<string>();
  for (const raw of file.frontmatter.tags ?? []) {
    const label = raw.trim();
    if (label === '') continue;
    const term = label.toLowerCase();
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push({ sourceSlugPath: file.slugPath, term, label, ordinal: terms.length });
  }
  return terms;
}

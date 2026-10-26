import { ChildRow } from '../authz/content/types';
import { DEFAULT_ICONS, iconOf, renderIconRef } from './icons';
import { escapeHtml } from './views';

/**
 * Sidebar navigation tree for read pages
 *
 * Builds a slug-path tree from the repository's flat child-row list and renders it
 * as nested lists with expand/collapse toggles
 * Branches containing the current page render expanded; the current page gets
 * aria-current="page"
 */
/** One node of the nav tree, keyed by its slug_path */
interface TreeNode {
  slugPath: string;
  title: string;
  kind: 'page' | 'folder';
  icon: string | null;
  hasIndex: boolean; // A folder whose own page is an index document, not a generated listing
  children: TreeNode[];
}

/** Rendered nav tree plus the icon names it referenced */
export interface NavTree {
  html: string; // Rendered nested <ul> tree

  icons: string[]; // Icon names used, for the caller's sprite
}

/**
 * Builds and renders the nav tree for one repo
 *
 * Rows are grouped by slug_path; a page and its folder row merge, folder kind wins
 * and the later row fills in whichever of icon and title the earlier lacks
 */
export function buildNavTree(nodes: ChildRow[], basePath: string, currentPath: string): NavTree {
  const byPath = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  // The repo root page (empty slug_path) is the document itself, not a nav entry
  const ordered = nodes.filter((n) => !(n.kind === 'page' && n.slug_path === ''));

  for (const node of ordered) {
    // The repo root folder is implicit in the tree, so it has no entry either
    if (node.kind === 'folder' && node.slug_path === '') continue;

    // A folder row and its index-page row share a slug_path, so rows can collide here
    const existing = byPath.get(node.slug_path);
    if (existing) {
      if (node.kind === 'folder') existing.kind = 'folder';
      else existing.hasIndex = true;
      existing.icon ??= node.icon;
      if (!existing.title) existing.title = node.title;
      continue;
    }

    byPath.set(node.slug_path, {
      slugPath: node.slug_path,
      title: node.title,
      kind: node.kind,
      icon: node.icon,
      // Either row may arrive first, so a page row counts whichever order they come in
      hasIndex: node.kind === 'page',
      children: [],
    });
  }

  // A node's parent is its path minus the last segment; a missing parent means a root
  for (const node of byPath.values()) {
    const parentPath = node.slugPath.split('/').slice(0, -1).join('/');

    // Guards the empty slug_path case, where the computed parent is the node itself
    const parent = parentPath === node.slugPath ? undefined : byPath.get(parentPath);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const used: string[] = [];

  const start =
    nodes.find((n) => n.kind === 'page' && n.slug_path === '') ??
    nodes.find((n) => n.slug_path === '');

  const html = `<ul class="spr-nav-root spr-nav-tree">${
    start ? renderIndexLink(start, basePath, currentPath, used) : ''
  }${roots.map((n) => renderNode(n, basePath, currentPath, used)).join('')}</ul>`;
  return { html, icons: used };
}

/** Renders the repo's start page as the tree's first entry */
function renderIndexLink(
  start: ChildRow,
  basePath: string,
  currentPath: string,
  used: string[],
): string {
  const icon = start.icon ?? DEFAULT_ICONS.start;
  used.push(icon);
  return (
    `<li class="spr-nav-leaf spr-nav-start"><a href="${escapeHtml(`${basePath}/`)}"` +
    `${currentPath === '' ? ' aria-current="page"' : ''} data-tree-link>` +
    `${renderIconRef(icon)}<span>${escapeHtml(start.title)}</span></a></li>`
  );
}

/** True when the node or one of its descendants is the current page */
function containsCurrent(node: TreeNode, currentPath: string): boolean {
  return currentPath === node.slugPath || currentPath.startsWith(`${node.slugPath}/`);
}

/** Renders one node as a list item, recursing into its children */
function renderNode(node: TreeNode, basePath: string, currentPath: string, used: string[]): string {
  const href = `${basePath}/${node.slugPath}`;
  const isCurrent = node.slugPath === currentPath;
  const icon = iconOf(node);
  used.push(icon);

  // The island reads `data-tree-index` to decide whether clicking an open folder's
  // label closes it or first takes the reader to the index page
  const label =
    `<a href="${escapeHtml(href)}"${isCurrent ? ' aria-current="page"' : ''}` +
    `${node.hasIndex && node.children.length > 0 ? ' data-tree-index' : ''} data-tree-link>${renderIconRef(icon)}<span>${escapeHtml(node.title)}</span></a>`;

  if (node.children.length === 0) {
    return `<li class="spr-nav-leaf">${label}</li>`;
  }

  const open = containsCurrent(node, currentPath);
  const groupId = `tree-${node.slugPath.replace(/[^a-z0-9]+/gi, '-')}`;

  const toggle =
    `<button type="button" class="spr-nav-toggle" aria-expanded="${open}" aria-controls="${groupId}" ` +
    `aria-label="${open ? 'Collapse' : 'Expand'} ${escapeHtml(node.title)}" ` +
    `data-tree-toggle="${escapeHtml(node.slugPath)}"></button>`;

  // The button and its group share the slug_path in their data attributes for the toggler
  const children =
    `<ul id="${groupId}" data-tree-group="${escapeHtml(node.slugPath)}"${open ? '' : ' hidden'}>` +
    `${node.children.map((c) => renderNode(c, basePath, currentPath, used)).join('')}</ul>`;

  return `<li class="spr-nav-branch"><div class="spr-nav-row">${label}${toggle}</div>${children}</li>`;
}

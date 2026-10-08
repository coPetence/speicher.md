/**
 * Built-in MDX components rendered to HTML
 *
 * Each known JSX tag name maps to open, close, and void renderers
 * Block and inline variants share the same definition via an optional inline slot
 *
 * Card, CardGrid, and LinkCard share nesting state stored on the render env
 * Unknown component names are collected into env.mdx.components for diagnostics
 *
 * Not a generic JSX renderer: only the tags listed in COMPONENTS are handled
 */

import MarkdownIt from 'markdown-it';

import { calloutOpenTag, capitalise, CALLOUT_CLOSE_TAG, directiveLevel } from '../callouts';
import {
  CARD_CLASS,
  CARD_TITLE_CLASS,
  CARDS_CLASS,
  CARDS_ROWS_CLASS,
  CHIP_CLASS,
  CHIP_VARIANTS,
  FILE_TREE_CLASS,
  LINK_BUTTON_CLASS,
  LISTING_CLASS,
  STEPS_CLASS,
  TAB_CLASS,
  TAB_LABEL_CLASS,
  TABS_CLASS,
  TABS_SYNC_ATTR,
} from './classes';
import { MdxEnv } from './env';
import { attrExpression, attrText, JsxTag } from './jsx';

/** Context passed to every component renderer */
export interface Renderer {
  md: MarkdownIt;
  env: MdxEnv;
  options: MarkdownIt.Options;
}

/**
 * Renderers for one component tag
 *
 * Block-level open, close, and void handlers
 * Inline handlers are separate to allow different rendering from block context
 */
export interface Component {
  open?(tag: JsxTag, r: Renderer): string;
  close?: string | ((r: Renderer) => string);
  void?(tag: JsxTag, r: Renderer): string;
  inline?: {
    open?(tag: JsxTag, r: Renderer): string;
    close?: string;
    void?(tag: JsxTag, r: Renderer): string;
  };
}

function esc(r: Renderer, text: string): string {
  return r.md.utils.escapeHtml(text);
}

/** Build open/close handlers wrapping content in a <div> with the given class */
function div(className: string): Pick<Component, 'open' | 'close'> {
  return { open: () => `<div class="${className}">\n`, close: '</div>\n' };
}

/** Render a chip span from text and optional variant attributes */
function chip(tag: JsxTag, r: Renderer): string {
  const text = attrText(tag, 'text');
  if (!text) return '';
  const variant = attrText(tag, 'variant');
  const modifier = variant && CHIP_VARIANTS.has(variant) ? ` ${CHIP_CLASS}-${variant}` : '';
  return `<span class="${CHIP_CLASS}${modifier}">${esc(r, text)}</span>`;
}

/** Render the opening <a> tag of a link button, empty if no href */
function linkButtonOpen(tag: JsxTag, r: Renderer): string {
  const href = attrText(tag, 'href');
  return href === null ? '' : `<a class="${LINK_BUTTON_CLASS}" href="${esc(r, href)}">`;
}

/**
 * Get or initialise card nesting state on the render env
 *
 * Not a module-level variable to allow concurrent render calls
 */
function cardState(r: Renderer): { grids: number; ownList: boolean[] } {
  return (r.env.mdxCards ??= { grids: 0, ownList: [] });
}

/** Wrap item in a listing list unless already inside a CardGrid */
function inList(r: Renderer, item: string): string {
  if (cardState(r).grids > 0) return item;
  return `<ul class="${LISTING_CLASS} ${CARDS_CLASS} ${CARDS_ROWS_CLASS}">\n${item}</ul>\n`;
}

/** Render a card with optional link and description, wrapped in a listing if standalone */
function linkCard(tag: JsxTag, r: Renderer): string {
  const title = esc(r, attrText(tag, 'title') ?? '');
  const href = attrText(tag, 'href');
  const description = attrText(tag, 'description');
  const heading =
    href === null
      ? `<p class="${CARD_TITLE_CLASS}">${title}</p>`
      : `<a href="${esc(r, href)}">${title}</a>`;
  return inList(r, `<li>${heading}${description ? `<p>${esc(r, description)}</p>` : ''}</li>\n`);
}

/**
 * Render a Code component as a fenced code block
 *
 * When the code attribute is an expression, extracts it for later evaluation
 * Reuses the markdown-it fence renderer for consistent syntax highlighting
 */
function codeBlock(tag: JsxTag, r: Renderer): string {
  const code = attrText(tag, 'code');
  if (code === null) {
    const expression = attrExpression(tag, 'code');
    if (expression) r.env.mdx.expressions.push(expression);
    return '';
  }
  const state = new r.md.core.State('', r.md, r.env);
  const fence = new state.Token('fence', 'code', 0);
  fence.info = attrText(tag, 'lang') ?? '';
  // The fence renderer expects a trailing newline
  fence.content = code.endsWith('\n') ? code : `${code}\n`;
  return r.md.renderer.rules.fence!([fence], 0, r.options, r.env, r.md.renderer);
}

/** Known MDX JSX tag renderers */
const COMPONENTS: Record<string, Component> = {
  // Groups tab panels with optional sync key for linked tab groups
  Tabs: {
    open: (tag, r) => {
      const sync = (attrText(tag, 'syncKey') ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      const attr = sync ? ` ${TABS_SYNC_ATTR}="${esc(r, sync)}"` : '';
      return `<div class="${TABS_CLASS}"${attr}>\n`;
    },
    close: '</div>\n',
  },
  // One tab panel with an optional label heading
  TabItem: {
    open: (tag, r) => {
      const label = attrText(tag, 'label');
      const heading = label ? `<p class="${TAB_LABEL_CLASS}">${esc(r, label)}</p>` : '';
      return `<div class="${TAB_CLASS}">${heading}\n`;
    },
    close: '</div>\n',
  },
  // Ordered step list
  Steps: div(STEPS_CLASS),
  // File tree with directory structure
  FileTree: div(FILE_TREE_CLASS),
  // Increments a grid counter so nested cards skip their own list wrapper
  CardGrid: {
    open: (_tag, r) => {
      cardState(r).grids++;
      return `<ul class="${LISTING_CLASS} ${CARDS_CLASS}">\n`;
    },
    close: (r) => {
      cardState(r).grids--;
      return '</ul>\n';
    },
  },
  // Outside grids, wraps itself in a list via the ownList stack
  Card: {
    open: (tag, r) => {
      const state = cardState(r);
      const ownList = state.grids === 0;
      state.ownList.push(ownList);
      const title = attrText(tag, 'title');
      const heading = title ? `<p class="${CARD_TITLE_CLASS}">${esc(r, title)}</p>` : '';
      const list = ownList
        ? `<ul class="${LISTING_CLASS} ${CARDS_CLASS} ${CARDS_ROWS_CLASS}">\n`
        : '';
      return `${list}<li class="${CARD_CLASS}">${heading}\n`;
    },
    close: (r) => (cardState(r).ownList.pop() ? '</li>\n</ul>\n' : '</li>\n'),
  },
  // Card backed by a link; void and open share one renderer, body content is ignored
  LinkCard: { void: linkCard, open: linkCard },
  // Callout aside whose level and title derive from the type attribute
  Aside: {
    open: (tag, r) => {
      const type = attrText(tag, 'type') ?? 'note';
      const level = directiveLevel(type) ?? 'note';
      const title = attrText(tag, 'title') ?? capitalise(directiveLevel(type) ? type : 'note');
      return calloutOpenTag(level, esc(r, title));
    },
    close: CALLOUT_CLOSE_TAG,
  },
  // Block variant wraps the chip in a paragraph; inline renders the chip alone
  Badge: {
    void: (tag, r) => `<p>${chip(tag, r)}</p>\n`,
    inline: { void: chip },
  },
  // Inline variant omits the trailing newline present in block rendering
  LinkButton: {
    open: linkButtonOpen,
    close: '</a>\n',
    inline: { open: linkButtonOpen, close: '</a>' },
  },
  // Fenced code block from a code attribute
  Code: { void: codeBlock },
  // Known component that produces no output
  Icon: { void: () => '', inline: { void: () => '' } },
  // Extracts set:html expression for later evaluation, produces no output
  Fragment: {
    void: (tag, r) => {
      const html = attrExpression(tag, 'set:html');
      if (html) r.env.mdx.expressions.push(html);
      return '';
    },
  },
};

/** Names of all registered components */
export const KNOWN_COMPONENTS = Object.keys(COMPONENTS);

/** True if the tag name has a registered renderer */
export function isKnownComponent(name: string): boolean {
  return Object.hasOwn(COMPONENTS, name);
}

/** Resolve a component's close value, calling function-typed close handlers */
export function closeOf(component: Component, r: Renderer): string {
  const close = component.close;
  return typeof close === 'function' ? close(r) : (close ?? '');
}

/**
 * Resolve a JSX tag to its component definition
 *
 * Unknown tags are recorded in env.mdx.components and return an empty component
 */
export function componentOf(tag: JsxTag, env: MdxEnv): Component {
  const component = isKnownComponent(tag.name) ? COMPONENTS[tag.name] : undefined;
  if (!component) {
    env.mdx.components.add(tag.name);
    return {};
  }
  return component;
}

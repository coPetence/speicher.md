/**
 * MDX parsing and rendering for markdown-it
 *
 * Registers block and inline parsers for JSX, ESM, and expressions
 * Provides renderer rules that dispatch JSX tokens to component handlers
 *
 * Re-exports the public types and constants of the MDX subsystem
 */

import MarkdownIt from 'markdown-it';

import { esmBlock, expressionBlock, jsxBlock } from './blocks';
import { closeOf, componentOf, isKnownComponent, Renderer } from './components';
import { MdxEnv } from './env';
import { expressionInline, headingText, jsxInline } from './inline';
import { JsxTag } from './jsx';

export { MDX_ALLOWED_CLASSES, CHIP_VARIANTS, TABS_SYNC_ATTR } from './classes';
export { emptyMdxDropped, MdxDropped, MdxEnv } from './env';
export { KNOWN_COMPONENTS } from './components';

/**
 * Install MDX rules on a markdown-it instance
 *
 * Registers parsers and renderers for JSX, ESM, expressions
 * Not indented code blocks: MDX only uses fenced code
 */
export function installMdx(md: MarkdownIt): void {
  md.disable('code');

  // JSX block can interrupt these container types
  const interrupts = { alt: ['paragraph', 'reference', 'blockquote', 'list'] };
  md.block.ruler.before('table', 'mdx_esm', esmBlock);
  md.block.ruler.before('table', 'mdx_expression', expressionBlock);
  md.block.ruler.before('table', 'mdx_jsx', jsxBlock, interrupts);
  md.inline.ruler.before('html_inline', 'mdx_jsx', jsxInline);
  md.inline.ruler.before('html_inline', 'mdx_expression', expressionInline);
  // Strip JSX from heading content to keep anchor IDs clean
  md.core.ruler.after('inline', 'mdx_heading_text', headingText);

  const renderer = (options: MarkdownIt.Options, env: unknown): Renderer => ({
    md,
    env: env as MdxEnv,
    options,
  });

  /** Render the opening tag of a JSX component */
  md.renderer.rules.mdx_jsx_open = (tokens, idx, options, env) => {
    const tag = tokens[idx].meta as JsxTag;
    return componentOf(tag, env as MdxEnv).open?.(tag, renderer(options, env)) ?? '';
  };
  /** Render the closing tag, dropping unknowns collected in env */
  md.renderer.rules.mdx_jsx_close = (tokens, idx, options, env) => {
    const tag = tokens[idx].meta as JsxTag;
    if (!isKnownComponent(tag.name)) return '';
    return closeOf(componentOf(tag, env as MdxEnv), renderer(options, env));
  };
  /** Render a self-closing JSX tag via void handler or open+close */
  md.renderer.rules.mdx_jsx_void = (tokens, idx, options, env) => {
    const tag = tokens[idx].meta as JsxTag;
    const component = componentOf(tag, env as MdxEnv);
    const r = renderer(options, env);
    if (component.void) return component.void(tag, r);
    return (component.open?.(tag, r) ?? '') + closeOf(component, r);
  };
  /** Render an inline JSX tag via the component's inline handlers */
  md.renderer.rules.mdx_jsx_inline = (tokens, idx, options, env) => {
    const tag = tokens[idx].meta as JsxTag;
    const inline = (
      tag.kind === 'close' && !isKnownComponent(tag.name) ? {} : componentOf(tag, env as MdxEnv)
    ).inline;
    if (!inline) return '';
    const r = renderer(options, env);
    if (tag.kind === 'open') return inline.open?.(tag, r) ?? '';
    if (tag.kind === 'close') return inline.close ?? '';
    return inline.void?.(tag, r) ?? '';
  };
}

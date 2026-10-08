/**
 * Overrides for markdown-it-footnote render rules
 *
 * Wraps footnotes in `<section class="spr-footnotes"><ol>`, no `<hr>`
 * Not default `<hr>`: CSS provides the spacing
 * Repeated citations of the same note get a `-{n}` fragment suffix
 * Not default footnote classes: the HTML sanitiser permits only specific classes
 */

import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';

/** CSS class on the `<section>` wrapping the footnote list */
export const FOOTNOTES_CLASS = 'spr-footnotes';
/** CSS class on each footnote reference `<sup>` */
export const FOOTNOTE_REF_CLASS = 'spr-footnote-ref';
/** CSS class on back-links from a footnote to its reference */
export const FOOTNOTE_BACK_CLASS = 'spr-footnote-back';

type Rule = MarkdownIt.Renderer.RenderRule;

/** 1-based footnote display number from the token's 0-based `meta.id` */
function number(tokens: MarkdownIt.Token[], idx: number): string {
  return String((tokens[idx].meta as { id: number }).id + 1);
}

/** `-{n}` suffix for duplicate refs to the same footnote, empty for the first reference */
function refSuffix(tokens: MarkdownIt.Token[], idx: number): string {
  const sub = (tokens[idx].meta as { subId?: number }).subId ?? 0;
  return sub > 0 ? `-${sub}` : '';
}

/** Inline footnote reference as a linked superscript */
const renderRef: Rule = (tokens, idx) => {
  const n = number(tokens, idx);
  return (
    `<sup class="${FOOTNOTE_REF_CLASS}">` +
    `<a href="#fn-${n}" id="fnref-${n}${refSuffix(tokens, idx)}">${n}</a></sup>`
  );
};

/** Back-link from a footnote to its in-text reference */
const renderAnchor: Rule = (tokens, idx) => {
  const n = number(tokens, idx);
  const suffix = refSuffix(tokens, idx);

  return (
    ` <a href="#fnref-${n}${suffix}" class="${FOOTNOTE_BACK_CLASS}" ` +
    `aria-label="Back to reference ${n}">↩︎</a>`
  );
};

/** Register the footnote plugin and replace its default render rules */
export function installFootnotes(md: MarkdownIt): void {
  md.use(footnote);
  md.renderer.rules.footnote_ref = renderRef;
  md.renderer.rules.footnote_anchor = renderAnchor;
  md.renderer.rules.footnote_block_open = () => `<section class="${FOOTNOTES_CLASS}">\n<ol>\n`;
  md.renderer.rules.footnote_open = (tokens, idx) => `<li id="fn-${number(tokens, idx)}">`;
}

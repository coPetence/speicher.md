/*
 * highlight.js ships its types only for the package root, and `moduleResolution:
 * node` predates `exports` maps — so the subpath imports the highlighter uses
 * resolve to JavaScript with no declarations, and `noImplicitAny` rejects them.
 *
 * Importing the root instead would type-check but pull in all ~200 languages at
 * require time. Declaring the two subpaths keeps the registered set the small
 * deliberate one in `src/ingest/highlight.ts`.
 */
declare module 'highlight.js/lib/common' {
  import type { HLJSApi } from 'highlight.js';
  const hljs: HLJSApi;
  export default hljs;
}

declare module 'highlight.js/lib/languages/*' {
  import type { LanguageFn } from 'highlight.js';
  const language: LanguageFn;
  export default language;
}

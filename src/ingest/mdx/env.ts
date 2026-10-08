/**
 * MDX environment types and expression collector
 *
 * The env object flows through markdown-it's render pipeline
 * MdxDropped collects unknown component names and all expressions found in source
 * MdxEnv adds optional card grid nesting state for CardGrid/Card components
 * recordExpression is the single point that gathers expressions, skipping JSX comments
 */

export interface MdxDropped {
  /** Unknown components and collected expressions */
  components: Set<string>;
  expressions: string[];
}

export interface MdxEnv {
  mdx: MdxDropped;

  /** Card grid depth and per-card list ownership, set lazily by CardGrid/Card */
  mdxCards?: { grids: number; ownList: boolean[] };
}

/** Create an MdxDropped with empty component set and expression list */
export function emptyMdxDropped(): MdxDropped {
  return { components: new Set(), expressions: [] };
}

/** True when expression is a JSX block comment: `{/* … *\/}` — the `*\/` is escaped, or it ends this comment. */
function isComment(expression: string): boolean {
  return /^\{\s*\/\*[\s\S]*\*\/\s*\}$/.test(expression);
}

/** Collect a non-comment expression into env.mdx.expressions */
export function recordExpression(env: MdxEnv, expression: string): void {
  if (!isComment(expression)) env.mdx.expressions.push(expression);
}

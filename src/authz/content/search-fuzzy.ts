/**
 * Fuzzy term extraction and pg_trgm SQL generation for content search
 *
 * Extracts significant words from a query string and builds SQL fragments that
 * match those words in a column using PostgreSQL trigram word similarity
 *
 * Short terms get a stricter similarity threshold to reduce false positives
 * Terms under three characters are dropped
 *
 * Exports FUZZY_WORD_THRESHOLD for callers to set the session-level threshold
 * before running the generated SQL
 */

/** Not more to avoid unbounded SQL clause count */
const FUZZY_MAX_TERMS = 8;

/** pg_trgm word_similarity threshold */
export const FUZZY_WORD_THRESHOLD = 0.5;
/** Terms shorter than this get a stricter word_similarity threshold */
const FUZZY_LOOSE_MIN_LENGTH = 5;
/** Stricter threshold for short terms to reduce false positives */
const FUZZY_SHORT_THRESHOLD = 0.6;

/** Extract up to FUZZY_MAX_TERMS significant words from a query
 *
 *  Splits on non-letter, non-number characters and takes words of at least
 *  three characters, deduplicated. Falls back to the original query when no
 *  word meets the minimum length. Not empty to keep the generated SQL valid
 */
export function fuzzyTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const word of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= 3) seen.add(word);
    if (seen.size === FUZZY_MAX_TERMS) break;
  }
  return seen.size > 0 ? [...seen] : [query];
}

/** SQL fragments for fuzzy matching terms against a column
 *
 *  Uses pg_trgm word similarity with speicher_unaccent
 *  Short terms add an explicit word_similarity threshold
 *  Returns any (boolean OR), count (integer sum), score (average) */
export function fuzzySql(terms: string[], column: string) {
  // Applies a function to each term's unaccented parameter reference
  const each = (f: (param: string) => string) =>
    terms.map((_, i) => f(`public.speicher_unaccent(:t${i})`));

  const matches = terms.map((term, i) => {
    const t = `public.speicher_unaccent(:t${i})`;
    const hit = `${t} <% ${column}`;
    return term.length >= FUZZY_LOOSE_MIN_LENGTH
      ? hit
      : `(${hit} AND word_similarity(${t}, ${column}) >= ${FUZZY_SHORT_THRESHOLD})`;
  });
  return {
    any: `(${matches.join(' OR ')})`, // True when at least one term matches

    count: `(${matches.map((m) => `(${m})::int`).join(' + ')})`, // Number of matching terms

    score: `((${each((t) => `word_similarity(${t}, ${column})`).join(' + ')}) / ${terms.length})`, // Average similarity
  };
}

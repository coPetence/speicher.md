/**
 * What a live check found: a stable code to tell outcomes apart, and words for the page
 *
 * Callers and tests read the code and the facts, never the words, which are free to
 * change. Facts are what the words are built from, such as a host or a user name
 */
export interface CheckStatus<C extends string = string> {
  code: C;
  level: 'ok' | 'info' | 'warn' | 'fail';
  label: string;
  detail: string;
  facts?: Record<string, string | number | boolean>;
}

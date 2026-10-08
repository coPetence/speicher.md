/**
 * Task list items from Markdown checkbox syntax
 *
 * `[ ]`, `[x]` and `[X]` at the start of a list item become task items with
 * CSS classes and a hidden state span
 *
 * Not rendered as `<input>`: the sanitiser would strip it and nobody could
 * tick a published page
 */
import MarkdownIt from 'markdown-it';

/** CSS class on any task list item */
export const TASK_CLASS = 'spr-task';
/** CSS class on completed items, in addition to TASK_CLASS */
export const TASK_DONE_CLASS = 'spr-task-done';
/** CSS class on the hidden span that holds the state in words */
export const TASK_STATE_CLASS = 'spr-task-state';

/** Words prefixed to the item text, visible in plain-text output */
export const TASK_STATE_WORDS = { done: 'Done:', open: 'To do:' } as const;

/**
 * Matches the task marker at the start of a list item's inline text
 * Group 1 captures the char that determines state: space for open,
 * x or X for done
 */
const MARKER = /^\[([ xX])\][ \t]+/;

/**
 * Markdown-it core rule: converts checkbox-marked list items to task items
 *
 * Walks the token stream for list items whose first paragraph starts with a
 * task marker. Strips the marker, adds CSS classes, and prepends a hidden
 * `<span>` with the state in words
 */
function taskRule(state: MarkdownIt.StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (tokens[i].type !== 'list_item_open') continue;
    if (tokens[i + 1].type !== 'paragraph_open') continue;
    const inline = tokens[i + 2];
    const first = inline.children?.[0];
    if (inline.type !== 'inline' || first?.type !== 'text') continue;

    const marker = MARKER.exec(first.content);
    if (!marker) continue;

    const done = marker[1] !== ' ';
    first.content = first.content.slice(marker[0].length);
    tokens[i].attrJoin('class', done ? `${TASK_CLASS} ${TASK_DONE_CLASS}` : TASK_CLASS);

    const label = new state.Token('html_inline', '', 0);
    const words = done ? TASK_STATE_WORDS.done : TASK_STATE_WORDS.open;
    label.content = `<span class="${TASK_STATE_CLASS}">${words} </span>`;
    inline.children!.unshift(label);
  }
}

/** Install the task list plugin into a markdown-it instance */
export function installTasks(md: MarkdownIt): void {
  md.core.ruler.after('inline', 'task_lists', taskRule);
}

import { renderMarkdown, rewriteMarkdownLinks } from '../../src/ingest/markdown';
import { TASK_STATE_WORDS } from '../../src/ingest/tasks';

function render(source: string, mdx = false) {
  return renderMarkdown(source, { mdx, resolveLink: (target) => `/r/${target}` });
}

describe('task lists', () => {
  it('marks an item by its state, and says the state in words', () => {
    const { html } = render('- [ ] Charge the tablets\n- [x] Download the survey\n- [X] Pack\n');
    expect(html).toContain(
      `<li class="spr-task"><span class="spr-task-state">${TASK_STATE_WORDS.open} </span>Charge the tablets</li>`,
    );
    expect(html).toContain(
      `<li class="spr-task spr-task-done"><span class="spr-task-state">${TASK_STATE_WORDS.done} </span>Download the survey</li>`,
    );
    expect(html.match(/spr-task-done/g)).toHaveLength(2);
  });

  it('draws no form control, which the sanitiser would refuse and nobody could tick', () => {
    expect(render('- [x] done\n').html).not.toMatch(/<input|checkbox|disabled/);
  });

  it('carries the state into the text search and agents read', () => {
    expect(render('- [x] Pack\n- [ ] Drive\n').plain).toBe(
      `${TASK_STATE_WORDS.done} Pack\n${TASK_STATE_WORDS.open} Drive`,
    );
  });

  it('works in a loose list, an ordered list, and in MDX', () => {
    expect(render('- [x] one\n\n- [ ] two\n').html).toContain(
      '<li class="spr-task spr-task-done">\n<p><span class="spr-task-state">',
    );
    expect(render('1. [x] one\n').html).toContain('<ol>\n<li class="spr-task spr-task-done">');
    expect(render('- [ ] one\n', true).html).toContain('<li class="spr-task">');
  });

  it('leaves a marker that is not the first text of an item alone', () => {
    const { html } = render(
      '- [ ]no space\n- `[x]` in code\n- text [x] later\n- [x]\n\n[x]: page.md\n',
    );
    expect(html).not.toContain('spr-task');
    expect(html).toContain('<li>[ ]no space</li>');
  });
});

describe('footnotes', () => {
  const source =
    'The interval[^sync] is set per device[^sync], and quotas per plan[^2].\n\n' +
    '[^sync]: See the [device settings](devices.md).\n' +
    '[^2]: Enterprise quotas are set by contract.\n';

  it('numbers references in order and links each to its note and back', () => {
    const { html } = render(source);
    expect(html).toContain(
      '<sup class="spr-footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup>',
    );
    // A second reference to one note gets an id of its own to come back to.
    expect(html).toContain('<a href="#fn-1" id="fnref-1-1">1</a>');
    expect(html).toContain('<a href="#fn-2" id="fnref-2">2</a>');
    expect(html).toContain('<li id="fn-1">');
    expect(html).toContain(
      '<a href="#fnref-1-1" class="spr-footnote-back" aria-label="Back to reference 1">',
    );
  });

  it('closes the page with the notes, Markdown and links resolved inside them', () => {
    const { html } = render(source);
    expect(html).toMatch(
      /<section class="spr-footnotes">\n<ol>\n<li id="fn-1"><p>See the <a href="\/r\/devices.md">/,
    );
    expect(html).not.toContain('<hr');
  });

  it('is never read as a link reference, which is what it was before', () => {
    // `[^1]: note` is a valid reference definition, so without the plugin `[^1]`
    // linked to a page called `note` and reported it broken.
    const { html, brokenLinks } = render('Text[^1].\n\n[^1]: note\n');
    expect(brokenLinks).toEqual([]);
    expect(html).not.toContain('/r/note');
  });

  it('keeps its numbers and arrows out of the text search and agents read', () => {
    expect(render(source).plain).toBe(
      'The interval is set per device, and quotas per plan.\n\n' +
        'See the device settings.\n\nEnterprise quotas are set by contract.',
    );
  });

  it('gives every link a target the page has', () => {
    const { html } = render(source);
    const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
    const targets = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(targets.length).toBe(6);
    expect(targets.filter((t) => !ids.has(t))).toEqual([]);
  });

  it('leaves a definition alone in the Markdown served to agents', () => {
    const out = rewriteMarkdownLinks(
      'Text[^1].\n\n[^1]: note.md\n[ref]: page.md\n',
      (t) => `/r/${t}`,
    );
    expect(out).toContain('[^1]: note.md');
    expect(out).toContain('[ref]: /r/page.md');
  });
});

/**
 * @jest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The tabs upgrade, run as it ships: inside the reader's `tree` bundle, against the
 * markup `ingest/mdx/` stores. What is asserted is the page a reader ends up
 * with — one panel showing, the others `hidden`, the buttons named by the labels —
 * and that a sync key carries a choice to every group sharing it.
 */
const BUNDLE = (() => {
  const dir = join(__dirname, '../../dist/client');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<
    string,
    string
  >;
  return readFileSync(join(dir, manifest.tree), 'utf8');
})();

function group(sync: string | null, labels: string[]): string {
  const attr = sync ? ` data-spr-tabs="${sync}"` : '';
  const panels = labels
    .map(
      (label) =>
        `<div class="spr-tab"><p class="spr-tab-label">${label}</p><p>${label} body</p></div>`,
    )
    .join('');
  return `<div class="spr-tabs"${attr}>${panels}</div>`;
}

function mount(html: string): void {
  document.body.innerHTML = `<main class="spr-main"><div class="spr-article">${html}</div></main>`;
  // eslint-disable-next-line no-new-func
  new Function(BUNDLE)();
}

const groups = () => Array.from(document.querySelectorAll<HTMLElement>('.spr-tabs'));
const tabs = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
const shown = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>('.spr-tab'))
    .filter((panel) => !panel.hidden)
    .map((panel) => panel.querySelector('.spr-tab-label')?.textContent);

beforeEach(() => {
  localStorage.clear();
});

describe('the tabs upgrade', () => {
  it('names a tab per panel and shows the first panel alone', () => {
    mount(group(null, ['Python', 'TypeScript']));
    const [root] = groups();
    expect(tabs(root).map((tab) => tab.textContent)).toEqual(['Python', 'TypeScript']);
    expect(tabs(root).map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(shown(root)).toEqual(['Python']);
    expect(root.hasAttribute('data-spr-live')).toBe(true);
  });

  it('ties each tab to its panel for assistive technology', () => {
    mount(group(null, ['Python', 'TypeScript']));
    const [root] = groups();
    for (const tab of tabs(root)) {
      const panel = document.getElementById(tab.getAttribute('aria-controls')!)!;
      expect(panel.getAttribute('role')).toBe('tabpanel');
      expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
    }
  });

  it('switches on a click, and moves with the arrow keys', () => {
    mount(group(null, ['Python', 'TypeScript', 'Go']));
    const [root] = groups();
    tabs(root)[1].click();
    expect(shown(root)).toEqual(['TypeScript']);

    tabs(root)[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(shown(root)).toEqual(['Go']);
    expect(document.activeElement).toBe(tabs(root)[2]);
    tabs(root)[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(shown(root)).toEqual(['Python']);
  });

  it('switches every group sharing a sync key, and only those', () => {
    mount(
      group('language', ['Python', 'TypeScript']) +
        group('language', ['Python', 'TypeScript']) +
        group(null, ['Python', 'TypeScript']),
    );
    const [first, second, unsynced] = groups();
    tabs(first)[1].click();
    expect(shown(second)).toEqual(['TypeScript']);
    expect(shown(unsynced)).toEqual(['Python']);
  });

  it('remembers a synced choice for the next page', () => {
    mount(group('language', ['Python', 'TypeScript']));
    tabs(groups()[0])[1].click();
    mount(group('language', ['Python', 'TypeScript']));
    expect(shown(groups()[0])).toEqual(['TypeScript']);
  });

  it('falls back to the first tab when the remembered one is not in this group', () => {
    localStorage.setItem('speicher.tabs.language', 'Rust');
    mount(group('language', ['Python', 'TypeScript']));
    expect(shown(groups()[0])).toEqual(['Python']);
  });
});

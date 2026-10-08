/**
 * Tabs with ARIA semantics, keyboard navigation, and cross-group sync
 *
 * Upgrades `.spr-tabs` elements: tab labels from `.spr-tab-label` textContent
 * A `.spr-tablist` with `role=tablist` is created and prepended
 *
 * Groups sharing the same `data-spr-tabs` key stay in sync and persist their selection
 * in localStorage under the `speicher.tabs.` prefix
 */

const LIVE = 'sprLive'; // Dataset key that marks a group as upgraded
const STORAGE_PREFIX = 'speicher.tabs.';

let groups = 0; // Counter for unique tab group IDs

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(STORAGE_PREFIX + key);
  } catch {
    return null;
  }
}

function remember(key: string, label: string): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, label);
  } catch {
    //
  }
}

interface Group {
  root: HTMLElement; // The `.spr-tabs` container
  buttons: HTMLButtonElement[]; // Tab buttons in the tablist
  panels: HTMLElement[]; // The `.spr-tab` panels
  labels: string[]; // Text labels for each tab
}

function select(group: Group, index: number): void {
  group.buttons.forEach((button, i) => {
    const selected = i === index;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    group.panels[i].hidden = !selected;
  });
}

function selectLabel(group: Group, label: string): boolean {
  const index = group.labels.indexOf(label);
  if (index < 0) return false;
  select(group, index);
  return true;
}

const live: Group[] = []; // Active groups, used for cross-group sync

/** Builds a tabbed interface from a `.spr-tabs` element, returns null when no `.spr-tab` children */
function upgrade(root: HTMLElement): Group | null {
  const panels = [...root.children].filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.matches('.spr-tab'),
  );
  if (panels.length === 0) return null;

  const id = `spr-tabs-${++groups}`;
  const list = document.createElement('div');
  list.className = 'spr-tablist';
  list.setAttribute('role', 'tablist');

  const labels: string[] = [];
  const buttons = panels.map((panel, i) => {
    const label = panel.querySelector(':scope > .spr-tab-label')?.textContent?.trim() || `${i + 1}`;
    labels.push(label);
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `${id}-tab-${i}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `${id}-panel-${i}`);
    button.textContent = label;
    panel.id = `${id}-panel-${i}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    list.append(button);
    return button;
  });

  root.prepend(list);
  root.dataset[LIVE] = '';
  return { root, buttons, panels, labels };
}

/** Selects a tab, persists the choice, and syncs sibling groups sharing the same key */
function choose(group: Group, index: number): void {
  select(group, index);
  const key = group.root.dataset.sprTabs;
  if (!key) return;
  const label = group.labels[index];
  remember(key, label);
  for (const other of live) {
    if (other !== group && other.root.dataset.sprTabs === key) selectLabel(other, label);
  }
}

/** Keyboard navigation with ArrowRight, ArrowLeft, Home, and End */
function onKey(group: Group, event: KeyboardEvent): void {
  const current = group.buttons.indexOf(event.target as HTMLButtonElement);
  if (current < 0) return;
  const last = group.buttons.length - 1;
  const next =
    event.key === 'ArrowRight'
      ? (current + 1) % (last + 1)
      : event.key === 'ArrowLeft'
        ? (current + last) % (last + 1)
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? last
            : -1;
  if (next < 0) return;
  event.preventDefault();
  choose(group, next);
  group.buttons[next].focus();
}

/** Upgrades all `.spr-tabs` elements within scope that are not already upgraded */
export function mountTabs(scope: ParentNode = document): void {
  for (let i = live.length - 1; i >= 0; i--) {
    if (!live[i].root.isConnected) live.splice(i, 1);
  }

  for (const root of scope.querySelectorAll<HTMLElement>('.spr-tabs')) {
    if (LIVE in root.dataset) continue;
    const group = upgrade(root);
    if (!group) continue;
    live.push(group);

    const key = root.dataset.sprTabs;
    const stored = key ? remembered(key) : null;
    if (!(stored && selectLabel(group, stored))) select(group, 0);

    group.buttons.forEach((button, i) => button.addEventListener('click', () => choose(group, i)));
    group.root.addEventListener('keydown', (event) => onKey(group, event));
  }
}

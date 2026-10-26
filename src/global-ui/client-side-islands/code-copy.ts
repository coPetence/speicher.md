/**
 * Copy buttons on the code blocks of a page
 *
 * Wraps each `pre` in `.spr-code` and adds a button that copies the block's text
 * Added only when the Clipboard API is available, so no page shows a button that cannot work
 */

const COPIED_MS = 2_000;

const COPY_SHAPES =
  '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>';
const COPIED_SHAPES = '<path d="M20 6 9 17l-5-5"/>';

function icon(shapes: string): string {
  return `<svg class="spr-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes}</svg>`;
}

function showState(button: HTMLButtonElement, copied: boolean): void {
  button.innerHTML = icon(copied ? COPIED_SHAPES : COPY_SHAPES);
  button.setAttribute('aria-label', copied ? 'Copied' : 'Copy code');
  button.title = copied ? 'Copied' : 'Copy code';
  if (copied) button.dataset.sprState = 'copied';
  else delete button.dataset.sprState;
}

/** Adds a copy button to every code block in scope that has none yet */
export function mountCodeCopy(scope: ParentNode = document): void {
  if (!navigator.clipboard) return;

  for (const pre of Array.from(scope.querySelectorAll<HTMLPreElement>('.spr-main pre'))) {
    if (pre.parentElement?.classList.contains('spr-code')) continue;

    const wrap = document.createElement('div');
    wrap.className = 'spr-code';
    pre.replaceWith(wrap);
    wrap.append(pre);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'spr-code-copy';
    showState(button, false);
    wrap.append(button);

    let reset = 0;
    button.addEventListener('click', () => {
      void navigator.clipboard.writeText(pre.textContent ?? '').then(() => {
        showState(button, true);
        window.clearTimeout(reset);
        reset = window.setTimeout(() => showState(button, false), COPIED_MS);
      });
    });
  }
}

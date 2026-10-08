/**
 * Live connection checks on config sections and fields
 *
 * Notes with `data-spr-check` fetch the URL on page load and update their
 * appearance based on the response, so nobody has to press the link
 *
 * Section-level checks read `payload.section.status` directly
 * Field-level checks specify a path via `data-spr-check-at` and walk the
 * response tree to find a node with a matching `path` property
 *
 * On failure the note reverts to idle with a link to try manually
 */

// Depth-first search for a {path, status} node in a nested response
function statusAt(value: unknown, path: string): CheckStatus | undefined {
  if (value === null || typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  if (record.path === path && record.status) return record.status as CheckStatus;

  for (const child of Object.values(record)) {
    const found = statusAt(child, path);
    if (found) return found;
  }
  return undefined;
}

interface CheckStatus {
  level: string;
  label: string;
  detail: string;
}

export function mountChecks(): void {
  // Each note is a `<p class="spr-note spr-note-idle" data-spr-check="...">`
  for (const note of document.querySelectorAll<HTMLElement>('[data-spr-check]')) {
    const url = note.dataset.sprCheck ?? '';
    const text = note.querySelector<HTMLElement>('[data-spr-check-text]');
    if (url === '' || !text) continue;

    // Preserve any classes the server drew (e.g. spr-section-status), replacing
    // only the spr-note-* level class
    const base = note.className
      .replace(/\bspr-note-\S+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const at = note.dataset.sprCheckAt ?? '';

    // Sets the level class and shows only the matching mark icon
    const level = (name: string): void => {
      note.className = `${base} spr-note-${name}`;
      for (const mark of note.querySelectorAll<HTMLElement>('[data-spr-check-mark]')) {
        mark.hidden = mark.dataset.sprCheckMark !== name;
      }
    };

    text.textContent = 'Checking…';
    void (async () => {
      try {
        const response = await fetch(url, {
          headers: { Accept: 'application/json' },

          credentials: 'same-origin',
        });
        const payload = (await response.json()) as {
          section?: { status?: CheckStatus };
        };

        // Without data-spr-check-at the section has a direct status;
        // with it, search the field tree for the named path
        const status = at === '' ? payload.section?.status : statusAt(payload.section, at);
        if (!status) throw new Error('no status in the answer');

        level(status.level);

        text.textContent = status.detail ? `${status.label}: ${status.detail}` : status.label;
      } catch {
        // Network error or empty answer: restore the manual-check link
        level('idle');
        text.textContent = '';
        const link = document.createElement('a');
        link.href = url;
        link.textContent = 'Check the connection';
        text.append(link);
      }
    })();
  }
}

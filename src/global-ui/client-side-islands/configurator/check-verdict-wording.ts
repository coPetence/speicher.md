/** Save bar messages for check results and form validation */

export const UNSAVED = 'Unsaved changes.';

export function constraintProblem(form: HTMLFormElement): string {
  const invalid = [...form.querySelectorAll<HTMLInputElement>(':invalid')];
  const missingOnly = invalid.every((control) => control.validity?.valueMissing);
  return missingOnly
    ? `${UNSAVED} Something here still has to be filled in.`
    : `${UNSAVED} Something here is not in a shape its control accepts.`;
}

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/**
 * Convert Markdown links to DOM nodes and strip backticks
 * Allow only same-site paths and HTTPS URLs; never parse HTML
 */
export function linked(message: string): Node[] {
  const text = message.replace(/`/g, '');
  const nodes: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    const [whole, words, href] = match;
    nodes.push(document.createTextNode(text.slice(last, match.index)));
    nodes.push(linkTo(words, href));
    last = match.index + whole.length;
  }
  nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}

function linkTo(words: string, href: string): Node {
  const local = href.startsWith('/') && !href.startsWith('//');
  if (!local && !href.startsWith('https://')) return document.createTextNode(words);
  const a = document.createElement('a');
  a.href = href;
  a.textContent = words;
  if (!local) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';
  }
  return a;
}

export interface CheckAnswer {
  error: string | null;
  error_code?: string;
  error_path?: string | null;

  problems?: string[];
  problem_codes?: string[];
  problem_paths?: (string | null)[];
  verdict: {
    changed: { key: string; requiresRestart: boolean }[];
    rebuild: boolean;
    effect: string;
    hotReloadAvailable: boolean;
  } | null;
}

export function describe(verdict: CheckAnswer['verdict']): string {
  if (!verdict) return UNSAVED;

  if (verdict.effect === 'none') {
    return 'Unsaved changes, but nothing differs from the version in force.';
  }

  const notes: string[] = [];
  const restart = verdict.changed.filter((change) => change.requiresRestart).map((c) => c.key);

  if (!verdict.hotReloadAvailable) {
    notes.push(
      'Takes effect on restart: this instance does not reload its configuration while running',
    );
  } else if (restart.length > 0) {
    notes.push('Takes effect on restart');
  }

  if (verdict.rebuild) {
    notes.push('Saving enqueues a full rebuild of every repository.');
  }

  return [UNSAVED, ...notes].join(' ');
}

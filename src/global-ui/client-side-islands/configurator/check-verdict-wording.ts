/** What the save bar says: a check's answer, or the browser's constraints, as one sentence. */

export const UNSAVED = 'Unsaved changes.';

export function constraintProblem(form: HTMLFormElement): string {
  const invalid = [...form.querySelectorAll<HTMLInputElement>(':invalid')];
  const missingOnly = invalid.every((control) => control.validity?.valueMissing);
  return missingOnly
    ? `${UNSAVED} Something here still has to be filled in.`
    : `${UNSAVED} Something here is not in a shape its control accepts.`;
}

// Strips markdown-style links and backticks from a server-provided message
export function plain(message: string | undefined): string | undefined {
  return message?.replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1').replace(/`/g, '');
}

export interface CheckAnswer {
  error: string | null;

  problems?: string[];
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

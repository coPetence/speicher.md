import { ConfigProblem, ProblemAudience, wordingFor } from '../../../common/config-problems';
import { ConfigError } from '../../../common/errors';
import { FormProblem, SectionEntry, allEntries, allFields } from '../config-form/model';
import type { ConfigSectionPayload } from './payloads';

/**
 * Attach problems to matching fields and containing rows
 * Return whether each problem was attached; unmatched problems stay page-level
 */
export function stampProblems(payload: ConfigSectionPayload, problems: ConfigProblem[]): boolean[] {
  const landed = problems.map(() => false);
  if (!payload.section) return landed;
  const entries = allEntries(payload.section);
  // Carried fields are hidden; show their problems on the row
  const carried = new Set(entries.flatMap((entry) => entry.carried));
  const fields = allFields([payload.section]).filter((field) => !carried.has(field));

  for (const [i, problem] of problems.entries()) {
    if (!problem.path) continue;
    const at = fieldPathOf(problem.path);
    const stamp: FormProblem = { code: problem.code, text: wordingFor(problem, 'dashboard') };

    for (const field of fields) {
      if (field.path === at) {
        field.problems = [...(field.problems ?? []), stamp];
        landed[i] = true;
      }
    }
    for (const entry of entries) {
      const own = entryPathOf(entry);
      if (own !== null && (at === own || at.startsWith(`${own}.`))) {
        entry.problems = [...(entry.problems ?? []), stamp];
        landed[i] = true;
      }
    }
  }
  return landed;
}

/** Normalize array indices: `admins.users[0]` → `admins.users.0` */
export function fieldPathOf(path: string): string {
  return path.replace(/\[(\d+)\]/g, '.$1');
}

/** Extract the row path from its remove operation */
function entryPathOf(entry: SectionEntry): string | null {
  return entry.removeOp?.startsWith('remove:') ? entry.removeOp.slice('remove:'.length) : null;
}

/**
 * Join the summary and issues not already shown, without duplicating err.message
 *
 * @param shown Whether each issue is already displayed
 */
export function refusalText(
  err: ConfigError,
  audience: ProblemAudience,
  shown: boolean[] = [],
): string {
  return [err.summary, ...err.issues.filter((_, i) => !shown[i])]
    .map((p) => wordingFor(p, audience))
    .join(' — ');
}

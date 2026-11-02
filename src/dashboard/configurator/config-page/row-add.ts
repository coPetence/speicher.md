import { Document, isSeq } from 'yaml';

import { wordingFor } from '../../../common/config-problems';
import { ConfigError } from '../../../common/errors';
import { validateForSave } from '../../../config/loader';
import { GROUP_ADD } from '../config-form/collections';
import { parseLines, removeAt, serialise } from '../config-form/document';
import { FormBody, submitted, submittedList } from '../config-form/decode/body';

export interface RowAddProblem {
  at: 'picked' | 'matches';
  text: string;
}

export interface RowAddState {
  op: string;
  kind: string;
  picked: string[];
  matches: string;
  problems: RowAddProblem[];
}

export interface RowAdd {
  op: string;
  target: string;
  group: string;
}

const MATCH_NOUNS: Record<string, string> = {
  person: 'email address',
  domain: 'email domain',
  group: 'group id',
};

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function rowAddOf(op: unknown): RowAdd | null {
  if (typeof op !== 'string' || !op.startsWith('add:')) return null;
  const target = op.slice('add:'.length);
  const scoped = GROUP_ADD.exec(target);
  if (!scoped) return null;
  return { op, target, group: scoped[1].slice('groups.'.length) };
}

export function groupItemCount(doc: Document, name: string): number {
  const items = doc.getIn(['groups', name]);
  return isSeq(items) ? items.items.length : 0;
}

export function refusedRows(
  doc: Document,
  body: FormBody,
  add: RowAdd,
  before: number,
): RowAddState | null {
  const kind = (submitted(body, `newkind:${add.target}`) ?? '').trim();
  const picked = submittedList(body, `newname:${add.target}.${kind}`).map((each) => each.trim());
  const matches = submitted(body, `newmatches:${add.target}.${kind}`) ?? '';

  const problems = inputProblems(kind, picked, parseLines(matches));
  if (problems.length === 0) problems.push(...savedProblems(doc, add.group, before));
  if (problems.length === 0) return null;

  for (let index = groupItemCount(doc, add.group) - 1; index >= before; index--) {
    removeAt(doc, ['groups', add.group, index]);
  }
  return { op: add.op, kind, picked, matches, problems };
}

function inputProblems(kind: string, picked: string[], lines: string[]): RowAddProblem[] {
  const chosen = picked.filter((each) => each !== '');
  if (kind === 'reference') {
    return chosen.length > 0 ? [] : [{ at: 'picked', text: 'Choose at least one group.' }];
  }

  const noun = MATCH_NOUNS[kind];
  if (noun === undefined) return [];
  if (chosen.length === 0) return [{ at: 'picked', text: 'Choose a provider.' }];
  if (lines.length === 0) return [{ at: 'matches', text: `Enter at least one ${noun}.` }];
  if (kind !== 'domain') return [];
  return lines
    .filter((line) => !DOMAIN.test(line))
    .map((line) => ({
      at: 'matches',
      text: `"${line}" is not an email domain. Enter only the part after the @.`,
    }));
}

function savedProblems(doc: Document, group: string, before: number): RowAddProblem[] {
  try {
    validateForSave(serialise(doc), { requireAdministrator: false });
    return [];
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    const prefix = `groups.${group}.`;
    const problems: RowAddProblem[] = [];
    for (const issue of [err.summary, ...err.issues]) {
      const path = issue.path?.replace(/\[(\d+)\]/g, '.$1');
      if (!path?.startsWith(prefix)) continue;
      const [index, key] = path.slice(prefix.length).split('.');
      if (Number(index) < before) continue;
      const value = doc.getIn(['groups', group, Number(index), key]);
      const text =
        issue.code === 'schema.format' && key === 'email'
          ? `"${String(value)}" is not an email address.`
          : wordingFor(issue, 'dashboard');
      const at = key === 'provider' || key === 'group' ? 'picked' : 'matches';
      if (!problems.some((each) => each.text === text)) problems.push({ at, text });
    }
    return problems;
  }
}

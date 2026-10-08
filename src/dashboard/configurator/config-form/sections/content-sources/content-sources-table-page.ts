/**
 * Content sources overview page
 */

import { scalarString } from '../../document';
import type { Obj } from '../../field';
import { at } from '../../field';
import {
  FORGE_TYPES,
  SHORT_ID,
  SHORT_ID_HINT,
  forgeIds,
  forgeLabel,
  forgeMark,
  forgeType,
  freeMemberId,
  memberSectionId,
  nounOf,
} from '../../members';
import type { EntryLine, SectionEntry } from '../../model';
import type { SectionSource } from '../registry';
import { sectionHead } from '../registry';

export function sourcesSection(root: Obj): SectionSource {
  const ids = forgeIds(root);

  return {
    ...sectionHead('sources'),
    blurb:
      'A content source is a place Speicher reads documentation from, such as a GitHub App, a GitLab, Gitea or Forgejo instance, or a plain git remote.',
    fields: [],
    entries: ids.map((id) => forgeEntry(root, id)),
    layout: 'table',
    columns: ['Source', 'Default repository owner', 'Added by', 'Added'],
    searchable: true,
    searchPlaceholder: 'Name, kind or owner',
    entryNoun: nounOf('sources'),
    cards: [],
    addOps: [
      {
        op: 'add:forges',
        label: 'Add a source',
        nameLabel: 'Short id',
        namePattern: SHORT_ID.source.slice(1, -1),
        nameHint: SHORT_ID_HINT,
        typeLabel: 'Kind',
        // Forge types with suggested ids
        typeOptions: FORGE_TYPES.map((entry) => ({
          value: entry.value,
          label: entry.label,
          suggest: freeMemberId(ids, entry.value),
          mark: entry.mark,
        })),
        // Navigates to the new forge's detail page
        opensPage: true,
      },
    ],
  };
}

function defaultOwnerLines(root: Obj, id: string): EntryLine[] {
  const owner = scalarString(at(root, ['forges', id, 'default_repository_owner']));
  return owner === '' ? [] : [{ label: '', value: owner, mark: '' }];
}

function forgeEntry(root: Obj, id: string): SectionEntry {
  const type = forgeType(root, id);
  const lines = defaultOwnerLines(root, id);

  return {
    href: `/-/config/${memberSectionId('sources', id)}`,
    title: id,
    subtitle: '',
    mark: forgeMark(type),
    icon: '',
    badges:
      at(root, ['forges', id, 'primary']) === true ? [{ label: 'Primary', icon: 'star' }] : [],
    lines,
    cells: [],
    search: [id, forgeLabel(type), type, ...lines.map((line) => line.value)]
      .join(' ')
      .toLowerCase(),
    fields: [],
    carried: [],
    removeOp: `remove:forges.${id}`,
    position: -1,
  };
}

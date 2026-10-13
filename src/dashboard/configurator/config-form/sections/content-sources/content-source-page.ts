/**
 * Content source configuration page
 */

import type { Field, Obj } from '../../config-fields';
import { at, urlField } from '../../config-fields';
import { forgeMark, forgeType, memberSectionId, nounOf } from '../../members';
import type { Card } from '../../model';
import type { SectionSource } from '../registry';
import { urlCard } from './content-source-urls-card';
import { fetchingCard } from './git-fetching-card';
import { repoCard } from './git-repository-card';
import { securityCard } from './git-security-card';
import { appCard } from './github-app-card';

function forgeBlurb(type: string): string {
  if (type === 'git') {
    return 'A plain git remote is any Git repository Speicher can clone over SSH or HTTPS. Add each repository below.';
  }
  if (type === 'github') {
    // TODO: the linked page does not exist yet; replace the placeholder once it is written
    return 'Before you can fill in this page, you need to ==create a GitHub App==. To find out how to create it and which Webhook URL to enter, read [Creating a GitHub App](https://docs.speicher.md/placeholder/github-app).';
  }
  return 'Speicher cannot read from this kind of source yet. To use its repositories now, add them as a plain git remote instead.';
}

export function forgeSection(root: Obj, id: string): SectionSource {
  const base = ['forges', id];
  const type = forgeType(root, id);
  const p = (key: string) => `forges.<key>.${key}`;

  // Advanced fields may not sit in a card, so the base URL stays on the section
  const fields: Field[] = [
    urlField(root, [...base, 'base_url'], p('base_url'), 'Base URL', {
      placeholder: 'https://github.example.com',
      help: 'The base URL is the address of your own GitHub Enterprise Server, for example `https://github.example.com`. Leave it empty if you use GitHub.com.',
      advanced: true,
    }),
  ];

  const repos = (at(root, [...base, 'repos']) as unknown[]) ?? [];
  const cards: Card[] =
    type === 'git'
      ? [
          ...repos.map((_, index) => repoCard(root, id, index)),
          urlCard(root, id),
          fetchingCard(root, id),
          securityCard(root, id),
        ]
      : [appCard(root, id), urlCard(root, id)];

  return {
    id: memberSectionId('sources', id),
    title: id,
    parent: 'sources',
    mark: forgeMark(type),
    blurb: forgeBlurb(type),
    fields,
    entries: [],
    cards,
    addOps:
      type === 'git'
        ? [
            {
              op: `add:forges.${id}.repos`,
              label: 'Add a repository',
              // After the last repository, before the Simpler URLs card
              beforeCard: repos.length,
              nameLabel: null,
              namePattern: null,
              nameHint: null,
              typeLabel: null,
              typeOptions: [],
            },
          ]
        : [],
    removeOp: `remove:forges.${id}`,
    noun: nounOf('sources'),
  };
}

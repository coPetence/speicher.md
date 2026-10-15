/**
 * Content source configuration page
 */

import type { Field, Obj } from '../../config-fields';
import { at, choiceName, urlField } from '../../config-fields';
import { forgeMark, forgeType, memberSectionId, nounOf } from '../../members';
import type { Card } from '../../model';
import type { SectionSource } from '../registry';
import { urlCard } from './content-source-urls-card';
import { fetchingCard } from './git-fetching-card';
import { repoCard } from './git-repository-card';
import { securityCard } from './git-security-card';
import { appCard, appSetupName, hasGithubApp } from './github-app-card';

function forgeBlurb(type: string): string {
  if (type === 'git') {
    return 'A plain git remote is any Git repository Speicher can clone over SSH or HTTPS. Add each repository below.';
  }
  if (type === 'github') {
    // TODO: the linked page does not exist yet; replace the placeholder once it is written
    return 'A GitHub source reads its repositories through a GitHub App. Speicher can create the App on GitHub for you. To find out how to create the App yourself and which Webhook URL to enter, read [Creating a GitHub App](https://docs.speicher.md/placeholder/github-app).';
  }
  return 'Speicher cannot read from this kind of source yet. To use its repositories now, add them as a plain git remote instead.';
}

/**
 * githubUrlCard builds the Simpler URLs card of a GitHub source. Until the source has an App, the card is shown only while the App's details are entered manually, since creating the App on GitHub takes the person away from this page.
 *
 * @param root the configuration document
 * @param id the forge's key
 */
function githubUrlCard(root: Obj, id: string): Card {
  const card = urlCard(root, id);
  if (hasGithubApp(root, id)) return card;
  // The choice opens on Create on GitHub
  return { ...card, shownWith: choiceName(appSetupName(id)), shownWhen: 'manual', hidden: true };
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
      : [appCard(root, id), githubUrlCard(root, id)];

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

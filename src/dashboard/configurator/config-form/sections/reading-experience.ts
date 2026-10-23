import type { Obj } from '../config-fields';
import { booleanField, numberField } from '../config-fields';
import type { Card } from '../model';
import type { SectionSource } from './registry';
import { sectionHead } from './registry';

export function readingSection(root: Obj): SectionSource {
  return {
    ...sectionHead('reading'),
    blurb:
      'When Speicher ingests a repository, it records which pages link to each other and which tags each page has. This link graph powers the reading features below. Switching a feature off hides it for readers right away, without a new ingest. Find out more in our [documentation](https://docs.speicher.md/configuration/reading-experience)',
    fields: [
      booleanField(root, ['graph', 'enabled'], 'graph.enabled', 'Link graph', {
        fallback: true,
        help: 'The link graph switch turns all of the features below on or off at once.',
      }),
    ],
    cards: [relatedCard(root), previewsCard(root), tagsCard(root), searchCard(root)],
    cardGrid: true,
    addOps: [],
  };
}

function featureCard(root: Obj, key: string, title: string, subtitle: string): Card {
  return {
    title,
    subtitle,
    enabledWith: 'graph.enabled',
    toggle: `graph.${key}`,
    removeOp: null,
    notes: [],
    cards: [],
    addOps: [],
    items: [booleanField(root, ['graph', key], `graph.${key}`, title, { fallback: true })],
  };
}

function relatedCard(root: Obj): Card {
  const card = featureCard(
    root,
    'related',
    'Related column',
    'Shows a column beside each article that lists the pages it links to and the pages that link to it.',
  );
  card.items.push(
    numberField(root, ['graph', 'related_limit'], 'graph.related_limit', 'Entries per list', {
      fallback: 8,
      shownWith: 'graph.related',
      help: 'The number of entries sets how many pages each list in the related column shows. Further pages are left out.',
    }),
  );
  return card;
}

function previewsCard(root: Obj): Card {
  return featureCard(
    root,
    'previews',
    'Hover previews',
    'Shows the title and summary of the target page when a reader hovers over a link.',
  );
}

function tagsCard(root: Obj): Card {
  return featureCard(
    root,
    'terms',
    'Tags',
    "Shows the tags from a page's frontmatter as chips. Selecting a tag lists every page with that tag.",
  );
}

function searchCard(root: Obj): Card {
  return featureCard(
    root,
    'search_boost',
    'Link-weighted search',
    'Ranks a search result higher when other results link to it.',
  );
}

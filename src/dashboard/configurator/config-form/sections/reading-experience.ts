import type { Obj } from '../config-fields';
import { booleanField, numberField } from '../config-fields';
import type { Card } from '../model';
import type { SectionSource } from './registry';
import { sectionHead } from './registry';

export function readingSection(root: Obj): SectionSource {
  return {
    ...sectionHead('reading'),
    blurb:
      'The link graph is a feature, that enables the following features at the cost of higher ingest time: hovering over a link shows the target, backlinks are shown in the sidebar and lists related files to this document',
    fields: [
      booleanField(root, ['graph', 'enabled'], 'graph.enabled', 'Link graph', {
        fallback: true,
        help: 'Toggles the link graph feature. Action is immediate and does not require reingestion',
      }),
    ],
    cards: [relatedCard(root), marksCard(root), searchCard(root)],
    addOps: [],
  };
}

function relatedCard(root: Obj): Card {
  return {
    title: 'Related column',
    shownWith: 'graph.enabled',
    subtitle: 'Shows a sidebar showing what the document links to and its backlinks',
    removeOp: null,
    notes: [],
    cards: [],
    addOps: [],
    items: [
      booleanField(root, ['graph', 'related'], 'graph.related', 'Related column', {
        fallback: true,
      }),
      numberField(
        root,
        ['graph', 'related_limit'],
        'graph.related_limit',
        'Related entries shown',
        {
          fallback: 8,
          shownWith: 'graph.related',
          help: 'Most entries shown per direction (forward & backward links); overflow is silent',
        },
      ),
    ],
  };
}

function marksCard(root: Obj): Card {
  return {
    title: 'Links and tags',
    shownWith: 'graph.enabled',
    subtitle: 'What the graph adds inside the article itself.',
    removeOp: null,
    notes: [],
    cards: [],
    addOps: [],
    items: [
      booleanField(root, ['graph', 'previews'], 'graph.previews', 'Hover previews', {
        fallback: true,
        help: 'Shows the link destination',
      }),
      booleanField(root, ['graph', 'terms'], 'graph.terms', 'Tags', {
        fallback: true,
        help: "Shows each page's frontmatter tags as chips, and lists every readable page that has one.",
      }),
    ],
  };
}

function searchCard(root: Obj): Card {
  return {
    title: 'Search ranking',
    shownWith: 'graph.enabled',
    subtitle: 'Returns weighted search results.',
    removeOp: null,
    notes: [],
    cards: [],
    addOps: [],
    items: [
      booleanField(root, ['graph', 'search_boost'], 'graph.search_boost', 'Link-weighted search', {
        fallback: true,
        help: 'Ranks results higher when other results link to them.',
      }),
    ],
  };
}

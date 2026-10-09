/**
 * Reading experience, read analytics, public access, repository defaults
 *
 * Four small sections with nothing to share but a document. Analytics is the one
 * with an argument in it: reads are counted and readers are not recorded, so the
 * cardinality is stored and the members are not, and hourly buckets are not
 * defaulted because an hourly series is a work-pattern record
 */

import { scalarString } from '../document';
import {
  at,
  booleanField,
  linesField,
  numberField,
  selectField,
  textField,
} from '../config-fields';
import type { Obj } from '../config-fields';
import type { Card, Option } from '../model';
import { sectionHead } from './registry';
import type { SectionSource } from './registry';

/*
  The master switch, then one card per surface the graph feeds.

  The six settings are one block and were drawn as one list of six, which read as
  six unrelated toggles — and put `related_limit` under `terms`, two columns away
  from the switch it is the limit *of*. The cards are the schema's own sentence:
  the aside beside an article, the marks inside it, and the ranking of a result
  set. Grouping only — every path is the one it was, so nothing here changes what
  is stored.

  `enabled` stays the section's own field rather than taking a card, because it is
  the question the cards are answers to: false removes every surface below it
  whatever each is set to. So each card is `shownWith` the master: with the graph
  off, three cards of switches read as three things this instance is doing, and it
  is doing none of them. Folded, not removed — the controls still submit, so turning
  the graph back on finds every answer where it was left.
*/
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

function timeZoneOptions(stored: unknown): Option[] {
  const options: Option[] = [{ value: 'UTC', label: 'UTC' }];
  for (const zone of Intl.supportedValuesOf('timeZone')) {
    options.push({ value: zone, label: zone });
  }
  const value = scalarString(stored);
  if (value !== '' && !options.some((option) => option.value === value)) {
    options.push({ value, label: `${value} — not a zone this runtime knows` });
  }
  return options;
}

export function analyticsSection(root: Obj): SectionSource {
  return {
    ...sectionHead('analytics'),
    blurb:
      'Count how often each page is read, without recording who read what. Find out more in our [documentation](https://docs.speicher.md/operate/read-analytics)',
    fields: [
      booleanField(root, ['analytics', 'enabled'], 'analytics.enabled', 'Count total reads', {
        fallback: false,
        help: 'Off by default. Turning it off again deletes what has been collected.',
      }),
      booleanField(
        root,
        ['analytics', 'unique_readers'],
        'analytics.unique_readers',
        'Count unique readers',
        {
          fallback: true,
          shownWith: 'analytics.enabled',
          help:
            'Estimate how many different signed-in people read each page, so that ' +
            '"twelve of forty opened it" is answerable. Stored as a statistical ' +
            'sketch that holds a count and no identities — it cannot be turned back ' +
            'into who. Readers who are not signed in never contribute.',
        },
      ),
      booleanField(
        root,
        ['analytics', 'public_beacon'],
        'analytics.public_beacon',
        'Count public pages in the browser',
        {
          fallback: true,
          shownWith: 'analytics.enabled',
          help:
            'A public page may be served from a cache without reaching this instance, ' +
            'so counting it here alone undercounts — behind a CDN, severely. With this ' +
            'on, public pages send a one-line message from the browser instead, ' +
            'carrying the page address and nothing else: no cookie, no identifier, ' +
            'nothing kept between visits. Private pages are always counted on the ' +
            'server and are unaffected.',
        },
      ),
      selectField(root, ['analytics', 'timezone'], 'analytics.timezone', 'Time zone', {
        fallback: 'UTC',
        options: timeZoneOptions(at(root, ['analytics', 'timezone'])),
        startsRow: true,
        help: "Decides the timezone to log in. A reader's access time, coming from another timezone, gets converted to the here specified timezone",
      }),
      selectField(root, ['analytics', 'granularity'], 'analytics.granularity', 'Detail', {
        fallback: 'day',
        options: [
          { value: 'day', label: 'Per day' },
          { value: 'hour', label: 'Per hour' },
        ],
        help: "Per day is set to default to comply with privacy for working hours, specified by §87(1)(6) BetrVG in Germany. Changing setting 'per hour' -> 'per day' deletes hourly detail",
      }),
      numberField(
        root,
        ['analytics', 'retention_days'],
        'analytics.retention_days',
        'Keep counts for (days)',
        {
          fallback: 90,
        },
      ),
      numberField(
        root,
        ['analytics', 'search_retention_days'],
        'analytics.search_retention_days',
        'Keep unsuccessful searches for (days)',
        {
          fallback: 30,
          help:
            'Searches that returned nothing are recorded so you can see what readers ' +
            'expected to find. This is the one place a reader\u2019s own words are ' +
            'stored, so it has its own shorter window.',
        },
      ),
    ],
    cards: [],
    addOps: [],
  };
}

export function publicSection(root: Obj): SectionSource {
  return {
    ...sectionHead('public'),
    blurb:
      'You can allow repositories to publish content to anonymous (public) readers. Adding a repository here does not publish the content, it just allows the repo to use the `public` grant in its `.speicher.yaml` files. Find out more in our [documentation](TODO:INSERT_DOCS_LINK)',
    fields: [
      linesField(root, ['public', 'repos'], 'public.repos', 'Public repositories', {
        help:
          'One `namespace/slug` per line, spelled the way the reader\u2019s URL spells it — ' +
          'for example `copetence/speicher-docs`. Renaming a repository unpublishes it ' +
          'until this list is updated.',
        rows: 4,
      }),
    ],
    cards: [],
    addOps: [],
  };
}

export function retrievalSection(root: Obj): SectionSource {
  return {
    ...sectionHead('defaults'),
    blurb:
      'Specifies what is being included and excluded from the repository. Check out the documentation for a deeper understanding [link]',
    fields: [
      linesField(root, ['defaults', 'sync', 'include'], 'defaults.sync.include', 'Include', {
        help: 'Globs, one per line. Defaults to every Markdown file.',
        rows: 4,
      }),
      linesField(root, ['defaults', 'sync', 'exclude'], 'defaults.sync.exclude', 'Exclude', {
        help: 'Globs, one per line. Defaults to every Markdown file.',
        rows: 4,
      }),
      textField(
        root,
        ['defaults', 'display', 'cover'],
        'defaults.display.cover',
        'Default cover image',
        {
          help: 'Cover image to be shown at the top of an article and on listing pages for folders or repositories. Can overwritten per folder. No SVGs allowed for security reasons.',
        },
      ),
      booleanField(
        root,
        ['defaults', 'retrieval', 'indexable'],
        'defaults.retrieval.indexable',
        'Indexable by default',
        {
          fallback: true,
          help: 'Whether pages are returned by search and accessible through MCP',
        },
      ),
    ],
    cards: [],
    addOps: [],
  };
}

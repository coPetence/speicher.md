import type { Obj } from '../config-fields';
import { at, booleanField, numberField, selectField } from '../config-fields';
import { scalarString } from '../document';
import type { Option } from '../model';
import type { SectionSource } from './registry';
import { sectionHead } from './registry';

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
            'expected to find. This is the one place a reader’s own words are ' +
            'stored, so it has its own shorter window.',
        },
      ),
    ],
    cards: [],
    addOps: [],
  };
}

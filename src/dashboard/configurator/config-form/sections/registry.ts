/**
 * Which sections exist
 *
 * `CONFIG_SECTIONS` is the one list, and the route 404s an id that is not in it.
 * `parent` separates a member page (one per entry, unnameable in advance) from a
 * fixed child, which must be nameable or a known page 404s when the config does
 * not parse
 *
 * Every section builder starts from `sectionHead`, so this module is what they
 * all import and it deliberately depends on nothing but the vocabulary — that is
 * what lets `index.ts` import every builder without a cycle
 */

import type { FormSection, SectionEntry, SectionIndexEntry } from '../model';

export const CONFIG_SECTIONS: SectionIndexEntry[] = [
  { id: 'identity', title: 'Identity Providers', icon: 'key-round' },
  // Group-based access: internal groups and their sources
  { id: 'groups', title: 'Groups', icon: 'users' },
  { id: 'admins', title: 'Administrators', icon: 'shield' },
  // Public access to selected repositories
  { id: 'public', title: 'Public access', icon: 'globe' },
  { id: 'sources', title: 'Content sources', icon: 'folder-git-2' },
  { id: 'branding', title: 'Branding', icon: 'paintbrush' },
  // Colour palette and typeface overrides
  { id: 'branding/appearance', title: 'Colours and type', icon: 'palette', parent: 'branding' },
  { id: 'reading', title: 'Reading experience', icon: 'book-open' },
  // Page-view counting without recording who
  { id: 'analytics', title: 'Read analytics', icon: 'chart-line' },
  { id: 'defaults', title: 'Repository defaults', icon: 'sliders-horizontal' },
  // The SMTP relay this instance sends through
  { id: 'mail', title: 'Mail transport', icon: 'send' },
  // Who is told what, over that relay
  { id: 'notifications', title: 'Notifications', icon: 'bell' },
  { id: 'storage', title: 'Asset storage', icon: 'hard-drive' },
  { id: 'embedding', title: 'Semantic retrieval', icon: 'sparkles' },
];

export const CONFIG_NAV_SECTIONS: SectionIndexEntry[] = CONFIG_SECTIONS.filter(
  (section) => section.parent === undefined,
);

export function isConfigSection(id: string): boolean {
  return CONFIG_SECTIONS.some((section) => section.id === id && section.parent === undefined);
}

export function isConfigSubsection(id: string): boolean {
  return CONFIG_SECTIONS.some((section) => section.id === id && section.parent !== undefined);
}

export function sectionHead(id: string): Pick<FormSection, 'id' | 'title' | 'parent' | 'entries'> {
  const entry = CONFIG_SECTIONS.find((section) => section.id === id);
  // Every section id must have a corresponding index entry
  if (!entry) throw new Error(`no entry in CONFIG_SECTIONS for "${id}"`);

  return {
    id: entry.id,
    title: entry.title,
    parent: entry.parent ?? null,
    entries: [],
  };
}

export type SectionSource = Omit<FormSection, 'blurbHtml'>;

// The blurb is passed in rather than looked up: it is read twice — as this tile's
// subtitle and as the blurb on the page itself — and both readers are the section
// file that owns the pair, which is where the prose belongs
export function subsectionEntry(id: string, blurb: string): SectionEntry {
  const entry = CONFIG_SECTIONS.find((section) => section.id === id);
  // Every subsection must have a corresponding navigation index entry
  if (!entry) throw new Error(`no entry in CONFIG_SECTIONS for "${id}"`);
  return {
    href: `/-/config/${entry.id}`,
    title: entry.title,
    subtitle: blurb,
    mark: '',
    icon: entry.icon,
    badges: [],
    lines: [],
    cells: [],
    search: `${entry.title} ${blurb}`.toLowerCase(),
    fields: [],
    carried: [],
    removeOp: null,
    position: -1,
  };
}

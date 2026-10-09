/**
 * Admin search index and search function
 *
 * Indexes admin pages, config sections, settings fields, and member entries
 * SEARCH_KEYWORDS provides synonym phrases matched against query terms
 * SEARCHABLE_VALUES controls which field values appear in search body
 * Both tables live in `search-keywords.ts`
 *
 * Ranking: name match (0), name+keywords (1), name+keywords+body (2)
 * Results capped at MAX_HITS, sorted by rank then kind order then title
 */
import {
  DashboardNavOptions,
  DASHBOARD_SECTIONS,
  dashboardSectionTitle,
  visibleDashboardSections,
} from '../dashboard-sections';
import { CONFIG_SECTIONS } from '../configurator/config-form/fields';
import type { Field } from '../configurator/config-form/config-fields';
import { FormSection, SectionEntry, allFields } from '../configurator/config-form/model';
import { SEARCHABLE_VALUES, SEARCH_KEYWORDS } from './search-keywords';

/** A searchable item type */
export type DashboardHitKind = 'page' | 'setting' | 'member';

/** Display ordering of hit kinds in search results */
const KIND_ORDER: DashboardHitKind[] = ['page', 'setting', 'member'];

/** A search result for the admin search box */
export interface DashboardHit {
  /** Hit type */
  kind: DashboardHitKind;
  /** Display title */
  title: string;
  /** Breadcrumb parent context */
  context: string;
  /** Link to the page or setting */
  href: string;
  /** Descriptive text shown alongside the title */
  help: string;
  /** Icon identifier */
  icon: string;
}

/** Set of SEARCHABLE_VALUES for O(1) lookup */
const SEARCHABLE = new Set(SEARCHABLE_VALUES);

/** Internal search index row */
interface Indexed {
  hit: DashboardHit;
  /** Deduplication key */
  key: string;
  /** Normalized title and context */
  name: string;
  /** Normalized keyword synonyms */
  words: string;
  /** Normalized body content (help text, paths, values) */
  body: string;
}

/** Lowercase, join, and collapse whitespace */
function fold(...parts: string[]): string {
  return parts.join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Build the full search index from nav pages, config sections,
 * and form sections
 */
export function dashboardIndex(
  sections: FormSection[] | null,
  options: DashboardNavOptions,
): Indexed[] {
  const rows: Indexed[] = [];

  // Index admin nav pages (Sync status, Logs, etc.); a page filed under a section
  // names it as context, the way a settings page names Configuration
  for (const section of visibleDashboardSections(null, true, options)) {
    rows.push({
      key: section.href,
      hit: {
        kind: 'page',
        title: section.label,
        context: section.parent ? dashboardSectionTitle(section.parent) : '',
        href: section.href,
        help: '',
        icon: section.icon,
      },
      name: fold(section.label),
      words: fold(SEARCH_KEYWORDS[`page:${section.id}`] ?? ''),
      body: fold(section.href),
    });
  }

  // Index config section pages (Identity, Groups, etc.)
  const configLabel = DASHBOARD_SECTIONS.find((section) => section.id === 'config')?.label ?? '';
  for (const entry of CONFIG_SECTIONS) {
    const parent = entry.parent
      ? (CONFIG_SECTIONS.find((section) => section.id === entry.parent)?.title ?? '')
      : '';
    const context = [configLabel, parent].filter(Boolean).join(' › ');
    rows.push({
      key: `/-/config/${entry.id}`,
      hit: {
        kind: 'page',
        title: entry.title,
        context,
        href: `/-/config/${entry.id}`,
        help: sections?.find((section) => section.id === entry.id)?.blurb ?? '',
        icon: entry.icon,
      },
      name: fold(entry.title, context),
      words: fold(SEARCH_KEYWORDS[`section:${entry.id}`] ?? ''),

      body: fold(sections?.find((section) => section.id === entry.id)?.blurb ?? '', entry.id),
    });
  }

  // No config loaded, return only nav and section pages
  if (!sections) return rows;

  // Index fields and member entries per section
  for (const section of sections) {
    const context = trailOf(sections, section.id).join(' › ');

    for (const field of allFields([section])) {
      // Skip fields disabled by their conditions
      if (field.inapplicable) continue;
      rows.push(fieldRow(field, section, context));
    }

    for (const entry of section.entries) {
      rows.push(memberRow(entry, section, context));
    }
  }

  return dedupe(rows);
}

/** Index a form field as a setting hit */
function fieldRow(field: Field, section: FormSection, context: string): Indexed {
  const value = SEARCHABLE.has(field.schemaPath) && 'value' in field ? field.value : '';
  return {
    // Value in key differentiates repeated fields (e.g. multiple repos)
    key: `${`/-/config/${section.id}`}|${field.label}|${value}`,
    hit: {
      kind: 'setting',
      title: field.label,
      context,
      href: `/-/config/${section.id}#f-${field.path}`,
      help: field.help,
      icon: iconOf(section),
    },
    name: fold(field.label, context),
    words: fold(SEARCH_KEYWORDS[`field:${field.schemaPath}`] ?? ''),
    // Body includes help text and all path variants for deep search
    body: fold(field.help, field.path, field.schemaPath, value),
  };
}

/** Index a section entry as a member hit */
function memberRow(entry: SectionEntry, section: FormSection, context: string): Indexed {
  return {
    key: entry.href,
    hit: {
      kind: 'member',
      title: entry.title,
      context,
      href: entry.href,
      help: entry.subtitle,
      icon: entry.icon,
    },
    name: fold(entry.title, section.title),
    // entry.search is pre-formatted comma-separated keywords from the schema
    words: entry.search,
    body: fold(entry.subtitle, ...entry.badges.map((badge) => badge.label)),
  };
}

/** Resolve icon from CONFIG_SECTIONS by id or root segment */
function iconOf(section: FormSection): string {
  const root = section.id.split('/')[0];
  return (
    CONFIG_SECTIONS.find((entry) => entry.id === section.id)?.icon ??
    CONFIG_SECTIONS.find((entry) => entry.id === root)?.icon ??
    ''
  );
}

/** Breadcrumb trail for a config section through its hierarchy */
function trailOf(sections: FormSection[], id: string): string[] {
  const trail: string[] = [
    DASHBOARD_SECTIONS.find((section) => section.id === 'config')?.label ?? '',
  ];
  const segments = id.split('/');
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const at = segments.slice(0, depth).join('/');
    const title =
      CONFIG_SECTIONS.find((entry) => entry.id === at)?.title ??
      sections.find((section) => section.id === at)?.title ??
      segments[depth - 1];
    trail.push(title);
  }
  return trail.filter(Boolean);
}

/** Filter out rows with duplicate keys */
function dedupe(rows: Indexed[]): Indexed[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.key)) return false;
    seen.add(row.key);
    return true;
  });
}

/** Max search results returned */
export const MAX_HITS = 40;

/** Search response */
export interface DashboardSearchResult {
  hits: DashboardHit[];
  /** Count of all matches before capping */
  total: number;
}

/**
 * Search admin pages, settings, and members matching query terms
 */
export function searchDashboard(
  query: string,
  sections: FormSection[] | null,
  options: DashboardNavOptions,
): DashboardSearchResult {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { hits: [], total: 0 };

  const matched = dashboardIndex(sections, options)
    .map((row) => ({ row, rank: rankOf(row, terms) }))
    // Filter out non-matches, narrowing to scored rows
    .filter((scored): scored is { row: Indexed; rank: number } => scored.rank !== null)
    // Sort by rank, then kind order, then title alphabetically
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        KIND_ORDER.indexOf(a.row.hit.kind) - KIND_ORDER.indexOf(b.row.hit.kind) ||
        a.row.hit.title.localeCompare(b.row.hit.title),
    );

  return {
    hits: matched.slice(0, MAX_HITS).map((scored) => scored.row.hit),
    total: matched.length,
  };
}

/**
 * Score a row against query terms, null if no term matches any field
 *
 * 0: all terms in name; 1: all terms in name or keywords; 2: all terms
 * anywhere in the row; null: no match
 */
function rankOf(row: Indexed, terms: string[]): number | null {
  const all = (haystack: string) => terms.every((term) => haystack.includes(term));
  if (all(row.name)) return 0;
  if (all(`${row.name} ${row.words}`)) return 1;
  if (all(`${row.name} ${row.words} ${row.body}`)) return 2;
  return null;
}

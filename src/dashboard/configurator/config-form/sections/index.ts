/**
 * Every section, built from one document
 *
 * The order here is the order the left column draws, and a member collection
 * contributes one section per entry — so this list is the only place that knows
 * a provider, a group, an administrator or a content source has a page each
 *
 * Each builder lives in its own file and reaches only `registry.ts`, so nothing
 * imports back into here
 */

import { Document } from 'yaml';

import { at } from '../config-fields';
import type { Obj } from '../config-fields';
import type { FormSection } from '../model';
import { forgeIds, groupNames, providerIds, type KindHint } from '../members';

import { adminUserSection, adminsSection } from './admins';
import { appearanceSection, brandingSection, logosSection } from './branding';
import { groupSection } from './groups/group';
import { groupsSection } from './groups/list';
import { identitySection, providerSection } from './identity';
import { mailSection } from './mail';
import { notificationsSection } from './notifications';
import { publicSection } from './public-access';
import { analyticsSection } from './read-analytics';
import { readingSection } from './reading-experience';
import { repositoryDefaultsSection } from './repository-defaults';
import { forgeSection } from './content-sources/content-source-page';
import { sourcesSection } from './content-sources/content-sources-table-page';
import { embeddingSection, storageSection } from './storage';

export function buildSections(doc: Document, hint?: KindHint): FormSection[] {
  const root = doc.toJS({ maxAliasCount: 0 }) as Obj;
  return [
    identitySection(root),
    // One section per provider
    ...providerIds(root).map((id) => providerSection(root, id, hint)),
    groupsSection(root),
    // One section per group: its rows are on that one page
    ...groupNames(root).map((name) => groupSection(root, name)),
    sourcesSection(root),
    // One section per forge
    ...forgeIds(root).map((id) => forgeSection(root, id)),
    publicSection(root),
    brandingSection(root),
    logosSection(root),
    appearanceSection(root),
    adminsSection(root),
    ...((at(root, ['admins', 'users']) as unknown[]) ?? []).map((_, index) =>
      adminUserSection(root, index),
    ),
    storageSection(root),
    mailSection(root),
    repositoryDefaultsSection(root),
    readingSection(root),
    analyticsSection(root),
    notificationsSection(root),
    embeddingSection(root),
  ].map((section) => ({
    ...section,
    // A page index's tiles carry the blurb of the page each one opens — the same
    // prose, read twice — so it is formatted exactly as the blurb above it is.
    // `entriesArePages` is the one field that says which kind of tile a section
    // draws, and it decides the subtitle's face for the same reason it decides the
    // title's: a member's subtitle is a value, and a value is shown as it is
    entries: section.entriesArePages
      ? section.entries.map((entry) => ({ ...entry, subtitleIsProse: true }))
      : section.entries,
  }));
}

/** One section of the form, built from the document as it currently stands. */
export function sectionOf(
  doc: Document,
  sectionId: string,
  hint?: KindHint,
): FormSection | undefined {
  return buildSections(doc, hint).find((section) => section.id === sectionId);
}

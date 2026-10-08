/**
 * The configuration sections the nav column opens Set up into during the first run
 */
import { CONFIG_SECTIONS } from '../configurator/config-form/fields';
import type { SectionIndexEntry } from '../configurator/config-form/model';

const SETUP_SECTION_IDS = ['identity', 'sources', 'groups'] as const;

// The mail transport section, prepended when a relay is involved
export const MAIL_SECTION_ID = 'mail';

/** returns the ids of the sections that are shown in the setup navigation */
export function setupNavSections(showMailTransport: boolean): SectionIndexEntry[] {
  const ids = showMailTransport ? [MAIL_SECTION_ID, ...SETUP_SECTION_IDS] : [...SETUP_SECTION_IDS];
  return ids.map((id) => {
    const entry = CONFIG_SECTIONS.find((section) => section.id === id);
    if (!entry) throw new Error(`Entry with id ${id} in the setup navigation not found`);
    return entry;
  });
}

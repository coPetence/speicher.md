/**
 * The pages the nav column opens Set up into during the first run, in the order of the steps
 */
import { CONFIG_SECTIONS } from '../configurator/config-form/fields';
import { REPOSITORY_STEP_PATH } from './steps';

// The mail transport section, prepended when a relay is involved
export const MAIL_SECTION_ID = 'mail';

export const ADMINISTRATOR_SECTION_ID = 'administrator';
export const ADMINISTRATOR_HREF = '/-/setup/administrator';

export const REPOSITORY_SECTION_ID = 'repository';

export interface SetupNavEntry {
  id: string;
  href: string;
  title: string;
  icon: string;
  config: boolean;
}

/** returns the pages that are shown in the setup navigation */
export function setupNavSections(showMailTransport: boolean): SetupNavEntry[] {
  const section = (id: string): SetupNavEntry => {
    const entry = CONFIG_SECTIONS.find((each) => each.id === id);
    if (!entry) throw new Error(`Entry with id ${id} in the setup navigation not found`);
    return { id, href: `/-/config/${id}`, title: entry.title, icon: entry.icon, config: true };
  };
  return [
    ...(showMailTransport ? [section(MAIL_SECTION_ID)] : []),
    section('identity'),
    {
      id: ADMINISTRATOR_SECTION_ID,
      href: ADMINISTRATOR_HREF,
      title: 'Administrator',
      icon: 'user-check',
      config: false,
    },
    section('groups'),
    section('sources'),
    {
      id: REPOSITORY_SECTION_ID,
      href: REPOSITORY_STEP_PATH,
      title: 'Repositories',
      icon: 'book-marked',
      config: false,
    },
  ];
}

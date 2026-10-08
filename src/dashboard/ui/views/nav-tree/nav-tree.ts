/**
 * The dashboard's left column: the search box over a tree of the sections a
 * caller may see, opening Configuration (or Set up, during the first run) into
 * its sub-sections, and a section into the pages filed under it
 *
 * Icons returned beside the html are exactly the ones rendered, so the column and
 * the setup progress rail feed one shared svg sprite
 */
import {
  DashboardNavOptions,
  DashboardSection,
  dashboardBranchOf,
  visibleDashboardSections,
} from '../../../dashboard-sections';
import { CONFIG_NAV_SECTIONS } from '../../../configurator/config-form/fields';
import { MAIL_SECTION_ID, setupNavSections } from '../../../setup/setup-sections';
import { renderIconRef, renderInlineIcon } from '../../../../content-reader/icons';
import { renderTemplate } from '../../../../content-reader/views';

/** One link in the column; `current` is `page` on the page shown, `true` on its open parent */
interface NavLink {
  href: string;
  label: string;
  iconHtml: string;
  current: 'page' | 'true' | null;
}

/** A top-level entry, with the sub-sections it opens into when it is a branch */
interface NavItem extends NavLink {
  id: DashboardSection; // Names the branch in the folds cookie
  children: NavLink[] | null;
  open: boolean; // Drawn open: holds the page shown, is the first run, or was left open
}

/**
 * Left nav html for the current section, plus the exact icons it rendered
 *
 * `searchQuery` draws the search box above the sections, holding that text;
 * leaving it out draws no box
 */
export function dashboardNav(
  currentDashboardView: DashboardSection,
  isAdmin: boolean,
  options: DashboardNavOptions & {
    searchQuery?: string;
    openFolds?: ReadonlySet<DashboardSection>; // Branches the reader left open
  } = {},
): { html: string; icons: string[] } {
  const {
    subsection,
    showSetup = false,
    showMailTransport = false,
    searchQuery,
    openFolds = new Set(),
  } = options;
  const icons: string[] = [];

  const link = (href: string, label: string, icon: string, state: NavLink['current']): NavLink => {
    icons.push(icon);
    return { href, label, iconHtml: renderIconRef(icon), current: state };
  };

  const visible = visibleDashboardSections(currentDashboardView, isAdmin, options);
  // Pages filed under a section are drawn as its leaves, never as peers
  const items: NavItem[] = visible
    .filter((section) => section.parent === undefined)
    .map((section): NavItem => {
      // The section's row, marked as the page when it is current
      const row = {
        id: section.id,
        ...link(
          section.href,
          section.label,
          section.icon,
          section.id === currentDashboardView && subsection === undefined ? 'page' : null,
        ),
      };

      // Set up opens into the steps of the first run, then the full settings index
      if (section.id === 'setup' && showSetup) {
        return {
          ...row,
          // While the flow is unfinished the column *is* the flow, so it never folds shut
          open: true,
          children: [
            ...setupNavSections(showMailTransport || subsection === MAIL_SECTION_ID).map((entry) =>
              link(
                `/-/config/${entry.id}`,
                entry.title,
                entry.icon,
                entry.id === subsection ? 'page' : null,
              ),
            ),
            link(
              '/-/config',
              'All settings',
              'settings',
              currentDashboardView === 'config' && subsection === undefined ? 'page' : null,
            ),
          ],
        };
      }

      // Configuration folds its sections away, open while one of its pages is shown
      if (section.id === 'config') {
        return {
          ...row,
          open: currentDashboardView === 'config' || openFolds.has(section.id),
          children: CONFIG_NAV_SECTIONS.map((entry) => {
            // A sub-path marks the parent as an open branch, not the page
            const nested = subsection?.startsWith(`${entry.id}/`) ?? false;
            return link(
              `/-/config/${entry.id}`,
              entry.title,
              entry.icon,
              entry.id === subsection ? 'page' : nested ? 'true' : null,
            );
          }),
        };
      }

      // A section folds the pages under it away, open while the caller is on one of
      // them, which is the tree's own collapse rule: the ancestors of the page are open.
      // A branch the reader left open stays open; the page's own is never folded away
      const leaves = visible.filter((leaf) => leaf.parent === section.id);
      if (leaves.length > 0) {
        return {
          ...row,
          open: dashboardBranchOf(currentDashboardView) === section.id || openFolds.has(section.id),
          children: leaves.map((leaf) =>
            link(
              leaf.href,
              leaf.label,
              leaf.icon,
              leaf.id === currentDashboardView ? 'page' : null,
            ),
          ),
        };
      }

      return { ...row, open: false, children: null };
    });

  const html = renderTemplate('dashboard/ui/views/nav-tree', {
    searchQuery: searchQuery ?? null,
    searchIcon: searchQuery === undefined ? '' : renderInlineIcon('search', 'spr-icon'),
    items,
  });
  return { html, icons };
}

/**
 * The dashboard's pages, and which of them a caller sees
 *
 * The nav column draws this list, and the admin search offers results from it, so a
 * page hidden from the column is never offered by search either. Chrome, not
 * access: every route answers the same whether or not its entry is shown.
 */
export type DashboardSection =
  // The /-/ route id of each top-level page
  | 'search'
  | 'status'
  | 'explain'
  | 'graph'
  | 'analytics'
  | 'logs'
  | 'config'
  | 'connections'
  | 'setup';

/** One admin section: its nav entry, and who gets to see it */
export interface DashboardSectionEntry {
  id: DashboardSection;
  label: string;
  href: string;
  icon: string;
  adminOnly: boolean; // Hidden from a caller without admin rights
  needsContent?: boolean; // Shown only after a content source exists
  hiddenDuringSetup?: 'always' | 'unless-current'; // Held back during the first run
  parent?: DashboardSection; // Drawn as a leaf under this section, not as a peer
}

/**
 * cookie to hold open branches in the dashboard nav tree
 */
export const DASHBOARD_FOLDS_COOKIE = 'speicher_dashboard_open';

export function openDashboardFolds(raw: unknown): ReadonlySet<DashboardSection> {
  if (typeof raw !== 'string') return new Set();
  const known = new Set<string>(DASHBOARD_SECTIONS.map((section) => section.id));
  return new Set(raw.split(',').filter((id): id is DashboardSection => known.has(id)));
}

/** The section a page is filed under in the column: its parent, or itself */
export function dashboardBranchOf(id: DashboardSection): DashboardSection {
  return DASHBOARD_SECTIONS.find((section) => section.id === id)?.parent ?? id;
}

export const DASHBOARD_SECTIONS: DashboardSectionEntry[] = [
  // In nav order: the first-run entry, then the reports any caller may open
  {
    id: 'setup',
    label: 'Set up',
    href: '/-/setup',
    icon: 'rocket',
    adminOnly: true,
  },
  {
    id: 'status',
    label: 'Sync status',
    href: '/-/status',
    icon: 'activity',
    adminOnly: false,
    needsContent: true,
    hiddenDuringSetup: 'unless-current',
  },
  // The log hangs off Sync status: a dead job is a sync that stopped, so it is read
  // from the page that says which repository stopped syncing
  {
    id: 'logs',
    label: 'Logs',
    href: '/-/logs',
    icon: 'scroll-text',
    adminOnly: true,
    hiddenDuringSetup: 'unless-current',
    parent: 'status',
  },
  // Configuration, hidden until the first run has an administrator
  {
    id: 'config',
    label: 'Configuration',
    href: '/-/config',
    icon: 'settings',
    adminOnly: true,
    hiddenDuringSetup: 'always',
  },
  {
    id: 'explain',
    label: 'Path Access Check',
    href: '/-/explain',
    icon: 'search',
    adminOnly: false,
    needsContent: true,
    hiddenDuringSetup: 'unless-current',
  },
  // The link report, which draws from a content source
  {
    id: 'graph',
    label: 'Link report',
    href: '/-/graph',
    icon: 'waypoints',
    adminOnly: true,
    needsContent: true,
    hiddenDuringSetup: 'unless-current',
  },
  // Read counts, the running instance's own record
  {
    id: 'analytics',
    label: 'Analytics',
    href: '/-/analytics',
    icon: 'chart-line',
    adminOnly: true,
    needsContent: true,
    hiddenDuringSetup: 'unless-current',
  },
  // The reader's own connections, open to any signed-in caller
  {
    id: 'connections',
    label: 'Connections',
    href: '/-/connections',
    icon: 'plug',
    adminOnly: false,
    hiddenDuringSetup: 'always',
  },
];

/** The nav label for a section id, or '' when the id is absent */
export function dashboardSectionTitle(id: DashboardSection): string {
  return DASHBOARD_SECTIONS.find((section) => section.id === id)?.label ?? '';
}

/** Choices that decide which sections the nav shows */
export interface DashboardNavOptions {
  subsection?: string; // Config sub-section the reader is on; opens its branch
  showSetup?: boolean; // True while no administrator exists
  hasContent?: boolean; // False until a content source exists, hiding the reports
  showMailTransport?: boolean; // Adds Mail transport to the setup steps
}

/** Returns the sections that are visible to the current user */
export function visibleDashboardSections(
  currentDashboardSection: DashboardSection | null,
  isAdmin: boolean,
  options: DashboardNavOptions = {},
): DashboardSectionEntry[] {
  const { showSetup = false, hasContent = true } = options;
  // Standing on a child is standing on its branch: the parent must be drawn for the
  // leaf to hang off, so a page's own gates are opened for the section it is under
  const onBranch =
    currentDashboardSection === null ? null : dashboardBranchOf(currentDashboardSection);
  return DASHBOARD_SECTIONS.filter(
    (section) =>
      (isAdmin || !section.adminOnly) &&
      (section.id !== 'setup' || showSetup || currentDashboardSection === 'setup') &&
      // Each gate lets the page the caller is on through, so none vanishes
      (!section.needsContent ||
        hasContent ||
        currentDashboardSection === section.id ||
        onBranch === section.id) &&
      (!section.hiddenDuringSetup ||
        !showSetup ||
        (section.hiddenDuringSetup === 'unless-current' &&
          (currentDashboardSection === section.id || onBranch === section.id))),
  );
}

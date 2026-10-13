/**
 * Applies sidebar_position and sidebar.order from frontmatter to sort orders
 *
 * The walk phase assigns sortOrder from numeric filename prefixes, which are the
 * native ordering mechanism and win over imported keys in the same folder
 *
 * Where no sibling carries a prefix, imported values are ranked 1-indexed by
 * sorted order, absorbing fractional values into integer positions
 *
 * Folder ordering comes from its index page frontmatter, if any
 *
 * Mixed prefix and imported ordering produces a warning, not an error
 */

import { parentSlugPath } from '../../common/slug';
import { Frontmatter } from '../../config/types';
import { ScanState } from './state';

/** Grouping container for a file or directory with its siblings under one parent */
interface OrderingMember {
  source: string; // Source path for the member

  prefix: number | null; // Numeric prefix from filename

  imported: number | null; // Value from sidebar_position or sidebar.order

  apply: (order: number | null) => void; // Mutates the original object's sortOrder
}

/** Collects files and directories grouped by parent path, then ranks imported ordering where no prefix is present */
export function applyImportedOrdering(scan: ScanState): void {
  const sets = new Map<string, OrderingMember[]>();
  const push = (parentPath: string, member: OrderingMember): void => {
    const existing = sets.get(parentPath);
    if (existing) existing.push(member);
    else sets.set(parentPath, [member]);
  };

  for (const file of scan.files) {
    if (file.isIndex) continue;
    push(file.parentPath, {
      source: file.sourcePath,
      prefix: file.sortOrder,
      imported: importedOrder(file.frontmatter),
      apply: (order) => {
        file.sortOrder = order;
      },
    });
  }

  for (const [slugPath, dir] of scan.dirs) {
    const parentPath = parentSlugPath(slugPath);
    if (parentPath === null) continue;

    const index = scan.files.find((f) => f.isIndex && f.slugPath === slugPath);
    push(parentPath, {
      source: dir.sourcePath,
      prefix: dir.sortOrder,
      imported: index ? importedOrder(index.frontmatter) : null,
      apply: (order) => {
        dir.sortOrder = order;
      },
    });
  }

  for (const [parentPath, members] of sets) {
    const declared = members.filter((m) => m.imported !== null);
    if (members.some((m) => m.prefix !== null)) {
      if (declared.length > 0) reportMixedOrdering(scan, parentPath, declared.length);
      continue;
    }
    if (declared.length === 0) continue;

    // Build a 1-indexed rank from sorted unique imported values
    const rank = new Map<number, number>();
    [...new Set(declared.map((m) => m.imported as number))]
      .sort((a, b) => a - b)
      .forEach((value, index) => rank.set(value, index + 1));

    for (const member of declared) member.apply(rank.get(member.imported as number) ?? null);
  }
}

/** Reads sidebar_position or sidebar.order from frontmatter */
function importedOrder(frontmatter: Frontmatter): number | null {
  const declared = frontmatter.sidebar_position ?? frontmatter.sidebar?.order;
  return typeof declared === 'number' && Number.isFinite(declared) ? declared : null;
}

/** Warns that imported ordering keys are ignored because a sibling carries a prefix */
function reportMixedOrdering(scan: ScanState, parentPath: string, ignored: number): void {
  const dir = scan.dirs.get(parentPath);
  scan.root.findings.warn({
    code: 'mixed-ordering',
    source: dir?.sourcePath || scan.root.configName,
    message:
      `this folder is ordered by numeric filename prefixes, so the imported ` +
      `\`sidebar_position\`/\`sidebar.order\` on ${ignored} ` +
      `${ignored === 1 ? 'sibling is' : 'siblings are'} ignored.`,
  });
}

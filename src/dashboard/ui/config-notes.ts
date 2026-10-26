/**
 * The notes a configuration page shows about the stored configuration
 */
import { renderInlineIcon } from '../../content-reader/icons';
import { escapeHtml, renderComponent } from '../../content-reader/views';
import { renderHelp } from '../../global-ui/help-markup';
import type { SkippedConfigVersion } from '../../config/types';
import type { Note } from '../../global-ui/note';
import type { ConfigCommon } from '../configurator/config-page/payloads';
import type { RepairPreview } from '../configurator/repair-preview';

/** Says that the stored configuration cannot be read or does not parse */
export function loadNotes(config: ConfigCommon): Note[] {
  const notes: Note[] = [];
  const file = `<code>${escapeHtml(config.config_path ?? '')}</code>`;
  if (config.unreadable) {
    notes.push({
      level: 'fail',
      html: `Speicher cannot read the configuration file ${file}: ${escapeHtml(config.unreadable)}. This instance keeps running the configuration it loaded at startup. To fix this, make sure that the file exists and that Speicher may read it.`,
    });
  }
  if (config.unparseable && config.config_source === 'database') {
    notes.push({
      level: 'fail',
      html: `The newest saved configuration is not valid YAML: ${escapeHtml(config.unparseable)}. That is why no settings are shown here. To fix this, open <a href="/-/config/history">Configuration history</a> and restore the newest version that is valid.`,
    });
  } else if (config.unparseable) {
    notes.push({
      level: 'fail',
      html: `The configuration file ${file} is not valid YAML: ${escapeHtml(config.unparseable)}. That is why no settings are shown here. To fix this, correct the YAML in the file and reload this page.`,
    });
  }
  return notes;
}

/**
 * Says that the newest saved versions do not load, folds their problems, and offers the two fixes
 *
 * @param skipped the versions that do not load, newest first
 * @param editing the newest saved version
 * @param running the version this instance runs
 * @param repair what repairing the newest version changes, null when it cannot be saved
 */
export function skippedVersionsNote(
  skipped: SkippedConfigVersion[],
  editing: number,
  running: number,
  repair: RepairPreview | null,
): Note {
  return {
    level: 'fail',
    tag: 'div',
    html: renderComponent(
      '@broken-versions/note',
      brokenVersions(skipped, editing, running, repair),
    ),
  };
}

/**
 * The dialog that covers a configuration page while the newest saved version does not load, and only offers the fixes
 *
 * @param config the stored configuration the page shows
 */
export function brokenVersionsDialog(config: ConfigCommon): string | null {
  const { editing_version: editing, running_version: running } = config;
  if (!config.repair || editing === null || running === null || config.skipped.length === 0) {
    return null;
  }
  return renderComponent(
    '@broken-versions/dialog',
    brokenVersions(config.skipped, editing, running, config.repair),
  );
}

// What the `@broken-versions` components draw
function brokenVersions(
  skipped: SkippedConfigVersion[],
  editing: number,
  running: number,
  repair: RepairPreview | null,
): Record<string, unknown> {
  const oldest = skipped[skipped.length - 1].version;
  return {
    versions: skipped.length === 1 ? `Version ${editing}` : `Versions ${oldest}–${editing}`,
    count: skipped.length,
    oldest,
    editing,
    running,
    problemCount: skipped[0].problems.length,
    groups: groupSkipped(skipped),
    repair,
    icons: {
      fail: renderInlineIcon('circle-x', 'spr-icon'),
      repair: renderInlineIcon('wrench', 'spr-icon'),
      restore: renderInlineIcon('rotate-ccw', 'spr-icon'),
      history: renderInlineIcon('history', 'spr-icon'),
    },
  };
}

/** Versions in a row that fail for the same reasons, as one entry */
function groupSkipped(skipped: SkippedConfigVersion[]): { label: string; problems: string[] }[] {
  const groups: { newest: number; oldest: number; problems: string[] }[] = [];
  for (const skip of skipped) {
    const last = groups[groups.length - 1];
    if (
      last &&
      last.problems.join('\n') === skip.problems.join('\n') &&
      last.oldest === skip.version + 1
    ) {
      last.oldest = skip.version;
    } else {
      groups.push({ newest: skip.version, oldest: skip.version, problems: skip.problems });
    }
  }
  return groups.map((group) => ({
    label:
      group.newest === group.oldest
        ? `Version ${group.newest}`
        : `Versions ${group.oldest}–${group.newest}`,
    problems: group.problems,
  }));
}

/** Says why the newest saved version is not the one this instance is running */
export function versionNotes(config: ConfigCommon): Note[] {
  const { editing_version: editing, running_version: running } = config;
  if (running === null || editing === null || running === editing) return [];

  if (config.skipped.length > 0) {
    // A page that can be saved is covered by `blockedWhileBroken` instead
    return config.repair ? [] : [skippedVersionsNote(config.skipped, editing, running, null)];
  }

  if (config.waiting_on.length > 0) {
    const one = config.waiting_on.length === 1;
    const keys = config.waiting_on.map((key) => `<code>${escapeHtml(key)}</code>`).join(', ');
    return [
      {
        level: 'warn',
        html: `Version ${editing} is saved and waits for a restart. This instance is running version ${running}, because ${keys} ${one ? 'builds' : 'build'} objects that only exist at startup. Every other change in that version waits with ${one ? 'it' : 'them'}.`,
      },
      ...config.waiting_consequences.map((line) => ({ level: 'warn', html: renderHelp(line) })),
    ];
  }

  return [
    {
      level: 'idle',
      text: `Version ${editing} is saved but not yet in force here: this instance is running version ${running} and has not picked the newer one up yet.`,
    },
  ];
}

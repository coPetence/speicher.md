/** Stored configuration notices */
import { renderInlineIcon } from '../../content-reader/icons';
import { escapeHtml, renderComponent } from '../../content-reader/views';
import { renderHelp } from '../../global-ui/help-markup';
import type { SkippedConfigVersion } from '../../config/types';
import type { Note } from '../../global-ui/note';
import type { ConfigCommon } from '../configurator/config-page/payloads';
import type { RepairPreview } from '../configurator/repair-preview';

/** Report configuration read and parse errors */
export function loadNotes(config: ConfigCommon): Note[] {
  const notes: Note[] = [];
  const file = `<code>${escapeHtml(config.config_path ?? '')}</code>`;
  if (config.unreadable) {
    notes.push({
      level: 'fail',
      html: `speicher.md cannot read the configuration file ${file}: ${escapeHtml(config.unreadable)}. This instance keeps running the configuration it loaded at startup. To fix this, make sure that the file exists and that speicher.md may read it.`,
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
 * Show grouped version failures and repair or restore options
 *
 * @param skipped Failed versions, newest first
 * @param editing Latest saved version
 * @param running Currently running version
 * @param repair Repair preview, or null if saving is blocked
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

/** Block the page with repair or restore options when the latest version fails */
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

// Shared data for @broken-versions components
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

/** Group consecutive versions with identical problems */
function groupSkipped(
  skipped: SkippedConfigVersion[],
): { label: string; problems: string[]; codes: string[] }[] {
  const groups: { newest: number; oldest: number; problems: string[]; codes: string[] }[] = [];
  for (const skip of skipped) {
    const last = groups[groups.length - 1];
    if (
      last &&
      last.problems.join('\n') === skip.problems.join('\n') &&
      last.oldest === skip.version + 1
    ) {
      last.oldest = skip.version;
    } else {
      groups.push({
        newest: skip.version,
        oldest: skip.version,
        problems: skip.problems,
        codes: skip.issues.map((p) => p.code),
      });
    }
  }
  return groups.map((group) => ({
    label:
      group.newest === group.oldest
        ? `Version ${group.newest}`
        : `Versions ${group.oldest}–${group.newest}`,
    problems: group.problems,
    codes: group.codes,
  }));
}

/** Explain why the latest saved version is not running */
export function versionNotes(config: ConfigCommon): Note[] {
  const { editing_version: editing, running_version: running } = config;
  if (running === null || editing === null || running === editing) return [];

  if (config.skipped.length > 0) {
    // blockedWhileBroken handles pages that allow saving
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

/**
 * The notes a configuration page shows about the stored configuration
 */
import { escapeHtml } from '../../content-reader/views';
import { renderHelp } from '../../global-ui/help-markup';
import type { Note } from '../../global-ui/note';
import type { ConfigCommon } from '../configurator/config-page/payloads';

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

/** Says why the newest saved version is not the one this instance is running */
export function versionNotes(config: ConfigCommon): Note[] {
  const { editing_version: editing, running_version: running } = config;
  if (running === null || editing === null || running === editing) return [];

  if (config.skipped.length > 0) {
    return [
      {
        level: 'fail',
        text: `Editing version ${editing}, the newest saved. This instance is running version ${running}, because the newer one does not load.`,
      },
      ...config.skipped.map((skip) => ({
        level: 'fail',
        text: `Version ${skip.version}: ${skip.problems.join('; ')}`,
      })),
    ];
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

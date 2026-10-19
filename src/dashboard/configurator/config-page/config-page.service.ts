/**
 * Admin UI page builder for the configuration editor
 *
 * Builds section/field shape from the YAML document
 * The live checks are `config-page/checks.ts`, the entry origins
 * `config-page/origins.ts`, the payload types `config-page/payloads.ts`
 *
 * Not a Nest controller; called from a Nest controller that owns the HTTP surface
 */

import { readFileSync } from 'node:fs';

import { Document, isSeq } from 'yaml';

import { ResolvedCaller } from '../../../authz/caller';
import { envReport, instanceHost } from '../../../common/env';
import { ConfigError } from '../../../common/errors';
import { compareConfigs } from '../../../config/classification';
import { ConfigService } from '../../../config/config.service';
import { getNewestConfigVersion } from '../../../config/loader';
import { loadInstanceConfig } from '../../../config/parser';
import { stampBrandImages } from './brand-stamp';
import { stampPickListOptions } from './pick-list-stamp';
import { shapeControls } from '../config-form/collections';
import { dottedPath, loadDocument } from '../config-form/document';
import { inlineBrandImages } from '../config-form/brand-inline';
import { exportConfig } from '../config-form/export';
import {
  CONFIG_NAV_SECTIONS,
  CONFIG_SECTIONS,
  buildSections,
  isDisabledSection,
} from '../config-form/fields';
import { memberExists, seedMemberInto } from '../config-form/member-edits';
import {
  KindHint,
  canCreateMember,
  memberCollectionOf,
  memberOf,
  memberPosition,
} from '../config-form/members';
import { FormSection, allFields } from '../config-form/model';
import { displayYaml } from '../config-form/redact';
import {
  ConfigBackup,
  ConfigBackupPayload,
  ConfigEnvironmentPayload,
  ConfigOverviewPayload,
  ConfigSectionPayload,
  ConfigState,
} from './payloads';
import { UNCLAIMED_YAML } from '../../setup/unclaimed';

/**
 * copies any unsaved secrets from the edited document into the payload
 *
 * @param payload the page that is sent back
 * @param edited the document the page is drawn from
 * @param storedYaml the stored document
 */
export function carryUnsavedSecrets(
  payload: ConfigSectionPayload,
  edited: Document,
  storedYaml: string,
): void {
  if (!payload.section) return;
  const stored = loadDocument(storedYaml);
  for (const field of allFields([payload.section])) {
    if (field.kind !== 'secret' || !field.secretHidden) continue;
    const path = dottedPath(field.path);
    const value = edited.getIn(path);
    if (typeof value === 'string' && value !== stored.getIn(path)) field.unsaved = value;
  }
}

export class ConfigPageService {
  constructor(private readonly config: ConfigService) {}

  async state(caller: ResolvedCaller): Promise<ConfigState> {
    const source = this.config.configSource;
    let yaml = '';
    let editingVersion: number | null = null;
    let unreadable: string | null = null;

    if (source === 'database') {
      const newest = await getNewestConfigVersion(caller.tenantId);
      // Fresh tenants have no saved config; show the starter template
      yaml = newest?.yaml ?? UNCLAIMED_YAML;
      editingVersion = newest?.version ?? null;
    } else {
      const path = this.config.sourcePath;
      try {
        yaml = path ? readFileSync(path, 'utf8') : '';
      } catch (err) {
        // File may not exist (e.g. first run with file source)
        unreadable = (err as Error).message;
      }
    }

    let doc: Document | null = null;
    let unparseable: string | null = null;
    if (yaml !== '') {
      try {
        doc = loadDocument(yaml);
      } catch (err) {
        unparseable = (err as Error).message;
      }
    }

    return {
      // The raw YAML as stored; used for draft payloads that need the original
      storedYaml: yaml,
      tenantId: caller.tenantId,
      doc,
      common: {
        config_source: source,

        // Only database-backed configs can be edited in the UI
        editable: source === 'database',
        config_path: this.config.sourcePath,
        editing_version: editingVersion,
        running_version: this.config.configVersion,
        resolution_hash: this.config.resolutionHash,
        skipped: this.config.skippedConfigVersions,
        waiting_on: this.waitingOn(editingVersion, yaml),
        waiting_consequences: this.waitingConsequences(editingVersion, yaml),
        unreadable,
        unparseable,
      },
    };
  }

  overview(state: ConfigState): ConfigOverviewPayload {
    const built = state.doc ? buildSections(state.doc) : [];
    return {
      ...state.common,

      // When there are no sections (empty or unparseable doc), fall back to the
      // static nav structure so the UI still shows a navigable skeleton
      sections:
        built.length > 0
          ? // Only top-level sections for the overview (entries shown on drill-down)
            built
              .filter((section) => section.parent === null && !isDisabledSection(section.id))
              .map((section) => ({
                id: section.id,
                title: section.title,
                icon: sectionIcon(section.id),
                blurb: section.blurb,
              }))
          : CONFIG_NAV_SECTIONS.map((entry) => ({
              id: entry.id,
              title: entry.title,
              icon: entry.icon,
              blurb: '',
            })),
      // What the document may be *shown* as, which is not what it may be carried
      // away as: this one elides the logo for length and says nothing in place of a
      // literal secret, where the download references it. Two strings for two jobs.
      yaml: displayYaml(state.storedYaml),

      // The name `GET /-/config/download` saves the file as, shown on the card
      // that opens the backup page
      backup_filename: configDownloadFilename(),
    };
  }

  /**
   * backupPage returns what the `/-/config/backup` page shows for the given state:
   * the file `backup` produces, together with its size in bytes.
   */
  async backupPage(state: ConfigState): Promise<ConfigBackupPayload> {
    const backup = await this.backup(state);
    return {
      ...state.common,
      ...backup,
      // Bytes, not characters: the file is what is saved, and a group's name or an
      // operator's note may be outside ASCII.
      bytes: Buffer.byteLength(backup.yaml, 'utf8'),
    };
  }

  /**
   * backup returns the stored configuration of the given state as a file to
   * download, with every secret replaced by an environment variable
   * reference.
   */
  async backup(state: ConfigState): Promise<ConfigBackup> {
    let exported;
    try {
      exported = exportConfig(await inlineBrandImages(state.tenantId, state.storedYaml), {
        host: instanceHost(),
        version: state.common.editing_version,
      });
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;

      const yaml = err.message
        .split('\n')
        .map((line) => `# ${line}`)
        .join('\n');
      return { filename: configDownloadFilename(), yaml: `${yaml}\n`, variables: [] };
    }
    return {
      filename: configDownloadFilename(),
      yaml: exported.yaml,
      variables: exported.variables,
    };
  }

  /**
   * The other half of what decides this instance's behaviour, and the half no form
   * can touch.
   *
   * A page of its own rather than a panel under the settings index, for what the
   * two are: the index is a list of things to change, and this is a list of things
   * that were decided by the deployment and cannot be changed from here. Sitting
   * one scroll below the sections, it read as the ninth of them.
   *
   * It takes no `ConfigState`, and that is the point of the split — nothing here
   * reads the stored document, so the page answers on an instance whose
   * configuration does not parse, which is one of the states somebody arrives on
   * this page to diagnose.
   */
  environment(): ConfigEnvironmentPayload {
    return { environment: envReport() };
  }

  async sectionPayload(
    state: ConfigState,
    sectionId: string,
    query = '',
    openKind = '',
  ): Promise<ConfigSectionPayload> {
    const payload = this.payloadFrom(state, state.doc, sectionId, undefined, query);
    // If the requested openKind is among the add-ops on this section, propagate it
    const offered = payload.section?.addOps.some((op) =>
      op.typeOptions.some((option) => option.value === openKind),
    );
    payload.openKind = offered ? openKind : '';
    await stampBrandImages(state.tenantId, payload);
    await stampPickListOptions(state.tenantId, payload);
    return payload;
  }

  /**
   * draftPayload builds the page of a member that is not stored yet.
   *
   * @param state the stored configuration
   * @param sectionId the page of the new member, e.g. `sources/gh`
   * @param kind the kind the member is created as, e.g. `github`
   */
  draftPayload(state: ConfigState, sectionId: string, kind: string): ConfigSectionPayload | null {
    const member = memberOf(sectionId);
    if (!state.doc || !member || !canCreateMember(member, kind)) return null;

    const position = memberPosition(member);
    if (position) {
      const list = state.doc.getIn(position.list, true);
      if (position.at !== (isSeq(list) ? list.items.length : 0)) return null;
    }

    // Require the referenced provider entry to exist before drafting
    if (
      member.entry !== null &&
      state.doc.getIn(['auth', 'providers', member.entry]) === undefined
    ) {
      return null;
    }

    let doc: Document;
    try {
      doc = loadDocument(state.storedYaml);
    } catch {
      // Should not happen since state.doc already parsed
      return null;
    }
    // Insert a placeholder entry for the new member so the form has fields to render
    seedMemberInto(doc, member, kind);

    const hint: KindHint | undefined =
      member.section === 'identity' ? { provider: member.id, kind } : undefined;

    const payload = this.payloadFrom(state, doc, sectionId, hint);
    if (!payload.section) return null;
    // Track what kind is being created so the UI can show the right defaults
    if (memberCollectionOf(member.section)?.kinds) payload.creating_kind = kind;
    return payload;
  }

  private payloadFrom(
    state: ConfigState,
    doc: Document | null,
    sectionId: string,
    hint?: KindHint,
    query = '',
  ): ConfigSectionPayload {
    const section = doc ? (buildSections(doc, hint).find((s) => s.id === sectionId) ?? null) : null;
    // A section is "creating" when its member does not yet exist in the stored doc
    const member = memberOf(sectionId);
    const creating = member !== null && !!state.doc && !memberExists(state.doc, member);
    return {
      ...state.common,
      section: section && query ? filterEntries(section, query) : section,
      query,

      // Shape controls determine what UI widgets to show for each field
      shape: doc && section ? shapeControls(doc, section) : [],
      verdict: null,
      saved: null,
      error: null,
      problems: [],
      creating,

      // True when the user has unsaved work in a draft
      holds_work: false,
      creating_kind: '',

      // Which sub-kind dialog to open on load (e.g. "github" in forges)
      openKind: '',

      // Member usage stats filled in by the caller when needed
      usage: [],

      // A freshly seeded draft counts as pending until saved
      pending: creating,
    };
  }

  private waitingConsequences(editingVersion: number | null, yaml: string): string[] {
    if (editingVersion === null || editingVersion === this.config.configVersion) return [];
    let proposed;
    try {
      proposed = loadInstanceConfig(yaml);
    } catch {
      // Unparseable YAML; no consequences to report
      return [];
    }

    const running = new Set(Object.keys(this.config.instance.forges ?? {}));
    // Any GitHub forge in the editing version that is absent from the running process
    // will reject webhook deliveries
    const unreachable = Object.entries(proposed.raw.forges ?? {})
      .filter(([key, forge]) => !running.has(key) && forge.type === 'github')
      .map(([key]) => key);

    return unreachable.map(
      (key) =>
        `Webhook deliveries for \`${key}\` are being rejected: the forge is defined in ` +
        `version ${editingVersion}, and this process is running version ` +
        `${this.config.configVersion}. It holds no driver for \`${key}\`, so nothing ` +
        'reaches that forge — not the reconciler, not `speicher sync-repo-list` — until it ' +
        'restarts.',
    );
  }

  private waitingOn(editingVersion: number | null, yaml: string): string[] {
    if (editingVersion === null || editingVersion === this.config.configVersion) return [];
    try {
      return compareConfigs(this.config.loadedConfig, loadInstanceConfig(yaml))
        .changed.filter((change) => change.requiresRestart)
        .map((change) => change.key);
    } catch {
      // Unparseable editing config; can't compute differences
      return [];
    }
  }
}

function filterEntries(section: FormSection, query: string): FormSection {
  const needle = query.trim().toLowerCase();
  if (needle === '') return section;
  return {
    ...section,
    entries: section.entries.filter((entry) => entry.search.includes(needle)),
  };
}

function sectionIcon(id: string): string {
  return CONFIG_SECTIONS.find((section) => section.id === id)?.icon ?? '';
}

/**
 * configDownloadFilename returns the name a downloaded configuration is saved as,
 * `<host>.instance.yaml`, or `speicher.instance.yaml` when the instance declares no
 * URL. The host is reduced to letters, digits, dots and hyphens, because a port's or
 * an IPv6 address's colons and brackets do not belong in a filename.
 */
export function configDownloadFilename(): string {
  const host = instanceHost()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return `${host || 'speicher'}.instance.yaml`;
}

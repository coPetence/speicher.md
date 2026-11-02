import { Document } from 'yaml';

import { EnvReportRow } from '../../../common/env';
import { SaveVerdict } from '../../../config/classification';
import { ConfigSource, SkippedConfigVersion } from '../../../config/types';
import { ShapeControl } from '../config-form/collections';
import { FormSection } from '../config-form/model';
import { MemberUsage } from '../member-usage';
import type { ReadyStep } from '../quick-setup/model';
import type { MissingGroup } from '../quick-setup/repository-check';
import { RepairPreview } from '../repair-preview';
import type { RowAddState } from './row-add';

/** State and payloads for `/-/config` pages */

export interface ConfigState {
  storedYaml: string;
  tenantId: string;
  // Parsed YAML, or null on parse failure
  doc: Document | null;
  common: ConfigCommon;
}

export interface ConfigCommon {
  config_source: ConfigSource;
  // Editing allowed only for database configs
  editable: boolean;
  config_path: string | null;
  // Version being edited, or null for file configs
  editing_version: number | null;
  // Version loaded by the running process
  running_version: number | null;
  resolution_hash: string;
  skipped: SkippedConfigVersion[];
  // Repair changes for the latest version; null if loadable or unsavable
  repair: RepairPreview | null;
  // Changed keys awaiting restart
  waiting_on: string[];
  // Effects of delaying restart
  waiting_consequences: string[];
  // File read error, or null for database configs or success
  unreadable: string | null;
  // YAML parse error, or null on success
  unparseable: string | null;
}

export interface SectionSummary {
  id: string;
  title: string;
  // Shared card and heading icon from CONFIG_SECTIONS
  icon: string;
  // Help markup with optional links
  blurb: string;
}

export interface ConfigOverviewPayload extends ConfigCommon {
  sections: SectionSummary[];
  // Stored YAML with secrets replaced, shared by JSON and downloads
  yaml: string;
}

export interface ConfigEnvironmentPayload {
  // All registered variables and their resolved values
  environment: EnvReportRow[];
}

export interface ConfigBackup {
  // Download filename
  filename: string;
  // Stored YAML with secrets replaced by environment references
  yaml: string;
  // Referenced variables, or empty if no secrets were replaced
  variables: string[];
}

export interface ConfigSectionPayload extends ConfigCommon {
  // Form section, or null for an unknown section or invalid YAML
  section: FormSection | null;
  // Active filter
  query: string;
  // Controls for dynamic fields
  shape: ShapeControl[];
  // Creating a new member draft
  creating: boolean;
  // Draft has unsaved changes
  holds_work: boolean;
  // Sub-kind dialog to open on load
  openKind: string;
  // Why the add modal's quick setup was refused, shown in the reopened modal
  add_error?: string;
  add_error_field?: string;
  // What the add modal held when its quick setup was refused, by field name
  add_values?: Record<string, string>;
  row_add?: RowAddState;
  // What a quick setup did and what is left, shown as a modal over the list the member joined
  ready?: ReadyModal;
  // Whether the repositories a source reads are ready to be published, shown as a modal over the list of sources
  check?: CheckModal;
  // The groups those repositories name that do not exist yet, to be created, shown as a modal over the list of sources
  create_groups?: CreateGroupsModal;
  config_file?: ConfigFileModal;
  // Kind being created in a multi-kind collection
  creating_kind: string;
  // Section member usage
  usage: MemberUsage[];
  verdict: SaveVerdict | null;
  saved: { version: number; applied_at: Date } | null;
  error: string | null;
  problems: string[];
  // Optional refusal codes for error and problems
  error_code?: string;
  problem_codes?: string[];
  // Inline problems hidden from the page summary, kept in JSON
  problems_shown?: boolean[];
  // Form field paths for error and problems, or null
  error_path?: string | null;
  problem_paths?: (string | null)[];
  notice?: string;
  // Draft awaiting save
  pending: boolean;
  // Scroll target after add/remove; focus selects the first field
  landing?: { path: string; focus: boolean };
}

/** The modal a quick setup ends on */
export interface ReadyModal {
  // The new member's page, e.g. `identity/github`
  section_id: string;
  id: string;
  title: string;
  steps: ReadyStep[];
  // The modal's main button: Done, which leaves for the list without the ready address that opens this; or during
  // the first setup, on to its next step
  primary: { label: string; href: string; onward: boolean };
}

/** The modal that checks the repositories a source reads */
export interface CheckModal {
  // The source's page, e.g. `sources/github`
  section_id: string;
  id: string;
  title: string;
  // Why no repository could be checked, e.g. the App is not installed yet
  problem?: { text: string; href?: string; label?: string };
  repositories: CheckRow[];
  // Whether the source reads more repositories than were checked
  more: boolean;
  // Not checked yet: the page answers at once, and the check runs at this address, which the modal is swapped for
  pending?: { href: string };
  primary: ReadyModal['primary'];
}

/** The modal that creates the groups a source's repositories name that do not exist yet */
export interface CreateGroupsModal {
  // The source's page, e.g. `sources/github`
  section_id: string;
  id: string;
  // Where the modal posts, and where it leads back to
  action: string;
  back_href: string;
  // Who the person creating the groups is, as the toggle that adds them names them; null when they have no sign-in
  me: string | null;
  groups: MissingGroup[];
  error?: string;
  // Not checked yet: the page answers at once, and the check runs at this address, which the modal is swapped for
  pending?: { href: string };
}

/** The modal that picks the groups a new `.speicher.yaml` grants reading to */
export interface ConfigFileModal {
  // The source's page, e.g. `sources/github`
  section_id: string;
  id: string;
  // e.g. `acme/handbook`
  repository: string;
  action: string;
  back_href: string;
  leads_to: string;
  groups: { name: string; checked: boolean }[];
  error?: string;
}

/** One repository of the check */
export interface CheckRow {
  // e.g. `acme/handbook`
  name: string;
  // The repository on GitHub
  href: string;
  state: 'ready' | 'unpublished' | 'unknown-groups' | 'invalid' | 'unreadable';
  // What the check found, in markdown
  text: string;
  // The modal that creates its `.speicher.yaml`, for one that has none
  create_href?: string;
  create_action?: string;
  edit_href?: string;
  readers?: string;
  groups?: string[];
  misnamed?: string;
}

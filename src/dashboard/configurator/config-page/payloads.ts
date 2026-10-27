import { Document } from 'yaml';

import { EnvReportRow } from '../../../common/env';
import { SaveVerdict } from '../../../config/classification';
import { ConfigSource, SkippedConfigVersion } from '../../../config/types';
import { ShapeControl } from '../config-form/collections';
import { FormSection } from '../config-form/model';
import { MemberUsage } from '../member-usage';
import { RepairPreview } from '../repair-preview';

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

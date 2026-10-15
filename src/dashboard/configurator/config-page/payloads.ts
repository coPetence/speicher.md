import { Document } from 'yaml';

import { EnvReportRow } from '../../../common/env';
import { SaveVerdict } from '../../../config/classification';
import { ConfigSource, SkippedConfigVersion } from '../../../config/types';
import { ShapeControl } from '../config-form/collections';
import { FormSection } from '../config-form/model';
import { MemberUsage } from '../member-usage';

/** What `/-/config` and its pages carry, in both representations. */

export interface ConfigState {
  storedYaml: string;
  tenantId: string;
  // Parsed YAML document, null when unparseable
  doc: Document | null;
  common: ConfigCommon;
}

export interface ConfigCommon {
  config_source: ConfigSource;
  // Whether the UI allows edits (database-backed configs only)
  editable: boolean;
  config_path: string | null;
  // Version the user is editing, null when using file source
  editing_version: number | null;
  // Version the running process loaded
  running_version: number | null;
  resolution_hash: string;
  skipped: SkippedConfigVersion[];
  // Keys that changed and require a restart
  waiting_on: string[];
  // Explanations of what breaks until restart
  waiting_consequences: string[];
  // Error reading the file, null on database source or success
  unreadable: string | null;
  // Error parsing the YAML, null on success
  unparseable: string | null;
}

export interface SectionSummary {
  id: string;
  title: string;
  // The symbol the section's card and its page heading share, read off
  // `CONFIG_SECTIONS` — the one list saying what a page of this surface is drawn
  // with, so the card and the page it opens cannot come to disagree.
  icon: string;
  // Help markup, which may contain links
  blurb: string;
}

export interface ConfigOverviewPayload extends ConfigCommon {
  sections: SectionSummary[];
  // The stored document with literal secrets replaced. The page no longer prints
  // it — it offers it as a file — but a JSON caller still receives it here, which
  // is what keeps the download from being a second answer to the same question.
  yaml: string;
  // What the download is called
  backup_filename: string;
}

export interface ConfigBackupPayload extends ConfigCommon, ConfigBackup {
  // Size of the file in bytes
  bytes: number;
}

export interface ConfigEnvironmentPayload {
  // Every variable the registry declares, with what this process resolved for it
  environment: EnvReportRow[];
}

export interface ConfigBackup {
  // What the browser saves it as
  filename: string;
  // The stored document, with literal secrets turned into environment references
  yaml: string;
  // The variables those references name; empty when nothing had to be replaced
  variables: string[];
}

export interface ConfigSectionPayload extends ConfigCommon {
  // Built form section, null when sectionId doesn't exist or doc is unparseable
  section: FormSection | null;
  // Active filter string
  query: string;
  // Shape controls for dynamic field rendering
  shape: ShapeControl[];
  // True when the member doesn't exist yet and we are in draft-creation mode
  creating: boolean;
  // True when the draft has unsaved changes
  holds_work: boolean;
  // Which sub-kind dialog to open on load
  openKind: string;
  // The kind being created (for collections with multiple kinds)
  creating_kind: string;
  // Member usage statistics for the section
  usage: MemberUsage[];
  verdict: SaveVerdict | null;
  saved: { version: number; applied_at: Date } | null;
  error: string | null;
  problems: string[];
  notice?: string;
  // True when the section is in a draft state awaiting save
  pending: boolean;
  // Where the page scrolls to after a round trip added or removed an entry: the path
  // of an entry, e.g. `forges.git.repos.2`, or of a list. `focus` also focuses the
  // entry's first field
  landing?: { path: string; focus: boolean };
}

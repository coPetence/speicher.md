import { ConfigSource, SkippedConfigVersion } from '../../config/types';
import { RunRow } from '../dashboard.repository';
import type { FacetOption, FilterDimension, RepoFilter } from './repo-filter';
import type { RepoSort } from './repo-sort';

export const REPO_STATES = ['ok', 'failed', 'stale', 'never-synced', 'unpublished'] as const;
export type RepoState = (typeof REPO_STATES)[number];

export interface RepoStatus {
  namespace: string;
  slug: string;
  /** The content source's short id and kind, for the mark before the name */
  forge_key: string | null;
  forge_type: string | null;
  last_sha: string | null;
  last_run_at: Date | null;
  last_status: string;
  last_error: string | null;
  poll_interval_ms: number | null;
  documents: number;
  stale: boolean;
  activity: 'syncing' | 'queued' | null;
  state: RepoState;
}

export interface EmbeddingSummary {
  model: string;
  dimensions: number;
  current: number;
  stale: number;
  pending: number;
}

export interface InstanceSummary {
  config_source: ConfigSource;
  config_path: string | null;
  config_version: number | null;
  config_skipped: SkippedConfigVersion[];
  resolution_hash: string;
  forges: string[];
  providers: string[];
  theme: string;
  stale_after: string;
  dead_jobs: number;
  running_jobs: number;
  queued_jobs: number;
  discovering: string[];
  embedding: EmbeddingSummary | null;
}

/** The instance-wide figures the tiles read */
export interface StatusTotals {
  repositories: number;
  pages: number;
  failed: number;
  stale: number;
}

export interface StatusPayload {
  scope: 'admin' | 'maintainer';
  query: string;
  totals: StatusTotals;
  repos: RepoStatus[];
  filter: RepoFilter;
  sort: RepoSort;
  facets: Record<FilterDimension, FacetOption[]>;
  facet_rows: Record<FilterDimension, string>[];
  instance: InstanceSummary | null;
}

export interface RepoRunsPayload {
  namespace: string;
  slug: string;
  forge_type: string | null;
  syncing: boolean;
  runs: RunRow[];
  config: RepoConfigSummary | null;
}

export interface RunPayload {
  namespace: string;
  slug: string;
  run: RunRow;
  published_pages: number;
}

export interface RepoConfigSummary {
  display_title: string | null;
  has_cover: boolean;
  maintainer_principals: string[];
  has_config: boolean;
  poll_interval_ms: number | null;
  root_granted: string[] | null;
  root_principals: string[] | null;
  indexable: boolean | null;
}

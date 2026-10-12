import { AuthzService } from '../authz/authz.service';
import { ResolvedCaller } from '../authz/caller';
import { ContentReports } from '../authz/content/reports';
import { explainRepoRoot } from '../authz/explain';
import { parseDuration } from '../common/time';
import { ConfigService } from '../config/config.service';
import { ConfigSource, SkippedConfigVersion } from '../config/types';
import { DashboardRepository, RunRow } from './dashboard.repository';

// The shape `gen_random_uuid()` produces; anything else in the URL is no run
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Admin status page data assembly
 *
 * Combines repo state, document counts, and instance metadata into frontend payloads
 * Access scoped by caller role, admins see all repos, maintainers only their own
 * Focuses on sync health, grant expiration, config state
 */
export class StatusService {
  constructor(
    private readonly authz: AuthzService,
    private readonly config: ConfigService,
    private readonly reports: ContentReports,
    private readonly repo: DashboardRepository,
  ) {}

  async scopeFor(caller: ResolvedCaller): Promise<'all' | string[]> {
    return this.authz.operationalRepoIds(caller);
  }

  async statusPayload(
    caller: ResolvedCaller,
    scope: 'all' | string[],
    query = '',
  ): Promise<StatusPayload> {
    const rows = await this.repo.repoStatusRows(caller.tenantId, scope);

    const pages = await this.reports.countPagesByRepo(caller.tenantId, scope);

    const staleAfterMs = parseDuration(this.config.notify.stale_after ?? '6h');
    const all: RepoStatus[] = rows.map((row) => ({
      namespace: row.namespace,
      slug: row.slug,
      forge_key: row.forge_key,
      forge_type: row.forge_type,
      last_sha: row.last_sha,
      last_run_at: row.last_run_at,
      last_status: row.last_status,
      // Public error for maintainers, full error for admins
      last_error: caller.isAdmin ? row.last_error : row.last_error_public,
      // Period between POLL checks
      poll_interval_ms: row.poll_interval_ms,
      documents: pages.get(row.id) ?? 0,
      dropped_grants: Number(row.dropped_grants),
      stale:
        row.last_run_at === null ||
        Date.now() - new Date(row.last_run_at).getTime() >
          Math.max(staleAfterMs, 2 * (row.poll_interval_ms ?? 0)),
    }));

    const needle = query.trim().toLowerCase();
    return {
      scope: scope === 'all' ? 'admin' : 'maintainer',
      query: query.trim(),
      /*
        The tiles count what this instance holds, so they are computed before the
        filter and never from `repos`. A filter narrows the list and nothing else —
        a Failed count that fell to zero because somebody typed a name is a number
        that answers a question nobody asked.
      */
      totals: {
        repositories: all.length,
        pages: all.reduce((n, r) => n + r.documents, 0),
        failed: all.filter((r) => r.last_status === 'failed').length,
        stale: all.filter((r) => r.stale && r.last_status !== 'failed').length,
        dropped_grants: all.reduce((n, r) => n + r.dropped_grants, 0),
      },
      repos: needle === '' ? all : all.filter((repo) => repoMatchText(repo).includes(needle)),
      instance: caller.isAdmin ? await this.instanceSummary(caller) : null,
    };
  }

  async repoRunsPayload(
    caller: ResolvedCaller,
    namespace: string,
    slug: string,
  ): Promise<RepoRunsPayload | null> {
    const repoId = await this.operableRepoId(caller, namespace, slug);
    if (!repoId) return null;

    const runs = await this.repo.recentRuns(repoId, caller.isAdmin);
    return {
      namespace,
      slug,
      forge_type: await this.repo.forgeTypeOf(repoId),
      syncing: await this.repo.syncInFlight(caller.tenantId, repoId),
      runs,
      config: await this.repoConfig(caller.tenantId, repoId),
    };
  }

  private async repoConfig(tenantId: string, repoId: string): Promise<RepoConfigSummary | null> {
    const row = await this.repo.repoConfigRow(repoId);
    if (!row) return null;
    const root = await explainRepoRoot(tenantId, repoId);
    return {
      display_title: row.display_title,
      has_cover: row.cover_path !== null,
      maintainer_principals: row.maintainer_principals,
      has_config: row.has_config,
      poll_interval_ms: row.poll_interval_ms,
      root_granted: root?.granted ?? null,
      root_principals: root?.principals ?? null,
      indexable: root?.indexable ?? null,
    };
  }

  /** One run of one repository, scoped exactly as the repository's own page */
  async runPayload(
    caller: ResolvedCaller,
    namespace: string,
    slug: string,
    runId: string,
  ): Promise<RunPayload | null> {
    // Not a uuid is not a run; checked here so the cast in the query cannot throw
    if (!UUID.test(runId)) return null;
    const repoId = await this.operableRepoId(caller, namespace, slug);
    if (!repoId) return null;

    const run = await this.repo.runOf(repoId, runId, caller.isAdmin);
    return run ? { namespace, slug, run } : null;
  }

  async operableRepoId(
    caller: ResolvedCaller,
    namespace: string,
    slug: string,
  ): Promise<string | null> {
    const scope = await this.scopeFor(caller);
    if (scope !== 'all' && scope.length === 0) return null;

    const repo = await this.repo.findRepo(caller.tenantId, namespace, slug);
    if (!repo) return null;
    if (scope !== 'all' && !scope.includes(repo.id)) return null;
    return repo.id;
  }

  private async embeddingSummary(tenantId: string): Promise<EmbeddingSummary | null> {
    const embedding = this.config.embedding;
    if (!embedding) return null;
    const counts = await this.reports.embeddingCoverage(
      tenantId,
      embedding.model,
      embedding.dimensions,
    );
    return { model: embedding.model, dimensions: embedding.dimensions, ...counts };
  }

  private async instanceSummary(caller: ResolvedCaller): Promise<InstanceSummary> {
    return {
      config_source: this.config.configSource,
      config_path: this.config.sourcePath,
      config_version: this.config.configVersion,
      config_skipped: this.config.skippedConfigVersions,
      resolution_hash: this.config.resolutionHash,
      forges: this.config.forgeIds,
      providers: this.config.providerShortIds,
      theme: this.config.themeTemplate,
      stale_after: this.config.notify.stale_after ?? '6h',
      dead_jobs: await this.repo.deadJobCount(caller.tenantId),
      embedding: await this.embeddingSummary(caller.tenantId),
    };
  }
}

export interface EmbeddingSummary {
  model: string;
  dimensions: number;
  current: number;
  stale: number;
  pending: number;
}

/**
 * What the needle is matched against: what the first column *shows*.
 *
 * Exported because the page puts it on every row (`data-spr-row`) for the island to
 * narrow on. One function, so the answer a browser filters by cannot drift from the
 * one a round trip would have given.
 *
 * The name and the source that holds it, and deliberately not the state words. A
 * state is a badge somebody reads down the column, and matching on it would make
 * the answers depend on prose the template owns — the filter would then be two
 * ideas of what a row says, one of which drifts the day a word changes.
 */
export function repoMatchText(repo: RepoStatus): string {
  return [repo.namespace, repo.slug, repo.forge_key, repo.forge_type]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
}

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
  dropped_grants: number;
  stale: boolean;
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
  embedding: EmbeddingSummary | null;
}

/** The instance-wide figures the tiles read, counted before any filter */
export interface StatusTotals {
  repositories: number;
  pages: number;
  failed: number;
  stale: number;
  dropped_grants: number;
}

export interface StatusPayload {
  scope: 'admin' | 'maintainer';
  /** The needle the caller asked for, echoed so page and JSON say the same thing */
  query: string;
  totals: StatusTotals;
  repos: RepoStatus[];
  instance: InstanceSummary | null;
}

export interface RepoRunsPayload {
  namespace: string;
  slug: string;
  forge_type: string | null;
  /** A content sync is running or due now; the page's island polls this */
  syncing: boolean;
  runs: RunRow[];
  config: RepoConfigSummary | null;
}

export interface RunPayload {
  namespace: string;
  slug: string;
  run: RunRow;
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

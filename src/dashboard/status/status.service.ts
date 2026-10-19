import { AuthzService } from '../../authz/authz.service';
import { ResolvedCaller } from '../../authz/caller';
import { ContentReports } from '../../authz/content/reports';
import { explainRepoRoot } from '../../authz/explain';
import { parseDuration } from '../../common/time';
import { ConfigService } from '../../config/config.service';
import { DashboardRepository, JobActivityRow } from '../dashboard.repository';
import {
  DEFAULT_REPO_FILTER,
  RepoFilter,
  facetOptions,
  facetsOf,
  matchesFilter,
  repoMatchText,
} from './repo-filter';
import { RepoSort, sortRepos } from './repo-sort';
import {
  EmbeddingSummary,
  InstanceSummary,
  RepoConfigSummary,
  RepoRunsPayload,
  RepoStatus,
  RunPayload,
  StatusPayload,
} from './status.types';

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
    filter: RepoFilter = DEFAULT_REPO_FILTER,
    sort: RepoSort = 'name',
  ): Promise<StatusPayload> {
    const rows = await this.repo.repoStatusRows(caller.tenantId, scope);
    const jobs = await this.repo.jobActivity(caller.tenantId);

    const syncs = new Map<string, 'syncing' | 'queued'>();
    for (const job of jobs) {
      if (job.kind !== 'sync-repo-content' || !job.repo_id) continue;
      if (job.activity === 'running') syncs.set(job.repo_id, 'syncing');
      else if (!syncs.has(job.repo_id)) syncs.set(job.repo_id, 'queued');
    }

    const pages = await this.reports.countPagesByRepo(caller.tenantId, scope);

    const staleAfterMs = parseDuration(this.config.notify.stale_after ?? '6h');
    const all: RepoStatus[] = rows.map((row) => {
      const unpublished = !row.has_config && row.last_run_at !== null;
      const stale =
        !unpublished &&
        (row.last_run_at === null ||
          Date.now() - new Date(row.last_run_at).getTime() >
            Math.max(staleAfterMs, 2 * (row.poll_interval_ms ?? 0)));
      return {
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
        stale,
        activity: syncs.get(row.id) ?? null,
        state: unpublished
          ? 'unpublished'
          : row.last_run_at === null
            ? 'never-synced'
            : row.last_status === 'failed'
              ? 'failed'
              : stale
                ? 'stale'
                : 'ok',
      };
    });

    const needle = query.trim().toLowerCase();
    return {
      scope: scope === 'all' ? 'admin' : 'maintainer',
      query: query.trim(),
      totals: {
        repositories: all.length,
        pages: all.reduce((n, r) => n + r.documents, 0),
        failed: all.filter((r) => r.last_status === 'failed').length,
        stale: all.filter((r) => r.stale && r.last_status !== 'failed').length,
      },
      repos: sortRepos(
        all.filter(
          (repo) =>
            matchesFilter(repo, filter) && (needle === '' || repoMatchText(repo).includes(needle)),
        ),
        sort,
      ),
      filter,
      sort,
      facets: facetOptions(all),
      facet_rows: all.map(facetsOf),
      instance: caller.isAdmin ? await this.instanceSummary(caller, jobs) : null,
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

  async runPayload(
    caller: ResolvedCaller,
    namespace: string,
    slug: string,
    runId: string,
  ): Promise<RunPayload | null> {
    if (!UUID.test(runId)) return null;
    const repoId = await this.operableRepoId(caller, namespace, slug);
    if (!repoId) return null;

    const run = await this.repo.runOf(repoId, runId, caller.isAdmin);
    if (!run) return null;
    const pages = await this.reports.countPagesByRepo(caller.tenantId, [repoId]);
    return { namespace, slug, run, published_pages: pages.get(repoId) ?? 0 };
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

  private async instanceSummary(
    caller: ResolvedCaller,
    jobs: JobActivityRow[],
  ): Promise<InstanceSummary> {
    return {
      running_jobs: jobs.filter((job) => job.activity === 'running').length,
      queued_jobs: jobs.filter((job) => job.activity === 'queued').length,
      discovering: [
        ...new Set(
          jobs.flatMap((job) =>
            job.kind === 'sync-repo-list' && job.forge_key ? [job.forge_key] : [],
          ),
        ),
      ].sort(),
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

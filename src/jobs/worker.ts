/**
 * Background job processing and orchestration
 *
 * Claims jobs from the queue and dispatches by kind
 * Runs reconciler at intervals to enqueue syncs, discovery, notify and
 * analytics maintenance
 *
 * Max concurrency from env or option; reconciler interval from env or option;
 * discovery interval from env or option; poll interval default 1 s
 * Reconcile tick is the finer of reconcileIntervalMs and minPollIntervalMs,
 * divided by 12, floor 5 s
 */
import { Injectable } from '@nestjs/common';

import { env } from '../common/env';
import { Logger, rootLogger, runWithLogContext } from '../common/logger';
import { sweepAbandonedTempDirs } from '../common/temp-dir';
import { sweepAbandonedClones } from '../forge/git';
import { ConfigService } from '../config/config.service';
import { stableStringify } from '../config/resolution-hash';
import { sweepBrandImages } from '../config/brand-store';
import { purgeAnalytics, sweepAnalytics } from '../dashboard/analytics/retention';
import { TenancyService } from '../db/tenancy';
import { EmbedService } from '../embed/embed.service';
import { ForgeRegistry } from '../forge/registry';
import { IngestService } from '../ingest/ingest.service';
import { NotifyService } from '../notify/notify.service';
import { JobQueue, JobRow } from './queue';
import { RegistrationService } from './registration.service';
import { SyncService } from './sync.service';

export interface WorkerOptions {
  // Override env SPEICHER_SYNC_CONCURRENCY
  maxConcurrency?: number;
  // Override env SPEICHER_RECONCILE_INTERVAL
  reconcileIntervalMs?: number;
  // Override env SPEICHER_DISCOVER_INTERVAL
  discoverIntervalMs?: number;
  // Poll interval, default 1 000 ms
  pollIntervalMs?: number;
}

@Injectable()
export class Worker {
  private readonly log: Logger = rootLogger.child('worker');
  private running = false;
  private inFlight = 0;
  private timer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  // Cached reconcile timer period, to detect changes
  private reconcileTimerMs = 0;
  // Tracks the last config serialisation so re-discovery is not scheduled immediately
  private discoveryEnqueuedFor = new Map<string, string>();
  // Last version of the config that was reconciled. If the config version changes, the reconciler will run immediately rather than waiting for the next interval.
  private reconciledVersion: number | null | undefined = undefined;

  constructor(
    private readonly queue: JobQueue,
    private readonly sync: SyncService,
    private readonly ingest: IngestService,
    private readonly registration: RegistrationService,
    private readonly notify: NotifyService,
    private readonly forges: ForgeRegistry,
    private readonly tenancy: TenancyService,
    private readonly config: ConfigService,
    private readonly embed: EmbedService,
    private readonly options: WorkerOptions = {},
  ) {}

  private get maxConcurrency(): number {
    return this.options.maxConcurrency ?? env('SPEICHER_SYNC_CONCURRENCY');
  }

  private get reconcileIntervalMs(): number {
    return this.options.reconcileIntervalMs ?? env('SPEICHER_RECONCILE_INTERVAL');
  }

  private get discoverIntervalMs(): number {
    return this.options.discoverIntervalMs ?? env('SPEICHER_DISCOVER_INTERVAL');
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // sweep working trees, credential files and unfinished clones from a previously stopped process
    const swept = await Promise.all([sweepAbandonedTempDirs(), sweepAbandonedClones()])
      .then((lists) => lists.flat())
      .catch((err: Error) => {
        this.log.warn('could not remove abandoned temporary directories', { error: err.message });
        return [];
      });
    if (swept.length > 0) {
      this.log.info('removed temporary directories a stopped process left behind', {
        count: swept.length,
      });
    }

    const tenant = await this.tenancy.defaultTenant();
    await this.forges.syncForgeRows(tenant.id);
    await this.forges.loadTrackedBranches();

    for (const forgeKey of this.config.forgeIds) {
      await this.queue.enqueue({
        tenantId: tenant.id,
        kind: 'sync-repo-list',
        payload: { forgeKey },
        dedupeKey: `sync-repo-list:${forgeKey}`,
      });
    }

    if (this.embed.configured) {
      await this.queue.enqueue({ tenantId: tenant.id, kind: 'embed', dedupeKey: 'embed' });
    }

    const poll = this.options.pollIntervalMs ?? 1_000;
    this.timer = setInterval(() => void this.tick(), poll);
    this.reconcileTimerMs = this.reconcileTickMs;
    this.reconcileTimer = setInterval(() => {
      void this.reconcile().catch((err: Error) => {
        this.log.error('reconcile failed', { error: err.message });
      });
    }, this.reconcileTimerMs);
    this.log.info('worker started', {
      concurrency: this.maxConcurrency,
      reconcile_interval_ms: this.reconcileIntervalMs,
      reconcile_tick_ms: this.reconcileTickMs,
    });
    await this.reconcile();
  }

  // Period that drives the reconcile timer: the finer of reconcileIntervalMs
  // and minPollIntervalMs, divided by 12, floor 5 s
  // Not restated in reconcileTickMs property
  private get reconcileTickMs(): number {
    const finest = Math.min(this.reconcileIntervalMs, this.config.minPollIntervalMs ?? Infinity);
    return Math.max(finest / 12, 5_000);
  }

  // Not ConfigService has minPollIntervalMs
  private rearmReconcileTimer(): void {
    if (!this.reconcileTimer) return;
    const tick = this.reconcileTickMs;
    if (tick === this.reconcileTimerMs) return;
    clearInterval(this.reconcileTimer);
    this.reconcileTimerMs = tick;
    this.reconcileTimer = setInterval(() => {
      void this.reconcile().catch((err: Error) => {
        this.log.error('reconcile failed', { error: err.message });
      });
    }, tick);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.timer = null;
    this.reconcileTimer = null;
    // Wait at most 30 s for in-flight jobs to finish
    const deadline = Date.now() + 30_000;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await this.queue.releaseAll();
    this.log.info('worker stopped');
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    // An adopted version is acted on at once rather than at the next reconcile tick
    if (this.config.configVersion !== this.reconciledVersion) {
      void this.reconcile().catch((err: Error) => {
        this.log.error('reconcile after a configuration change failed', { error: err.message });
      });
    }
    const slots = this.maxConcurrency - this.inFlight;
    if (slots <= 0) return;

    const jobs = await this.queue.claim(slots).catch((err) => {
      this.log.error('could not claim jobs', { error: (err as Error).message });
      return [] as JobRow[];
    });

    for (const job of jobs) {
      this.inFlight += 1;
      void this.run(job).finally(() => {
        this.inFlight -= 1;
      });
    }
  }

  private async run(job: JobRow): Promise<void> {
    await runWithLogContext(
      { tenant_id: job.tenant_id, job_id: job.id, job_kind: job.kind },
      async () => {
        try {
          await this.handle(job);
          await this.queue.complete(job.id);
        } catch (err) {
          const message = (err as Error).message;
          this.log.error('job failed', { attempts: job.attempts, error: message });
          // `run` is not awaited, so a throw here would end the process. The row stays
          // `running` and is reclaimed once its visibility timeout passes.
          await this.queue.fail(job, message).catch((failErr: Error) => {
            this.log.error('could not record a job failure', { error: failErr.message });
          });
        }
      },
    );
  }

  private async handle(job: JobRow): Promise<void> {
    const payload = job.payload as Record<string, string | undefined>;

    switch (job.kind) {
      case 'sync-repo-content': {
        const repoId = payload.repoId;
        if (!repoId) return;
        // Re-sync a repo; dedupe key used by caller to avoid stacking
        const result = await this.queue.withRepoLock(repoId, () =>
          this.sync.syncRepo(repoId, (payload.trigger as 'webhook') ?? 'webhook'),
        );
        // If any chunks were written, queue an embed pass
        if (this.embed.configured && (result?.stats.chunks_written ?? 0) > 0) {
          await this.queue.enqueue({
            tenantId: job.tenant_id,
            kind: 'embed',
            dedupeKey: 'embed',
          });
        }
        return;
      }

      case 'embed': {
        if (!this.embed.configured) return;
        // Embed pending chunks under an advisory lock to serialise tenants
        const run = await this.queue.withAdvisoryLock(`embed:${job.tenant_id}`, () =>
          this.embed.embedPending(job.tenant_id),
        );
        // If the run did not exhaust the batch, enqueue another pass immediately
        if (run?.exhausted) {
          await this.queue.enqueue({
            tenantId: job.tenant_id,
            kind: 'embed',
            dedupeKey: 'embed',
          });
        }
        return;
      }

      case 'sync-repo-list': {
        const forgeKey = payload.forgeKey ?? '';
        if (!forgeKey) return;

        if (!this.forges.driver(forgeKey)) {
          this.log.warn('discovery skipped: the running configuration does not define this forge', {
            forge: forgeKey,
            config_version: this.config.configVersion,
          });
          return;
        }

        // Writes all configured forges to the database => ensures the database is up to date with the config (any new forges that have been added to the config will be added to the database)
        await this.forges.syncForgeRows(job.tenant_id);

        const registered = payload.installationId
          ? await this.registration.syncRepoRowsForInstallation(
              job.tenant_id,
              payload.installationId,
              forgeKey,
            )
          : await this.registration.syncInstallationAndRepoRows(job.tenant_id, forgeKey);

        await this.forges.loadTrackedBranches();

        // Sync all repos that have been registered or updated in the database
        for (const repoId of registered) {
          await this.queue.enqueue({
            tenantId: job.tenant_id,
            kind: 'sync-repo-content',
            payload: { repoId, trigger: 'reconciler' },
            dedupeKey: `sync-repo-content:${repoId}`,
            automatic: true,
          });
        }

        // Purge repos that are no longer in config
        for (const repoId of await this.registration.unconfiguredRepoIds(job.tenant_id, forgeKey)) {
          await this.queue.enqueue({
            tenantId: job.tenant_id,
            kind: 'purge',
            payload: { repoId, reason: 'No longer present in the forge repository configuration.' },
          });
        }
        return;
      }

      case 'rename':
        if (payload.repoId && payload.newSlug) {
          await this.registration.renameRepo(job.tenant_id, payload.repoId, payload.newSlug);
        }
        return;

      case 'purge':
        // Remove all data for the repo
        if (payload.repoId) await this.ingest.purgeRepo(payload.repoId);
        return;

      case 'purge-forge': {
        const { forgeId, forgeKey } = payload;
        if (!forgeId || !forgeKey) return;
        if (this.config.forgeIds.includes(forgeKey)) {
          this.log.info('forge purge skipped: the forge is present in the configuration', {
            forge: forgeKey,
          });
          return;
        }

        const repoIds = await this.forges.findRepoIdsOfForge(forgeId);
        for (const repoId of repoIds) await this.ingest.purgeRepo(repoId);
        await this.forges.deleteForgeRow(forgeId);
        const cancelled = await this.queue.deletePendingJobsForForge(
          job.tenant_id,
          forgeKey,
          repoIds,
        );
        this.log.info('removed an orphaned forge', {
          forge: forgeKey,
          repos: repoIds.length,
          cancelled_jobs: cancelled,
        });
        return;
      }

      case 'validate-pr':
        if (payload.repoId && payload.sha) {
          await this.registration.validatePullRequest(payload.repoId, payload.sha);
        }
        return;

      case 'rebuild': {
        // Re-sync every known repo
        const repoIds = await this.registration.allRepoIds(job.tenant_id);
        for (const repoId of repoIds) {
          await this.queue.enqueue({
            tenantId: job.tenant_id,
            kind: 'sync-repo-content',
            payload: { repoId, trigger: 'rebuild' },
            dedupeKey: `sync-repo-content:${repoId}`,
          });
        }
        return;
      }

      case 'notify':
        await this.notify.checkStaleRepos(job.tenant_id);
        await this.notify.digestExpiringGrants(job.tenant_id);
        return;

      case 'reconcile':
        await this.reconcile();
        return;

      case 'analytics-maintenance': {
        if (!this.config.analytics.enabled) {
          await purgeAnalytics();
          return;
        }
        const swept = await sweepAnalytics(this.config);
        if (swept.expired || swept.coarsened || swept.queriesExpired) {
          this.log.info('analytics maintenance', { ...swept });
        }
        return;
      }

      case 'brand-sweep': {
        /*
          removes all brand images that are not referenced by any instance config
          this happens if older instance config versions get removed
        */
        const collected = await sweepBrandImages(
          job.tenant_id,
          this.config.brandImages.map((image) => image.hash),
        );
        if (collected > 0) this.log.info('collected unreferenced brand images', { collected });
        return;
      }

      default:
        this.log.warn('unknown job kind', { kind: job.kind });
    }
  }

  async reconcile(): Promise<void> {
    if (!this.running) return;
    // Set before the first await, so the next tick does not start a second run
    this.reconciledVersion = this.config.configVersion;
    const tenant = await this.tenancy.defaultTenant();
    const due = await this.sync.dueForReconcile(this.reconcileIntervalMs);
    let enqueued = 0;
    for (const { id, reason } of due) {
      const added = await this.queue.enqueue({
        tenantId: tenant.id,
        kind: 'sync-repo-content',
        payload: { repoId: id, trigger: reason === 'grant-review' ? 'grant-review' : 'reconciler' },
        dedupeKey: `sync-repo-content:${id}`,
        automatic: true,
      });
      if (added) enqueued += 1;
    }
    if (this.config.instance.mail) {
      await this.queue.enqueue({
        tenantId: tenant.id,
        kind: 'notify',
        dedupeKey: 'notify',
        runAfterMs: 60_000,
      });
    }
    if (enqueued) this.log.info('reconciler enqueued syncs', { count: enqueued });

    for (const forge of await this.forges.findRemovedForgeRows(tenant.id)) {
      await this.queue.enqueue({
        tenantId: tenant.id,
        kind: 'purge-forge',
        payload: { forgeId: forge.id, forgeKey: forge.key },
        dedupeKey: `purge-forge:${forge.id}`,
      });
    }

    // A forge that left the configuration is forgotten, so one that comes back counts as
    // new and is listed at once rather than a discovery interval later
    for (const forgeKey of this.discoveryEnqueuedFor.keys()) {
      if (!this.config.forgeIds.includes(forgeKey)) this.discoveryEnqueuedFor.delete(forgeKey);
    }

    for (const forgeKey of this.config.forgeIds) {
      // If the forge config has not changed since the last reconcile, delay
      // the next discovery by discoverIntervalMs; otherwise run immediately
      const configuredAs = stableStringify(this.config.forge(forgeKey));
      const asked = this.discoveryEnqueuedFor.get(forgeKey) === configuredAs;
      this.discoveryEnqueuedFor.set(forgeKey, configuredAs);

      await this.queue.enqueue({
        tenantId: tenant.id,
        kind: 'sync-repo-list',
        payload: { forgeKey },
        dedupeKey: `sync-repo-list:${forgeKey}`,
        runAfterMs: asked ? this.discoverIntervalMs : 0,
      });
    }

    await this.queue.enqueue({
      tenantId: tenant.id,
      kind: 'analytics-maintenance',
      dedupeKey: 'analytics-maintenance',
    });

    await this.queue.enqueue({
      tenantId: tenant.id,
      kind: 'brand-sweep',
      dedupeKey: 'brand-sweep',
    });

    this.rearmReconcileTimer();
  }
}

import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { QueryTypes } from 'sequelize';

import { ResolvedCaller } from '../../authz/caller';
import { Logger, rootLogger } from '../../common/logger';
import { ConfigService } from '../../config/config.service';
import { getSequelize } from '../../db/sequelize';
import { BufferedMiss, BufferedView, Surface, ViewBuffer } from './recorder';
import { unionSketch } from './hll';

/**
 * Buffers page views and search misses, flushing them to the database in bulk
 *
 * Records sit in a per-tenant in-memory buffer until flush: every 60 seconds and
 * once on shutdown, so no database write happens on the request path
 *
 * A public web page with the beacon enabled is counted in the browser instead;
 * the server still counts private pages, MCP reads and search misses
 * Reach is a per-bucket salted HyperLogLog sketch, so readers are counted but
 * never stored as identities
 */
@Injectable()
export class AnalyticsService implements OnModuleDestroy {
  private readonly log: Logger = rootLogger.child('analytics');

  private readonly buffers = new Map<string, ViewBuffer>();

  private timer: NodeJS.Timeout | null = null; // null before first record

  /**
   * How often buffered records are flushed to the database
   */
  static readonly FLUSH_INTERVAL_MS = 60_000;

  constructor(private readonly config: ConfigService) {}

  /**
   * True when this public read is counted by the browser beacon, not the server
   */
  beaconCounts(isPublic: boolean): boolean {
    const analytics = this.config.analytics;
    return analytics.enabled && analytics.public_beacon && isPublic;
  }

  servesBeacon(isPublic: boolean): boolean {
    return this.beaconCounts(isPublic);
  }

  /**
   * Record a page view served from the server
   */
  recordPageView(
    caller: ResolvedCaller,
    repoId: string,
    slugPath: string,
    surface: Surface,
    isPublic: boolean,
  ): void {
    const analytics = this.config.analytics;
    if (!analytics.enabled) return;

    // A public page with the beacon on is counted in the browser; counting it
    // here too would double-count a read
    if (surface === 'web' && this.beaconCounts(isPublic)) return;

    // provider:subject so the reader counts as distinct without a name stored
    const identity = caller.identity;
    this.record(
      caller,
      repoId,
      slugPath,
      surface,
      identity ? `${identity.provider}:${identity.subject}` : null,
    );
  }

  /**
   * Record a page view signalled by the client beacon
   */
  recordBeaconView(caller: ResolvedCaller, repoId: string, slugPath: string): void {
    if (!this.config.analytics.enabled) return;
    this.record(caller, repoId, slugPath, 'web', null);
  }

  /**
   * Record that a search returned no results
   */
  recordSearchMiss(caller: ResolvedCaller, query: string): void {
    const analytics = this.config.analytics;
    if (!analytics.enabled) return;
    this.bufferFor(caller.tenantId).recordMiss(query, new Date(), analytics.timezone);
    this.ensureTimer();
  }

  /**
   * Buffer one view against the caller's tenant
   */
  private record(
    caller: ResolvedCaller,
    repoId: string,
    slugPath: string,
    surface: Surface,
    subject: string | null,
  ): void {
    const analytics = this.config.analytics;
    this.bufferFor(caller.tenantId).record(
      { repoId, slugPath, surface },
      new Date(),
      analytics.timezone,
      analytics.granularity,
      analytics.unique_readers ? subject : null, // Reach off, so no subject to sketch
    );
    this.ensureTimer();
  }

  /**
   * Lazy handle to the tenant's buffer, created on first record
   */
  private bufferFor(tenantId: string): ViewBuffer {
    let buffer = this.buffers.get(tenantId);
    if (!buffer) {
      buffer = new ViewBuffer();
      this.buffers.set(tenantId, buffer);
    }
    return buffer;
  }

  /**
   * Start the recurring flush timer, once for the lifetime of the process
   */
  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, AnalyticsService.FLUSH_INTERVAL_MS);
    this.timer.unref(); // so the idle process can exit
  }

  /**
   * Write anything still buffered before the process exits
   */
  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /**
   * Drain every tenant's buffer into the database in one pass
   */
  async flush(): Promise<void> {
    for (const [tenantId, buffer] of [...this.buffers.entries()]) {
      const { views, misses, dropped } = buffer.drain();
      if (dropped > 0) {
        // The buffer hit its per-tenant cap, so these reads are lost entirely
        this.log.warn('analytics buffer full; reads were not counted', { tenantId, dropped });
      }
      if (views.length === 0 && misses.length === 0) continue;
      try {
        await this.write(tenantId, views, misses);
      } catch (error) {
        // The buffer drained before this write, so a failed write is not retried
        this.log.warn('could not write analytics', {
          tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Upsert one tenant's buffered views and misses in a transaction
   */
  private async write(
    tenantId: string,
    views: BufferedView[],
    misses: BufferedMiss[],
  ): Promise<void> {
    const sequelize = getSequelize();
    await sequelize.transaction(async (transaction) => {
      for (const view of views) {
        // Lock and union with the stored sketch so a concurrent flush's readers
        // survive the upsert, which COALESCEs readers to this unioned value
        let readers = view.readers;
        if (readers) {
          const [existing] = await sequelize.query<{ readers: Buffer | null }>(
            `SELECT readers FROM page_views
              WHERE tenant_id = :tenantId AND repo_id = :repoId AND slug_path = :slugPath
                AND bucket = :bucket AND granularity = :granularity AND surface = :surface
              FOR UPDATE`,
            {
              type: QueryTypes.SELECT,
              transaction,
              replacements: {
                tenantId,
                repoId: view.repoId,
                slugPath: view.slugPath,
                bucket: view.bucket,
                granularity: view.granularity,
                surface: view.surface,
              },
            },
          );
          readers = unionSketch(existing?.readers ?? null, readers);
        }

        await sequelize.query(
          `INSERT INTO page_views
             (tenant_id, repo_id, slug_path, bucket, granularity, surface, views, readers)
           VALUES
             (:tenantId, :repoId, :slugPath, :bucket, :granularity, :surface, :views, :readers)
           ON CONFLICT (tenant_id, repo_id, slug_path, bucket, granularity, surface)
           DO UPDATE SET
             views = page_views.views + EXCLUDED.views,
             -- Null means "this flush had no reach to add", never "clear what is
             -- there": the union above already folded the stored value in, so a
             -- non-null EXCLUDED is always the complete answer.
             readers = COALESCE(EXCLUDED.readers, page_views.readers)`,
          {
            type: QueryTypes.INSERT,
            transaction,
            replacements: {
              tenantId,
              repoId: view.repoId,
              slugPath: view.slugPath,
              bucket: view.bucket,
              granularity: view.granularity,
              surface: view.surface,
              views: view.views,
              readers,
            },
          },
        );
      }

      for (const miss of misses) {
        await sequelize.query(
          `INSERT INTO search_misses (tenant_id, query, bucket, misses)
           VALUES (:tenantId, :query, :bucket, :misses)
           ON CONFLICT (tenant_id, query, bucket)
           DO UPDATE SET misses = search_misses.misses + EXCLUDED.misses`,
          {
            type: QueryTypes.INSERT,
            transaction,
            replacements: {
              tenantId,
              query: miss.query,
              bucket: miss.bucket,
              misses: miss.misses,
            },
          },
        );
      }
    });
  }
}

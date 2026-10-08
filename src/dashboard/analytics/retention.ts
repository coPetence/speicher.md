/**
 * Expiration and coarsening of analytics data
 *
 * Hourly page_views are deleted when granularity is day; the caller
 * independently coarsens the remaining rows via an upsert before this
 * runs
 *
 * Buckets past their retention window are deleted
 *
 * When analytics are disabled, purgeAnalytics empties both tables
 */

import { QueryTypes } from 'sequelize';

import { Logger, rootLogger } from '../../common/logger';
import { ConfigService } from '../../config/config.service';
import { getSequelize } from '../../db/sequelize';

const log: Logger = rootLogger.child('analytics');

export interface SweepResult {
  /** Rows dropped because they exceeded retention_days */
  expired: number;
  /** Hourly rows deleted because granularity switched to day */
  coarsened: number;
  /** Search-miss rows dropped because they exceeded search_retention_days */
  queriesExpired: number;
}

export async function sweepAnalytics(config: ConfigService): Promise<SweepResult> {
  const analytics = config.analytics;
  const sequelize = getSequelize();

  let coarsened = 0;
  if (analytics.granularity === 'day') {
    const [, meta] = await sequelize.query(`DELETE FROM page_views WHERE granularity = 'hour'`, {
      type: QueryTypes.RAW,
    });
    coarsened = rowCount(meta);
    if (coarsened > 0) {
      // Not coarsened: the row is simply dropped; an earlier upsert
      // produced the daily aggregate before this runs
      log.info('analytics coarsened to daily buckets', { deleted: coarsened });
    }
  }

  const [, expiredMeta] = await sequelize.query(
    `DELETE FROM page_views
      WHERE bucket < now() - make_interval(days => :days)`,
    { type: QueryTypes.RAW, replacements: { days: analytics.retention_days } },
  );

  const [, queriesMeta] = await sequelize.query(
    `DELETE FROM search_misses
      WHERE bucket < now() - make_interval(days => :days)`,
    { type: QueryTypes.RAW, replacements: { days: analytics.search_retention_days } },
  );

  return {
    expired: rowCount(expiredMeta),
    coarsened,
    queriesExpired: rowCount(queriesMeta),
  };
}

export async function purgeAnalytics(): Promise<number> {
  const sequelize = getSequelize();
  const [, views] = await sequelize.query(`DELETE FROM page_views`, { type: QueryTypes.RAW });
  await sequelize.query(`DELETE FROM search_misses`, { type: QueryTypes.RAW });
  const deleted = rowCount(views);
  if (deleted > 0) log.info('analytics disabled; stored counts deleted', { deleted });
  return deleted;
}

function rowCount(meta: unknown): number {
  const count = (meta as { rowCount?: number } | undefined)?.rowCount;
  return typeof count === 'number' ? count : 0;
}

/**
 * Periodic check for database-stored config changes
 *
 * Only activates when source is 'database'; poll interval from env, 0 disables
 * Uses compareConfigs to classify changed keys; blocks adoption on
 *   restart-requiring keys
 * After adopting, checks resolution hash to enqueue a full rebuild when needed
 * Called directly by admin/auth controllers after a save, not only by timer
 */

import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { EnvName, env } from '../common/env';
import { ConfigError } from '../common/errors';
import { rootLogger } from '../common/logger';
import { tenancy } from '../db/tenancy';
import { compareConfigs } from './classification';
import { ConfigService } from './config.service';
import { getNewestConfigVersion, loadActiveInstanceConfig } from './loader';
import { checkResolutionHash } from './resolution-guard';

export const CONFIG_POLL_ENV = 'SPEICHER_CONFIG_POLL' satisfies EnvName;

export interface RefreshResult {
  /** Whether the watcher switched to a newer version */
  adopted: boolean;

  /** The version the system ran on after refresh; null when unclaimed */
  version: number | null;

  /** Keys that blocked adoption because they need a process restart */
  waiting: string[];
}

@Injectable()
export class ConfigWatcher implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private readonly log = rootLogger.child('config-watcher');

  constructor(private readonly config: ConfigService) {}

  /** Starts the poll timer when source is database and interval is nonzero */
  onModuleInit(): void {
    // Only database-backed configs can change at runtime
    if (this.config.configSource !== 'database') return;

    const interval = pollIntervalMs();
    if (interval === 0) return;
    this.timer = setInterval(() => void this.safeRefresh(), interval);
    // Does not keep the process alive on its own
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Wraps refresh so a single tick failure does not crash the timer */
  private async safeRefresh(): Promise<void> {
    try {
      await this.refresh();
    } catch (err) {
      this.log.error('could not check for a newer configuration version', {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Checks for a newer version and adopts it unless a changed key needs a
   *   restart
   * Returns early when config is file-based or version is unchanged
   * Re-adopts when version is same but skipped-versions list grew
   */
  async refresh(): Promise<RefreshResult> {
    const running = this.config.loadedConfig;
    if (running.source !== 'database') {
      return { adopted: false, version: running.version, waiting: [] };
    }

    const tenant = await tenancy.defaultTenant();
    const newest = await getNewestConfigVersion(tenant.id);
    if (!newest) return { adopted: false, version: running.version, waiting: [] };

    let candidate;
    try {
      // loadActiveInstanceConfig walks backwards from newest to find a valid one
      candidate = await loadActiveInstanceConfig();
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      this.log.error('no stored configuration version loads; staying on the running one', {
        running: running.version,
        error: err.message,
      });
      return { adopted: false, version: running.version, waiting: [] };
    }

    if (candidate.version === running.version) {
      // Skipped list may have grown if a newer broken version was saved since boot
      if (candidate.skipped.length !== running.skipped.length) this.config.adopt(candidate);
      return { adopted: false, version: running.version, waiting: [] };
    }

    const verdict = compareConfigs(running, candidate);
    const blocked = verdict.changed.filter((change) => change.requiresRestart);
    if (blocked.length > 0) {
      return {
        adopted: false,
        version: running.version,
        waiting: blocked.map((change) => change.key),
      };
    }

    this.config.adopt(candidate);

    await checkResolutionHash(this.config);

    this.log.info('adopted a newer configuration version', {
      version: candidate.version,
      previous: running.version,
      keys: verdict.changed.map((change) => change.key),
      rebuild: verdict.rebuild,
    });

    return { adopted: true, version: candidate.version, waiting: [] };
  }
}

/** Returns the configured poll interval in milliseconds (0 disables) */
export function pollIntervalMs(): number {
  return env(CONFIG_POLL_ENV);
}

/**
 * Readiness check for orchestration probes
 *
 * Checks database connectivity, pending migrations, and config loading
 * Read by `/-/readyz` alone — a container healthcheck or a Kubernetes probe, never
 * a person, which is why it lives outside `dashboard/` and reads nothing of it
 */

import { QueryTypes } from 'sequelize';

import { ConfigService } from '../config/config.service';
import { pendingMigrations } from '../db/migrate';
import { getSequelize } from '../db/sequelize';

export class HealthService {
  constructor(private readonly config: ConfigService) {}

  async readiness(): Promise<{ ready: boolean; checks: Record<string, string> }> {
    const checks: Record<string, string> = {};
    let ready = true;

    try {
      await getSequelize().query('SELECT 1', { type: QueryTypes.SELECT });
      checks.database = 'ok';
    } catch (err) {
      checks.database = `unreachable: ${(err as Error).message}`;
      ready = false;
    }

    try {
      const pending = await pendingMigrations();
      checks.migrations = pending.length === 0 ? 'current' : `${pending.length} pending`;
      if (pending.length > 0) ready = false;
    } catch (err) {
      checks.migrations = `unknown: ${(err as Error).message}`;
      ready = false;
    }

    checks.config = this.config.sourcePath ? 'loaded' : 'loaded (inline)';

    return { ready, checks };
  }
}

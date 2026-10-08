/**
 * Detects resolution-hash changes and enqueues a full rebuild
 *
 * Reads the current config's resolution hash, compares against `instance_state`,
 * then upserts the new value. When the hash differs and a previous value existed,
 * inserts a per-tenant `rebuild` job so the frontend picks up the change
 *
 * Not ConfigService-aware: callers that already hold a service pass it in
 */
import { QueryTypes } from 'sequelize';

import { rootLogger } from '../common/logger';
import { ConfigService } from './config.service';
import { loadActiveInstanceConfig } from './loader';
import { getSequelize } from '../db/sequelize';

export const RESOLUTION_HASH_KEY = 'resolution_hash';

export async function checkResolutionHash(
  config?: ConfigService,
): Promise<{ changed: boolean; previous: string | null; current: string }> {
  const service = config ?? new ConfigService(await loadActiveInstanceConfig());
  const current = service.resolutionHash;
  const sequelize = getSequelize();

  const rows = await sequelize.query<{ value: string }>(
    `SELECT value #>> '{}' AS value FROM instance_state WHERE key = :key`,
    { type: QueryTypes.SELECT, replacements: { key: RESOLUTION_HASH_KEY } },
  );
  const previous = rows[0]?.value ?? null;

  if (previous === current) return { changed: false, previous, current };

  await sequelize.query(
    `INSERT INTO instance_state (key, value, updated_at)
     VALUES (:key, to_jsonb(:value::text), now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    { type: QueryTypes.INSERT, replacements: { key: RESOLUTION_HASH_KEY, value: current } },
  );

  if (previous !== null) {
    await sequelize.query(
      `INSERT INTO jobs (tenant_id, kind, payload, dedupe_key)
       SELECT id, 'rebuild', '{"reason":"resolution-hash-changed"}'::jsonb, 'rebuild'
         FROM tenants
       ON CONFLICT DO NOTHING`,
      { type: QueryTypes.INSERT },
    );
    rootLogger.child('config').warn('resolution-relevant config changed; full rebuild enqueued', {
      previous,
      current,
    });
  }

  return { changed: previous !== null, previous, current };
}

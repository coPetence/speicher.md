/**
 * Central registry for forge drivers
 *
 * Builds, caches and reuses driver instances keyed by forge key
 * Syncs forge config rows on startup, caches tracked branches for all repos
 * Provides the directory lookup used by grant ingestion
 *
 * A driver is rebuilt when its config changes (identity checked via stable JSON
 * so that config values in a different object shape are still seen as equal)
 */
import { Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';

import { createDirectoryLookup } from '../auth/directory/lookup';
import { Logger, rootLogger } from '../common/logger';
import { ConfigService } from '../config/config.service';
import { stableStringify } from '../config/resolution-hash';
import { Forge, Installation, Repo, initModels } from '../db/models';
import { getSequelize } from '../db/sequelize';
import { DirectoryLookup } from '../ingest/grants';
import { ForgeDriver, RemoteRepo } from './driver';
import { GitDriver } from './git/git.driver';
import { GithubDriver } from './github/github.driver';

@Injectable()
export class ForgeRegistry {
  private readonly drivers = new Map<string, { builtFrom: string; driver: ForgeDriver }>();
  private readonly log: Logger = rootLogger.child('forge');
  private branchCache = new Map<string, string>();

  constructor(private readonly config: ConfigService) {
    initModels();
  }

  async syncForgeRows(tenantId: string): Promise<void> {
    for (const key of this.config.forgeIds) {
      const forge = this.config.forge(key);
      if (!forge) continue;
      await getSequelize().query(
        `INSERT INTO forges (tenant_id, key, type, is_primary, default_repository_owner, config)
         VALUES (:tenantId, :key, :type, :isPrimary, :defaultRepositoryOwner, '{}'::jsonb)
         ON CONFLICT (tenant_id, key) DO UPDATE SET
           type = EXCLUDED.type,
           is_primary = EXCLUDED.is_primary,
           default_repository_owner = EXCLUDED.default_repository_owner`,
        {
          type: QueryTypes.INSERT,
          replacements: {
            tenantId,
            key,
            type: forge.type,
            isPrimary: key === this.config.primaryForgeId,
            defaultRepositoryOwner: forge.default_repository_owner ?? null,
          },
        },
      );
    }
  }

  /**
   * Returns all forgeIds that are in the database but not in the config, meaning they were removed from the config and should be deleted
   */
  async findRemovedForgeRows(tenantId: string): Promise<{ id: string; key: string }[]> {
    if (this.config.configSource === 'database' && this.config.configVersion === null) return [];
    const rows = await getSequelize().query<{ id: string; key: string }>(
      `SELECT id, key FROM forges WHERE tenant_id = :tenantId`,
      { type: QueryTypes.SELECT, replacements: { tenantId } },
    );
    return rows.filter((row) => !this.config.forgeIds.includes(row.key));
  }

  /** IDs of the repos registered under one forge row */
  async findRepoIdsOfForge(forgeId: string): Promise<string[]> {
    const rows = await getSequelize().query<{ id: string }>(
      `SELECT id FROM repos WHERE forge_id = :forgeId`,
      { type: QueryTypes.SELECT, replacements: { forgeId } },
    );
    return rows.map((row) => row.id);
  }

  /** Delete a forge row; installations, repos and database content is set to cascade delete */
  async deleteForgeRow(forgeId: string): Promise<void> {
    await getSequelize().query(`DELETE FROM forges WHERE id = :forgeId`, {
      type: QueryTypes.DELETE,
      replacements: { forgeId },
    });
  }

  /** Get or build the driver for a forge key, returns null for unknown keys */
  driver(key: string): ForgeDriver | null {
    const forge = this.config.forge(key);
    if (!forge) return null;

    const builtFrom = stableStringify(forge);
    const cached = this.drivers.get(key);
    if (cached && cached.builtFrom === builtFrom) return cached.driver;

    let driver: ForgeDriver;
    if (forge.type === 'github') {
      driver = new GithubDriver(key, forge, (forgeRepoId) =>
        this.branchCache.get(`${key}:${forgeRepoId}`),
      );
    } else if (forge.type === 'git') {
      driver = new GitDriver(key, forge);
    } else {
      this.log.warn('forge type has no driver yet', { forge: key, type: forge.type });
      return null;
    }

    this.drivers.set(key, { builtFrom, driver });
    return driver;
  }

  /** Look up driver for the forge a repo belongs to */
  async driverForRepo(repo: Repo): Promise<ForgeDriver | null> {
    const forge = await Forge.findByPk(repo.forge_id);
    return forge ? this.driver(forge.key) : null;
  }

  async forgeRowByKey(tenantId: string, key: string): Promise<Forge | null> {
    return Forge.findOne({ where: { tenant_id: tenantId, key } });
  }

  /** Load the tracked branch for every repo and cache it by forge key */
  async loadTrackedBranches(): Promise<void> {
    const rows = await getSequelize().query<{ key: string; forge_repo_id: string; branch: string }>(
      `SELECT f.key, r.forge_repo_id, r.branch FROM repos r JOIN forges f ON f.id = r.forge_id`,
      { type: QueryTypes.SELECT },
    );
    this.branchCache = new Map(
      rows.filter((r) => r.branch).map((r) => [`${r.key}:${r.forge_repo_id}`, r.branch]),
    );
  }

  /**
   * Return a RemoteRepo for the given Repo row
   *
   * Fetches live data from the forge driver first; falls back to the row columns
   * when the forge reports nothing (e.g. a deleted remote repo)
   */
  async remoteRepoFor(repo: Repo): Promise<RemoteRepo | null> {
    const driver = await this.driverForRepo(repo);
    if (!driver) return null;
    const installation = repo.installation_id
      ? await Installation.findByPk(repo.installation_id)
      : null;

    const fresh = await driver.getRepo(repo.forge_repo_id, installation?.forge_installation_id);
    if (fresh) return fresh;

    return {
      forgeRepoId: repo.forge_repo_id,
      namespace: repo.namespace,
      namespaceId: repo.namespace_id ?? '',
      name: repo.slug,
      defaultBranch: repo.branch || 'main',
      private: true,
      archived: false,
      installationId: installation?.forge_installation_id,
    };
  }

  async directoryFor(_forgeKey: string): Promise<DirectoryLookup | undefined> {
    return createDirectoryLookup(this.config);
  }
}

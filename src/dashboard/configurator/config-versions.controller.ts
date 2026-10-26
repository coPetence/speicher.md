/**
 * The saved versions of the instance config: the history, restoring one, and repairing the newest
 *
 * Restoring and repairing save a new version, so both need the config source to be `database`
 */
import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { callerOf } from '../../auth/caller.middleware';
import { ResolvedCaller } from '../../authz/caller';
import { ConfigError, ConfigReadOnlyError } from '../../common/errors';
import { ConfigService } from '../../config/config.service';
import {
  ConfigVersion,
  configVersionAt,
  getNewestConfigVersion,
  listConfigVersions,
  saveInstanceConfig,
} from '../../config/loader';
import { repairInstanceConfig } from '../../config/repair';
import { ConfigWatcher } from '../../config/watcher';
import { DashboardResponder, wantsJson } from '../respond';
import {
  HistoryPayload,
  sendConfigHistory,
  summarise,
} from '../ui/views/config-history/config-history';
import { diffConfigVersions } from './config-form/diff';
import { pickVersion, redirectTo } from './config-http';
import { provenanceOf } from './config-page/save';
import { RepairPreview, previewRepair } from './repair-preview';

@Controller('-')
export class ConfigVersionsController {
  constructor(
    private readonly config: ConfigService,
    private readonly watcher: ConfigWatcher,
    private readonly respond: DashboardResponder,
  ) {}

  /** Version history page with optional diff between two versions */
  @Get('config/history')
  async configHistory(
    @Req() req: Request,
    @Res() res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('restored') restored?: string,
  ): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const versions = await listConfigVersions(caller.tenantId);
    const running = this.config.configVersion;

    const toVersion = pickVersion(to, versions[0]?.version ?? null);
    const fromVersion = pickVersion(from, versionBefore(versions, toVersion) ?? toVersion);

    const left = fromVersion === null ? null : await configVersionAt(caller.tenantId, fromVersion);
    const right = toVersion === null ? null : await configVersionAt(caller.tenantId, toVersion);

    this.historyAnswer(req, res, caller, {
      running_version: running,
      from: left?.version ?? null,
      to: right?.version ?? null,
      diff: left && right ? diffConfigVersions(left.yaml, right.yaml) : null,
      restored: pickVersion(restored, null),
      error: null,
      problems: [],
      versions: versions.map((version) =>
        summarise(version, running, this.config.skippedConfigVersions),
      ),
      skipped: this.config.skippedConfigVersions,
      repair: await this.repairOfNewest(caller.tenantId),
    });
  }

  /** Restore a previous config version from history */
  @Post('config/restore')
  async restoreConfig(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { version?: unknown },
  ): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const version = pickVersion(body?.version, null);
    const source = version === null ? null : await configVersionAt(caller.tenantId, version);
    if (!source) return this.respond.notFound(req, res);

    try {
      const saved = await saveInstanceConfig(caller.tenantId, source.yaml, provenanceOf(caller));
      await this.watcher.refresh();

      if (wantsJson(req)) {
        res.setHeader('Vary', 'Accept');
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(200).json({ restored: source.version, saved: saved.version });
        return;
      }
      // Redirect back to history so the user sees the restored version highlighted
      return redirectTo(res, `/-/config/history?restored=${source.version}`);
    } catch (err) {
      if (err instanceof ConfigReadOnlyError || err instanceof ConfigError) {
        return this.historyAnswer(
          req,
          res,
          caller,
          await this.failedHistory(
            caller.tenantId,
            err.message.split('\n')[0],
            err instanceof ConfigError ? err.problems : [],
          ),
          409,
        );
      }
      throw err;
    }
  }

  /** Save the repaired version as a new version */
  @Post('config/repair')
  async repairConfig(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { version?: unknown },
  ): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const broken = await this.brokenNewest(caller.tenantId);
    if (!broken || broken.version !== pickVersion(body?.version, null)) {
      return redirectTo(res, '/-/config/history');
    }

    try {
      const repaired = repairInstanceConfig(broken.yaml);
      if (repaired.remaining.length > 0) {
        return this.historyAnswer(
          req,
          res,
          caller,
          await this.failedHistory(
            caller.tenantId,
            `Version ${broken.version} cannot be repaired.`,
            repaired.remaining,
          ),
          409,
        );
      }
      const saved = await saveInstanceConfig(caller.tenantId, repaired.yaml, provenanceOf(caller));
      await this.watcher.refresh();

      if (wantsJson(req)) {
        res.setHeader('Vary', 'Accept');
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(200).json({ repaired: broken.version, saved: saved.version });
        return;
      }
      return redirectTo(res, `/-/config/history?from=${broken.version}&to=${saved.version}`);
    } catch (err) {
      if (err instanceof ConfigReadOnlyError || err instanceof ConfigError) {
        return this.historyAnswer(
          req,
          res,
          caller,
          await this.failedHistory(
            caller.tenantId,
            err.message.split('\n')[0],
            err instanceof ConfigError ? err.problems : [],
          ),
          409,
        );
      }
      throw err;
    }
  }

  /** The newest saved version when it does not load, null otherwise */
  private async brokenNewest(tenantId: string): Promise<{ version: number; yaml: string } | null> {
    if (this.config.configSource !== 'database') return null;
    const newest = await getNewestConfigVersion(tenantId);
    return newest &&
      this.config.skippedConfigVersions.some((skip) => skip.version === newest.version)
      ? newest
      : null;
  }

  private async repairOfNewest(tenantId: string): Promise<RepairPreview | null> {
    const broken = await this.brokenNewest(tenantId);
    return broken ? previewRepair(broken.yaml) : null;
  }

  /** The history page with the reason a restore or a repair failed */
  private async failedHistory(
    tenantId: string,
    error: string,
    problems: string[],
  ): Promise<HistoryPayload> {
    const versions = await listConfigVersions(tenantId);
    return {
      running_version: this.config.configVersion,
      from: null,
      to: null,
      diff: null,
      restored: null,
      error,
      problems,
      versions: versions.map((v) =>
        summarise(v, this.config.configVersion, this.config.skippedConfigVersions),
      ),
      skipped: this.config.skippedConfigVersions,
      repair: await this.repairOfNewest(tenantId),
    };
  }

  private historyAnswer(
    req: Request,
    res: Response,
    caller: ResolvedCaller,
    payload: HistoryPayload,
    status?: number,
  ): void {
    sendConfigHistory(
      this.respond,
      req,
      res,
      caller.isAdmin,
      payload,
      this.config.configSource === 'database',
      status,
    );
  }
}

/** Find the version immediately before the given one in the list */
function versionBefore(versions: ConfigVersion[], version: number | null): number | null {
  if (version === null) return null;
  const index = versions.findIndex((v) => v.version === version);
  return index === -1 ? null : (versions[index + 1]?.version ?? null);
}

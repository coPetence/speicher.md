/**
 * Inbound webhooks from forge providers
 *
 * A single POST route receives deliveries from GitHub, GitLab, Bitbucket etc
 * The route is behind a per-tenant suffix so each tenant reaches its own endpoint
 * Signature verification happens before tenant resolution to fail fast on bad
 * deliveries
 * Duplicate deliveries are detected via a PostgreSQL upsert with a time window
 *
 * Not 200 to avoid webhook-retry from long call chains
 */

import { Controller, Headers, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { QueryTypes } from 'sequelize';

import { Logger, rootLogger } from '../common/logger';
import { Repo, initModels } from '../db/models';
import { getSequelize } from '../db/sequelize';
import { TenancyService } from '../db/tenancy';
import { JobQueue } from '../jobs/queue';
import { ForgeAction, ForgeDriver } from './driver';
import { ForgeRegistry } from './registry';
import { readSignedDelivery } from '../webhooks/signed-delivery';
import { FORGE_WEBHOOK_PREFIX, WEBHOOK_ROUTE } from '../webhooks/webhook-url';

export const DELIVERY_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

@Controller(WEBHOOK_ROUTE)
export class WebhookController {
  private readonly log: Logger = rootLogger.child('webhook');

  constructor(
    private readonly forges: ForgeRegistry,
    private readonly queue: JobQueue,
    private readonly tenancy: TenancyService,
  ) {
    initModels();
  }

  @Post(`${FORGE_WEBHOOK_PREFIX}/:forge`)
  @HttpCode(202)
  async receive(
    @Param('forge') forgeKey: string,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<void> {
    const driver = this.forges.driver(forgeKey);

    if (!driver || !driver.acceptsWebhooks) {
      res.status(404).end();
      return;
    }

    const delivery = readSignedDelivery(
      req,
      res,
      headers,
      (h, body) => driver.verifyWebhook(h, body),
      this.log,
      { forge: forgeKey },
    );
    if (!delivery) return;
    const { verification, payload } = delivery;

    const tenant = await this.tenancy.resolveTenant(req);
    const forgeRow = await this.forges.forgeRowByKey(tenant.id, forgeKey);
    if (!forgeRow) {
      res.status(404).end();
      return;
    }

    if (verification.deliveryId) {
      const [existing] = await getSequelize().query<{ delivery_id: string }>(
        `INSERT INTO webhook_deliveries (forge_id, delivery_id, event)
         VALUES (:forgeId, :deliveryId, :event)
         ON CONFLICT (forge_id, delivery_id) DO UPDATE
           SET received_at = now(), event = EXCLUDED.event
           WHERE webhook_deliveries.received_at
                 < now() - make_interval(secs => :windowSeconds)
         RETURNING delivery_id`,
        {
          type: QueryTypes.SELECT,
          replacements: {
            forgeId: forgeRow.id,
            deliveryId: verification.deliveryId,
            event: verification.event,
            windowSeconds: DELIVERY_DEDUPE_WINDOW_MS / 1000,
          },
        },
      );
      if (!existing) {
        // Duplicate within the dedupe window: the WHERE clause prevented
        // the row from being returned, so the delivery was already processed
        this.log.info('duplicate delivery ignored', {
          forge: forgeKey,
          delivery_id: verification.deliveryId,
          event: verification.event,
        });
        res.status(202).end();
        return;
      }
    }

    res.status(202).end();

    const actions = driver.mapEvent(verification.event ?? '', payload);

    if (actions.every((action) => action.kind === 'ignore')) {
      this.log.info('delivery produced no actions', {
        forge: forgeKey,
        event: verification.event,
        delivery_id: verification.deliveryId,
        reasons: actions.map((action) => (action.kind === 'ignore' ? action.reason : '')),
      });
    }
    for (const action of actions) {
      await this.dispatch(tenant.id, forgeKey, forgeRow.id, driver, action).catch((err) => {
        this.log.error('could not enqueue action', {
          kind: action.kind,
          error: (err as Error).message,
        });
      });
    }
  }

  private async dispatch(
    tenantId: string,
    forgeKey: string,
    forgeId: string,
    driver: ForgeDriver,
    action: ForgeAction,
  ): Promise<void> {
    switch (action.kind) {
      case 'sync': {
        const repo = await this.repoFor(tenantId, forgeId, action.forgeRepoId);
        // Repo not yet discovered: schedule a discovery pass
        if (!repo) return this.discoverAfterMiss(tenantId, forgeKey, driver, action.forgeRepoId);

        await this.queue.enqueue({
          tenantId,
          kind: 'sync-repo-content',
          payload: { repoId: repo.id, trigger: 'webhook' },
          dedupeKey: `sync-repo-content:${repo.id}`,
          runAfterMs: 5_000,
        });
        return;
      }

      case 'validate-pr': {
        const repo = await this.repoFor(tenantId, forgeId, action.forgeRepoId);
        if (!repo) return;
        await this.queue.enqueue({
          tenantId,
          kind: 'validate-pr',
          payload: { repoId: repo.id, sha: action.sha, prNumber: String(action.prNumber) },
          dedupeKey: `validate-pr:${repo.id}:${action.prNumber}`,
        });
        return;
      }

      case 'rename': {
        const repo = await this.repoFor(tenantId, forgeId, action.forgeRepoId);
        if (!repo) return;
        await this.queue.enqueue({
          tenantId,
          kind: 'rename',
          payload: { repoId: repo.id, newSlug: action.newName },
        });
        return;
      }

      case 'purge': {
        const repo = await this.repoFor(tenantId, forgeId, action.forgeRepoId);
        if (!repo) return;
        // Reason comes from the forge's own event payload (e.g. repo deleted)
        await this.queue.enqueue({
          tenantId,
          kind: 'purge',
          payload: { repoId: repo.id, reason: action.reason },
        });
        return;
      }

      case 'discover':
        await this.queue.enqueue({
          tenantId,
          kind: 'sync-repo-list',
          payload: { installationId: action.installationId, forgeKey },
          dedupeKey: `sync-repo-list:${action.installationId}`,
        });
        return;

      case 'purge-installation': {
        const repos = await getSequelize().query<{ id: string }>(
          `SELECT r.id FROM repos r
             JOIN installations i ON i.id = r.installation_id
            WHERE i.forge_installation_id = :installationId AND r.tenant_id = :tenantId`,
          {
            type: QueryTypes.SELECT,
            replacements: { installationId: action.installationId, tenantId },
          },
        );
        for (const repo of repos) {
          await this.queue.enqueue({
            tenantId,
            kind: 'purge',
            payload: {
              repoId: repo.id,
              reason: 'The forge installation this repository belongs to was removed.',
            },
          });
        }
        return;
      }

      case 'ignore':
        this.log.debug('ignored delivery', { reason: action.reason });
        return;
    }
  }

  private async discoverAfterMiss(
    tenantId: string,
    forgeKey: string,
    driver: ForgeDriver,
    forgeRepoId: string,
  ): Promise<void> {
    if (!driver.hasInstallations) return;
    this.log.info('delivery named an unregistered repository; discovering', {
      forge: forgeKey,
      forge_repo_id: forgeRepoId,
    });
    await this.queue.enqueue({
      tenantId,
      kind: 'sync-repo-list',
      payload: { forgeKey },
      dedupeKey: `sync-repo-list:${forgeKey}`,
    });
  }

  private async repoFor(
    tenantId: string,
    forgeId: string,
    forgeRepoId: string,
  ): Promise<Repo | null> {
    return Repo.findOne({
      where: { tenant_id: tenantId, forge_id: forgeId, forge_repo_id: forgeRepoId },
    });
  }
}

/**
 * Webhook deliveries from the directory App of a GitHub identity provider
 */

import { Controller, Headers, Param, Post, Req, Res } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Op } from 'sequelize';

import { Logger, rootLogger } from '../../common/logger';
import { ConfigService } from '../../config/config.service';
import { GithubProviderConfig, providerType } from '../../config/types';
import { OauthGrant, Session, initModels } from '../../db/models';
import { TenancyService } from '../../db/tenancy';
import { verifyGithubSignature } from '../../forge/github/webhook';
import { readSignedDelivery } from '../../webhooks/signed-delivery';
import { DIRECTORY_WEBHOOK_PREFIX, WEBHOOK_ROUTE } from '../../webhooks/webhook-url';

export type StaleSessions = { subject: string } | 'all' | null;

/**
 * staleSessionsOf returns whose groups a directory delivery may have changed.
 *
 * @param event the delivery's `X-GitHub-Event`
 * @param payload the delivery's body
 */
export function staleSessionsOf(event: string, payload: Record<string, unknown>): StaleSessions {
  const idOf = (user: unknown): string | null => {
    const id = (user as { id?: unknown } | null | undefined)?.id;
    return typeof id === 'number' ? String(id) : null;
  };

  switch (event) {
    case 'membership': {
      const subject = idOf(payload.member);
      return subject ? { subject } : 'all';
    }
    case 'organization': {
      const subject = idOf((payload.membership as { user?: unknown } | undefined)?.user);
      return subject ? { subject } : 'all';
    }
    case 'team':
      return 'all';
    default:
      return null;
  }
}

@Controller(WEBHOOK_ROUTE)
export class DirectoryWebhookController {
  private readonly log: Logger = rootLogger.child('webhook.directory');

  constructor(
    private readonly config: ConfigService,
    private readonly tenancy: TenancyService,
  ) {
    initModels();
  }

  @Post(`${DIRECTORY_WEBHOOK_PREFIX}/:provider`)
  async receive(
    @Param('provider') providerId: string,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<void> {
    const provider = this.config.provider(providerId);
    const directory =
      provider && providerType(provider) === 'github'
        ? (provider as GithubProviderConfig).directory
        : undefined;
    if (directory?.type !== 'github') {
      res.status(404).end();
      return;
    }

    const delivery = readSignedDelivery(
      req,
      res,
      headers,
      (h, body) => verifyGithubSignature(h, body, directory.webhook_secret ?? ''),
      this.log,
      { provider: providerId },
    );
    if (!delivery) return;
    const { verification, payload } = delivery;

    const stale = staleSessionsOf(verification.event ?? '', payload);
    if (stale === null) {
      res.status(202).end();
      return;
    }

    const tenant = await this.tenancy.resolveTenant(req);
    const tenantInfo = {
      tenant_id: tenant.id,
      provider: providerId,
      ...(stale === 'all' ? {} : { subject: stale.subject }),
    };
    const [count] = await Session.update({ groups_fetched_at: null }, { where: tenantInfo });
    // Expiring the access token makes the client refresh, which re-reads the groups
    const [connections] = await OauthGrant.update(
      { access_expires_at: new Date() },
      { where: { ...tenantInfo, revoked_at: { [Op.is]: null } } },
    );
    this.log.info('groups marked stale', {
      provider: providerId,
      event: verification.event,
      scope: stale === 'all' ? 'all' : 'one person',
      sessions: count,
      connections,
    });
    res.status(202).end();
  }
}

/**
 * Admin page listing OAuth grants and API keys for the current caller
 *
 * A user can see which applications they have authorised and which API keys they hold,
 * and revoke any of them
 *
 * The route is mounted at `/-/connections`
 */
import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { ApiKeyService } from '../auth/api-key.service';
import { OauthService } from '../auth/oauth/oauth.service';
import { callerOf } from '../auth/caller.middleware';
import { subjectPrincipal } from '../common/principals';
import { ConfigService } from '../config/config.service';
import { sendConnections } from './ui/views/connections/connections';
import { DashboardResponder } from './respond';

@Controller('-')
export class ConnectionsController {
  private readonly respond: DashboardResponder;

  constructor(
    config: ConfigService,
    private readonly oauth: OauthService,
    private readonly apiKeys: ApiKeyService,
  ) {
    this.respond = new DashboardResponder(config);
  }

  /**
   * List OAuth grants and API keys for the caller
   *
   * Accepts a `revoked` query param that controls whether the page shows a success
   * banner after revoking a grant or key
   */
  @Get('connections')
  async connections(
    @Req() req: Request,
    @Res() res: Response,
    @Query('revoked') revoked?: string,
  ): Promise<void> {
    const caller = callerOf(req);
    if (caller.identity === null) return this.respond.notFound(req, res);
    const principal = subjectPrincipal(caller.identity.provider, caller.identity.subject);

    const [grants, keys] = await Promise.all([
      this.oauth.listFor(caller.tenantId, principal),
      this.apiKeys.listFor(caller.tenantId, principal),
    ]);

    sendConnections(
      this.respond,
      req,
      res,
      caller.isAdmin,
      {
        // `created_at` is a zero-date column alias; fetched via `get()` to skip type
        // narrowing
        connections: grants.map((row) => ({
          id: row.id,
          client_id: row.client_id,
          client_name: row.client_name,
          connected_at: row.get('created_at') as Date,
          last_used_at: row.last_used_at,
          expires_at: row.refresh_expires_at,
        })),
        api_keys: keys.map((row) => ({
          id: row.id,
          name: row.name,
          last_used_at: row.last_used_at,
          expires_at: row.expires_at,
        })),
      },
      revoked !== undefined,
    );
  }

  /**
   * Revoke an OAuth grant or API key by ID
   *
   * `body.id` revokes an OAuth grant, `body.key_id` revokes an API key
   * Redirects back to the connections page with `?revoked=1`
   */
  @Post('connections/revoke')
  async revoke(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: Record<string, string>,
  ): Promise<void> {
    const caller = callerOf(req);
    if (caller.identity === null) return this.respond.notFound(req, res);
    const principal = subjectPrincipal(caller.identity.provider, caller.identity.subject);

    if (body.id) {
      await this.oauth.revoke(caller.tenantId, principal, body.id);
    } else if (body.key_id) {
      await this.apiKeys.revokeFor(caller.tenantId, principal, body.key_id);
    }

    res.redirect(303, '/-/connections?revoked=1');
  }
}

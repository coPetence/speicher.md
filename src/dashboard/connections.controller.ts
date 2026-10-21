/**
 * Page listing the OAuth grants of the current caller
 *
 * A user can see which applications they have authorised and disconnect any of them
 *
 * The route is mounted at `/-/connections`
 */
import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

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
  ) {
    this.respond = new DashboardResponder(config);
  }

  /**
   * List OAuth grants for the caller
   *
   * Accepts a `revoked` query param that controls whether the page shows a success
   * banner after revoking a grant
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

    const grants = await this.oauth.listFor(caller.tenantId, principal);

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
      },
      revoked !== undefined,
    );
  }

  /**
   * Revoke an OAuth grant by `body.id`
   *
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

    if (body.id) await this.oauth.revoke(caller.tenantId, principal, body.id);

    res.redirect(303, '/-/connections?revoked=1');
  }
}

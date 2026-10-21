import type { Request, Response } from 'express';

import { DashboardResponder } from '../../../respond';
import { isoOf, relativeTime } from '../../../../common/time';
import { renderTemplate } from '../../../../content-reader/views';

/** The caller's OAuth grants, to JSON callers and the page alike */
export interface ConnectionsPayload {
  connections: {
    id: string;
    client_id: string;
    client_name: string | null;
    connected_at: Date;
    last_used_at: Date | null;
    expires_at: Date | null;
  }[];
}

/** Sends the caller's connected applications */
export function sendConnections(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  payload: ConnectionsPayload,
  revoked: boolean,
): void {
  respond.send(req, res, isAdmin, {
    section: 'connections',
    title: 'Connected applications',
    payload,
    page: (data) =>
      renderTemplate('dashboard/ui/views/connections', {
        revoked,
        grants: data.connections.map((row) => ({
          id: row.id,
          // Fall back to client_id when no human-readable name was registered
          name: row.client_name ?? row.client_id,
          connected: relativeTime(row.connected_at),
          connectedAt: isoOf(row.connected_at),
          lastUsed: row.last_used_at ? relativeTime(row.last_used_at) : null,
          expires: row.expires_at ? relativeTime(row.expires_at) : null,
        })),
      }),
  });
}

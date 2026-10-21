import type { Request, Response } from 'express';

import { DashboardResponder } from '../../../respond';
import { isoOf, relativeTime, timeUntil } from '../../../../common/time';
import { renderInlineIcon } from '../../../../content-reader/icons';
import { renderTemplate } from '../../../../content-reader/views';
import { clientMark } from '../../../../auth/oauth/client-marks';
import { markSprite, renderMarkRef } from '../../provider-marks';

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
    page: (data) => {
      const marks = data.connections.map((row) => clientMark(row.client_id, row.client_name));
      return renderTemplate('dashboard/ui/views/connections', {
        revoked,
        grants: data.connections.map((row, i) => ({
          id: row.id,
          // Fall back to client_id when no human-readable name was registered
          name: row.client_name ?? row.client_id,
          markHtml: renderMarkRef(marks[i] ?? ''),
          connected: relativeTime(row.connected_at),
          connectedAt: isoOf(row.connected_at),
          lastUsed: row.last_used_at ? relativeTime(row.last_used_at) : null,
          expires: row.expires_at ? timeUntil(row.expires_at) : null,
        })),
        disconnect_icon: renderInlineIcon('unplug', 'spr-icon'),
        marks_sprite: markSprite(marks.filter((mark): mark is string => mark !== null)),
      });
    },
  });
}

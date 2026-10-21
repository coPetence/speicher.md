import type { Request, Response } from 'express';

import { DashboardResponder } from '../../../respond';
import { isoOf, relativeTime } from '../../../../common/time';
import { renderTemplate } from '../../../../content-reader/views';
import { markSprite, renderMarkRef } from '../../provider-marks';

const CLIENT_MARKS: { mark: string; hosts: string[]; name: RegExp }[] = [
  { mark: 'claude', hosts: ['claude.ai', 'anthropic.com'], name: /\bclaude\b/i },
  { mark: 'openai', hosts: ['openai.com', 'chatgpt.com'], name: /\b(chatgpt|openai|codex)\b/i },
  { mark: 'gemini', hosts: ['gemini.google.com'], name: /\bgemini\b/i },
  { mark: 'copilot', hosts: ['copilot.microsoft.com', 'githubcopilot.com'], name: /\bcopilot\b/i },
  { mark: 'azureai', hosts: ['ai.azure.com'], name: /\b(azure ai|ai foundry|azure foundry)\b/i },
  { mark: 'grok', hosts: ['x.ai', 'grok.com'], name: /\b(grok|xai)\b/i },
  { mark: 'perplexity', hosts: ['perplexity.ai'], name: /\bperplexity\b/i },
];

export function clientMark(clientId: string, clientName: string | null): string | null {
  let host = '';
  try {
    host = new URL(clientId).hostname.toLowerCase();
  } catch {
    // Not a URL
  }
  const byHost = CLIENT_MARKS.find(({ hosts }) =>
    hosts.some((known) => host === known || host.endsWith(`.${known}`)),
  );
  if (byHost) return byHost.mark;
  return CLIENT_MARKS.find(({ name }) => name.test(clientName ?? ''))?.mark ?? null;
}

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
          expires: row.expires_at ? relativeTime(row.expires_at) : null,
        })),
        marks_sprite: markSprite(marks.filter((mark): mark is string => mark !== null)),
      });
    },
  });
}

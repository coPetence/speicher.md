import type { Request, Response } from 'express';

import { DashboardResponder } from '../../../respond';
import { CascadeLevel, ExplainResult } from '../../../../authz/explain';
import { renderInlineIcon } from '../../../../content-reader/icons';
import { renderTemplate } from '../../../../content-reader/views';

/** Sends the explain form, or the result page for a resolved path */
export function sendExplain(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  asked: string,
  result: ExplainResult | null,
): void {
  respond.send(req, res, isAdmin, {
    section: 'explain',
    title: 'Path Access Check',
    payload: result,
    page: (payload) =>
      renderTemplate('dashboard/ui/views/path-access-check', {
        path: asked,

        external_mark: renderInlineIcon('external-link', 'spr-external'),
        result: payload && {
          found: payload.found,
          kind: payload.kind,
          slugPath: payload.slug_path,
          principals: payload.effective_principals,

          indexable: payload.indexable,
          chain: payload.chain.map((level: CascadeLevel) => ({
            source: level.source,
            groups: level.access?.groups ?? [],
            principals: level.resolved_principals,
            indexable: level.indexable ?? null,
            notes: level.notes ?? [],
          })),
          droppedGrants: payload.dropped_grants,

          groupSizes: payload.groups
            ? payload.groups.map((group) => ({
                name: group.name,
                size: group.size === null ? 'unknown' : String(group.size),
                directoryUrl: group.directory_url,
              }))
            : null,
        },
      }),
  });
}

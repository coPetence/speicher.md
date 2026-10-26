import type { Request, Response } from 'express';

import { ResolvedCaller } from '../../authz/caller';
import { ConfigService } from '../../config/config.service';
import { DashboardResponder } from '../respond';
import { sendConfigSection } from '../ui/views/config-section/config-section';
import { ConfigSectionPayload } from './config-page/payloads';

/** Safely parse a version number from a query string or body value */
export function pickVersion(raw: unknown, fallback: number | null): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return fallback;
  const text = String(raw).trim();
  if (text === '') return fallback;
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Sends the browser on with a 303 */
export function redirectTo(res: Response, href: string): void {
  res.setHeader('Vary', 'Accept');
  res.setHeader('Cache-Control', 'private, no-store');
  res.redirect(303, href);
}

/** Sends a section or member page */
export function sendSection(
  respond: DashboardResponder,
  config: ConfigService,
  req: Request,
  res: Response,
  caller: ResolvedCaller,
  sectionId: string,
  payload: ConfigSectionPayload,
  status?: number,
): void {
  sendConfigSection(
    respond,
    req,
    res,
    caller.isAdmin,
    sectionId,
    payload,
    config.hasAdministrator,
    status,
  );
}

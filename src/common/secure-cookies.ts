import type { Request } from 'express';

import { env, instanceUrl } from './env';

/** Whether cookies set for this request get the Secure flag */
export function secureCookies(req: Request): boolean {
  if (env('SPEICHER_INSECURE_COOKIES')) return false;
  return req.secure || instanceUrl()?.protocol === 'https:';
}

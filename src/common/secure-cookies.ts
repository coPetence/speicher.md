import type { Request } from 'express';

import { env, instanceUrl } from './env';

/** Whether cookies set for this request get the Secure flag */
export function secureCookies(req: Request): boolean {
  if (env('SPEICHER_INSECURE_COOKIES')) return false;
  return req.secure || instanceUrl()?.protocol === 'https:' || browserUsesHttps(req);
}

/** Whether any header says the browser reached this instance over HTTPS, whoever sent it */
function browserUsesHttps(req: Request): boolean {
  const header = (name: string) => (req.get(name) ?? '').toLowerCase();
  return (
    header('X-Forwarded-Proto')
      .split(',')
      .some((proto) => proto.trim() === 'https') ||
    /(?:^|[;,])\s*proto="?https"?\s*(?:[;,]|$)/.test(header('Forwarded')) ||
    header('X-Forwarded-Ssl') === 'on' ||
    header('Origin').startsWith('https://') ||
    header('Referer').startsWith('https://')
  );
}

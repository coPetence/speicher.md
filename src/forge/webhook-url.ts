import { env } from '../common/env';

/**
 * Path segment used as the NestJS controller prefix for incoming webhooks
 */
export const WEBHOOK_ROUTE = '-/hooks';

/**
 * Server-relative path for a forge's webhook endpoint
 */
export function webhookPath(forgeKey: string): string {
  return `/${WEBHOOK_ROUTE}/${encodeURIComponent(forgeKey)}`;
}

/**
 * Absolute webhook URL for the given forge
 *
 * Returns null when `SPEICHER_PUBLIC_URL` is unset, because the origin
 * cannot be reliably taken from the request
 */
export function webhookUrl(forgeKey: string): string | null {
  return absolute(webhookPath(forgeKey));
}

/**
 * Server-relative path for the webhook of an identity provider's directory App
 */
export function directoryWebhookPath(providerId: string): string {
  return `/${WEBHOOK_ROUTE}/directory/${encodeURIComponent(providerId)}`;
}

/**
 * Absolute webhook URL for an identity provider's directory App
 *
 * Returns null when `SPEICHER_PUBLIC_URL` is unset
 */
export function directoryWebhookUrl(providerId: string): string | null {
  return absolute(directoryWebhookPath(providerId));
}

function absolute(path: string): string | null {
  const declared = env('SPEICHER_PUBLIC_URL');
  if (!declared) return null;
  const base = declared.replace(/\/+$/, '');
  return base === '' ? null : `${base}${path}`;
}

import { webhookReach } from '../../../../common/public-url';
import type { CopyValueItem } from '../config-fields';
import { copyValue } from '../config-fields';

export interface WebhookWording {
  subject: string;
  app: string;
  without: string;
  events: string;
  secretLabel: string;
}

export function webhookNote(url: string, baseUrl: string, wording: WebhookWording): string {
  const reach = webhookReach(url, baseUrl);
  if (reach === 'refused') {
    return `Speicher will create the App without a webhook, because GitHub does not accept a webhook on localhost. Without a webhook, ${wording.without}.`;
  }
  if (reach === 'uncertain') {
    return `GitHub may not be able to reach the address of this instance, because it points to a private network or is not known yet. If GitHub cannot reach it, ${wording.without}.`;
  }
  return '';
}

export function noWebhookSecretNote(wording: WebhookWording): string {
  const subscribe = wording.events ? `, subscribe it to ${wording.events}` : '';
  return `This ${wording.subject} has no webhook secret, so it accepts no webhook deliveries from GitHub, and ${wording.without}. To receive changes right away, add a webhook with a secret in the settings of ${wording.app}${subscribe}, and enter the same secret under ${wording.secretLabel}.`;
}

export function webhookUrlItem(
  label: string,
  url: string | null,
  path: string,
  wording: WebhookWording,
): CopyValueItem {
  return copyValue(
    label,
    url ?? path,
    `Enter this as the **Webhook URL** in the settings of ${wording.app}. If only a path without a host is shown, put the address of this instance in front of it.`,
    { startsRow: false, wide: true },
  );
}

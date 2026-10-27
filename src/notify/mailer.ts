/**
 * Outgoing email via SMTP
 *
 * Admin health probe and transport cache refreshed on config changes
 * Failed messages are logged and dropped without retry
 */

import { Injectable } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';

import { instanceUrl } from '../common/env';
import { reasonOf } from '../common/errors';
import { Logger, rootLogger } from '../common/logger';
import { ConfigService } from '../config/config.service';
import { stableStringify } from '../config/resolution-hash';
import { MailConfig } from '../config/types';
import { CheckStatus } from '../common/check-status';

/** SMTP probe result */
export type MailStatus = CheckStatus<
  'mail.connected' | 'mail.unreachable' | 'mail.starttls-stalled'
> & {
  level: 'ok' | 'fail';
};

const PROBE_TIMEOUT_MS = 3_000;

/** Track STARTTLS progress without retaining log messages */
function upgradeWatch() {
  const seen = { asked: false, upgraded: false };
  const note = (_meta: unknown, message: unknown): void => {
    if (message === 'STARTTLS') seen.asked = true;
    else if (message === 'Connection upgraded with STARTTLS') seen.upgraded = true;
  };
  const ignore = (): void => undefined;
  return {
    seen,
    logger: {
      level: ignore,
      trace: ignore,
      debug: note,
      info: note,
      warn: ignore,
      error: ignore,
      fatal: ignore,
    },
  };
}

/** Use the username if it's an email, otherwise noreply on the public host */
export function defaultMailFrom(
  brand: string,
  username: string | undefined,
): { name: string; address: string } {
  const address = username?.includes('@')
    ? username
    : `noreply@${instanceUrl()?.hostname || 'localhost'}`;
  return { name: brand, address };
}

export async function probeMail(mail: MailConfig): Promise<MailStatus> {
  // Test the supplied config without using the cache
  const port = mail.port ?? 587;
  const upgrade = upgradeWatch();
  const transporter = nodemailer.createTransport({
    host: mail.host,
    port,
    secure: port === 465,
    auth: mail.username ? { user: mail.username, pass: mail.password ?? '' } : undefined,
    // Enable command logs for STARTTLS tracking; discard messages
    logger: upgrade.logger,
    debug: true,
    connectionTimeout: PROBE_TIMEOUT_MS,
    greetingTimeout: PROBE_TIMEOUT_MS,
    socketTimeout: PROBE_TIMEOUT_MS,
  });

  const where = `${mail.host}:${port}`;
  try {
    await transporter.verify();
    return {
      code: 'mail.connected',
      level: 'ok',
      label: mail.username ? 'Connected and signed in' : 'Connected',
      detail: mail.username ? `${where} as ${mail.username}` : where,
      facts: {
        server: where,
        signedIn: Boolean(mail.username),
        ...(mail.username ? { user: mail.username } : {}),
      },
    };
  } catch (err) {
    // A proxy or firewall may block STARTTLS; port 465 may work
    if (upgrade.seen.asked && !upgrade.seen.upgraded && isTimeout(err)) {
      return {
        code: 'mail.starttls-stalled',
        level: 'fail',
        label: 'Not connected',
        detail:
          `${where} (the switch to TLS after STARTTLS timed out. A proxy or firewall ` +
          `between here and the server may be blocking it; port 465 often works instead)`,
        facts: { server: where, reason: reasonOf(err), suggestedPort: 465 },
      };
    }
    // Report the connection failure without assuming bad credentials
    return {
      code: 'mail.unreachable',
      level: 'fail',
      label: 'Not connected',
      detail: `${where} (${reasonOf(err)})`,
      facts: { server: where, reason: reasonOf(err) },
    };
  } finally {
    // Release probe connections
    transporter.close();
  }
}

function isTimeout(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ETIMEDOUT';
}

@Injectable()
export class Mailer {
  private transporter: Transporter | null = null;
  // Detect transport config changes
  private transportKey: string | null = null;
  private readonly log: Logger = rootLogger.child('mail');
  private lastError: string | null = null;
  private lastSuccessAt: Date | null = null;

  constructor(private readonly config: ConfigService) {}

  get configured(): boolean {
    return this.config.hasMailTransport;
  }

  get health(): { configured: boolean; lastError: string | null; lastSuccessAt: Date | null } {
    return {
      configured: this.configured,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
    };
  }

  private transport(mail: MailConfig): Transporter {
    const port = mail.port ?? 587;
    const options = {
      host: mail.host,
      port,
      secure: port === 465,
      auth: mail.username ? { user: mail.username, pass: mail.password ?? '' } : undefined,
    };
    const key = stableStringify(options);
    if (this.transporter && this.transportKey === key) return this.transporter;
    this.transporter = nodemailer.createTransport(options);
    this.transportKey = key;
    return this.transporter;
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    const mail = this.config.instance.mail;
    if (!mail) {
      this.log.warn('mail is not configured; message dropped', { subject });
      return;
    }
    try {
      await this.transport(mail).sendMail({
        from: mail.from || defaultMailFrom(this.config.brand, mail.username),
        replyTo: mail.reply_to,
        to,
        subject,
        text,
      });
      this.lastSuccessAt = new Date();
      this.lastError = null;
    } catch (err) {
      this.lastError = (err as Error).message;
      // Log delivery failures without rethrowing
      this.log.error('could not send mail', { subject, error: this.lastError });
    }
  }
}

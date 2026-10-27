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

/** SMTP connection status */
export type MailStatus = CheckStatus<'mail.connected' | 'mail.unreachable'> & {
  level: 'ok' | 'fail';
};

const PROBE_TIMEOUT_MS = 3_000;

/**
 * Default sender: SMTP username if an email address, otherwise noreply on the public host
 */
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
  // Bypass the cache to test the supplied config
  const port = mail.port ?? 587;
  const transporter = nodemailer.createTransport({
    host: mail.host,
    port,
    secure: port === 465,
    auth: mail.username ? { user: mail.username, pass: mail.password ?? '' } : undefined,
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
    // Reason removed; write one: not 'fail' to avoid false negative when
    // credentials are valid but the SMTP server is unreachable temporarily
    return {
      code: 'mail.unreachable',
      level: 'fail',
      label: 'Not connected',
      detail: `${where} (${reasonOf(err)})`,
      facts: { server: where, reason: reasonOf(err) },
    };
  } finally {
    // Close the ephemeral transporter so connections do not leak on probe
    transporter.close();
  }
}

@Injectable()
export class Mailer {
  private transporter: Transporter | null = null;
  // Key to invalidate on config change
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

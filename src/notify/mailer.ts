/**
 * Outgoing email via SMTP
 *
 * Health probe for the admin UI
 * Caches the nodemailer transporter keyed by serialised config so config changes
 * rebuild the connection without a restart
 *
 * No queue: if sending fails the error is logged and the message dropped
 */

import { Injectable } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';

import { reasonOf } from '../common/errors';
import { Logger, rootLogger } from '../common/logger';
import { ConfigService } from '../config/config.service';
import { stableStringify } from '../config/resolution-hash';
import { MailConfig } from '../config/types';

export interface MailStatus {
  level: 'ok' | 'fail';
  label: string;
  detail: string;
}

const PROBE_TIMEOUT_MS = 3_000;

export async function probeMail(mail: MailConfig): Promise<MailStatus> {
  // Creates a fresh transporter so config is tested as-is, not from a cached one
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
      level: 'ok',
      label: mail.username ? 'Connected and signed in' : 'Connected',
      detail: mail.username ? `${where} as ${mail.username}` : where,
    };
  } catch (err) {
    // Reason removed; write one: not 'fail' to avoid false negative when
    // credentials are valid but the SMTP server is unreachable temporarily
    return { level: 'fail', label: 'Not connected', detail: `${where} (${reasonOf(err)})` };
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
        from: mail.from,
        replyTo: mail.reply_to,
        to,
        subject,
        text,
      });
      this.lastSuccessAt = new Date();
      this.lastError = null;
    } catch (err) {
      this.lastError = (err as Error).message;
      // Logged so the admin sees why delivery failed without a thrown exception
      this.log.error('could not send mail', { subject, error: this.lastError });
    }
  }
}

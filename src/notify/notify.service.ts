import { Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';

import { Logger, rootLogger } from '../common/logger';
import { parseDuration } from '../common/time';
import { emailPrincipal, parsePrincipal } from '../common/principals';
import { ConfigService } from '../config/config.service';
import { NotificationState, Repo, initModels } from '../db/models';
import { getSequelize } from '../db/sequelize';
import { SyncResult } from '../ingest/ingest.service';
import { RoutingService } from '../content-reader/routing';
import { Mailer } from './mailer';

/**
 * Notifications for sync failures, stale repos, and expiring grants
 *
 * Fires emails when a repo transitions to/from failure, when it has not run
 * past an interval, or when per-repo grants are about to expire
 *
 * Notification state is recorded in the DB so repeated sends are suppressed
 */
@Injectable()
export class NotifyService {
  private readonly log: Logger = rootLogger.child('notify');

  constructor(
    private readonly config: ConfigService,
    private readonly mailer: Mailer,
  ) {
    initModels();
  }

  /**
   * Send on state transition or daily reminder for a still-failed repo
   */
  async onSyncStateChange(
    repo: Repo,
    result: SyncResult,
    committerEmail: string | null,
    routing: RoutingService,
  ): Promise<void> {
    const state = result.status === 'ok' ? 'ok' : 'failed';
    const key = `sync:${repo.id}`;
    const previous = await NotificationState.findOne({
      where: { tenant_id: repo.tenant_id, kind: 'sync', subject_key: key },
    });

    const changed = previous?.last_state !== state;
    const reminderDue =
      state === 'failed' &&
      previous?.last_sent_at !== null &&
      previous?.last_sent_at !== undefined &&
      Date.now() - new Date(previous.last_sent_at).getTime() > 24 * 3600_000;

    await this.recordState(repo.tenant_id, 'sync', key, state, changed || reminderDue);
    if (!changed && !reminderDue) return;

    const targets = await this.resolveTargets(
      repo,
      this.config.notify.sync_failure ?? ['maintainers', 'committer'],
      committerEmail,
    );
    const base = routing.publicBaseFor({
      namespace: repo.namespace,
      slug: repo.slug,
      forge_key: '',
    });
    const subject =
      state === 'ok'
        ? `speicher — ${repo.slug} is syncing again`
        : `speicher — sync failed for ${repo.slug}`;

    const body =
      state === 'ok'
        ? `${repo.namespace}/${repo.slug} synced successfully.\n\nDetails: /-/status/${repo.namespace}/${repo.slug}\n`
        : `Sync failed for ${repo.namespace}/${repo.slug}.\n` +
          `The previous version is still being served.\n\n` +
          `Details: /-/status/${repo.namespace}/${repo.slug}\n` +
          `Content: ${base}\n`;

    for (const address of targets) await this.mailer.send(address, subject, body);
  }

  /**
   * Repos that missed their run window, notified once per period
   *
   * Threshold is max(configured grace, half the poll interval) so polling
   * repos get a cushion
   */
  async checkStaleRepos(tenantId: string): Promise<string[]> {
    const staleAfterMs = parseDuration(this.config.notify.stale_after ?? '6h');
    const rows = await getSequelize().query<{ id: string; namespace: string; slug: string }>(
      `SELECT id, namespace, slug FROM repos
        WHERE tenant_id = :tenantId AND has_config = true
          AND (last_run_at IS NULL OR last_run_at < now() - make_interval(
                secs => GREATEST(:seconds, COALESCE(poll_interval_ms, 0) / 500.0)))`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, seconds: staleAfterMs / 1000 },
      },
    );

    const notified: string[] = [];
    for (const row of rows) {
      const key = `stale:${row.id}`;
      const previous = await NotificationState.findOne({
        where: { tenant_id: tenantId, kind: 'stale', subject_key: key },
      });
      if (previous?.last_state === 'stale') continue;
      await this.recordState(tenantId, 'stale', key, 'stale', true);
      for (const address of await this.adminAddresses()) {
        await this.mailer.send(
          address,
          `speicher — ${row.slug} has not synced`,
          `${row.namespace}/${row.slug} has not synced recently.\n\nDetails: /-/status\n`,
        );
      }
      notified.push(row.id);
    }
    return notified;
  }

  /**
   * Warn admins about repos whose individual grants are expiring soon
   */
  async digestExpiringGrants(tenantId: string): Promise<number> {
    const warningMs = parseDuration(this.config.notify.expiry_warning ?? '14d');
    const rows = await getSequelize().query<{ id: string; namespace: string; slug: string }>(
      `SELECT id, namespace, slug FROM repos
        WHERE tenant_id = :tenantId
          AND next_grant_review_at IS NOT NULL
          AND next_grant_review_at < now() + make_interval(secs => :seconds)`,
      { type: QueryTypes.SELECT, replacements: { tenantId, seconds: warningMs / 1000 } },
    );
    if (rows.length === 0) return 0;

    for (const address of await this.adminAddresses()) {
      await this.mailer.send(
        address,
        `speicher — ${rows.length} repo(s) have grants expiring`,
        `${rows.length} repositories have individual grants expiring soon.\n\nDetails: /-/status\n`,
      );
    }
    return rows.length;
  }

  /**
   * Resolve target labels to email addresses
   *
   * Committer is only included if they exist as a principal; otherwise falls
   * back to maintainers when maintainers were not already in the set
   */
  private async resolveTargets(
    repo: Repo,
    targets: readonly string[],
    committerEmail: string | null,
  ): Promise<string[]> {
    const addresses = new Set<string>();

    if (targets.includes('admins')) {
      for (const address of await this.adminAddresses()) addresses.add(address);
    }

    if (targets.includes('maintainers')) {
      for (const principal of repo.maintainer_principals ?? []) {
        const address = await this.addressForPrincipal(repo.tenant_id, principal);
        if (address) addresses.add(address);
      }
    }

    if (targets.includes('committer') && committerEmail) {
      const known = await this.principalHasAddress(repo, committerEmail);
      if (known) addresses.add(committerEmail.toLowerCase());
      else if (!targets.includes('maintainers')) {
        for (const principal of repo.maintainer_principals ?? []) {
          const address = await this.addressForPrincipal(repo.tenant_id, principal);
          if (address) addresses.add(address);
        }
      }
    }

    return [...addresses];
  }

  /**
   * Whether the email belongs to a maintainer principal or any session
   */
  private async principalHasAddress(repo: Repo, email: string): Promise<boolean> {
    const lower = email.toLowerCase();
    for (const providerId of this.config.providerIds) {
      if ((repo.maintainer_principals ?? []).includes(emailPrincipal(providerId, lower)))
        return true;
    }
    const rows = await getSequelize().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sessions
        WHERE tenant_id = :tenantId AND lower(email) = :email`,
      { type: QueryTypes.SELECT, replacements: { tenantId: repo.tenant_id, email: lower } },
    );
    return Number(rows[0]?.count ?? 0) > 0;
  }

  /**
   * Resolve a principal string to an email address
   *
   * Subject principals look up the most recent session for that identity
   */
  private async addressForPrincipal(tenantId: string, principal: string): Promise<string | null> {
    const parsed = parsePrincipal(principal);
    if (parsed?.kind === 'email') return parsed.email;
    if (parsed?.kind === 'subject') {
      const rows = await getSequelize().query<{ email: string | null }>(
        `SELECT email FROM sessions
          WHERE tenant_id = :tenantId AND provider = :provider AND subject = :subject
            AND email IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`,
        {
          type: QueryTypes.SELECT,
          replacements: { tenantId, provider: parsed.provider, subject: parsed.subject },
        },
      );
      return rows[0]?.email ?? null;
    }
    return null;
  }

  /**
   * All admin user email addresses from the instance config
   */
  private async adminAddresses(): Promise<string[]> {
    const out = new Set<string>();
    for (const user of this.config.instance.admins?.users ?? []) {
      if (user.email) out.add(user.email.toLowerCase());
    }
    return [...out];
  }

  /**
   * Upsert a row in notification_state and log the change
   */
  private async recordState(
    tenantId: string,
    kind: string,
    key: string,
    state: string,
    sent: boolean,
  ): Promise<void> {
    await getSequelize().query(
      `INSERT INTO notification_state (tenant_id, kind, subject_key, last_state, last_sent_at, updated_at)
       VALUES (:tenantId, :kind, :key, :state, CASE WHEN :sent::boolean THEN now() ELSE NULL END, now())
       ON CONFLICT (tenant_id, kind, subject_key) DO UPDATE SET
         last_state = EXCLUDED.last_state,
         last_sent_at = CASE WHEN :sent::boolean THEN now() ELSE notification_state.last_sent_at END,
         updated_at = now()`,
      {
        type: QueryTypes.INSERT,
        replacements: { tenantId, kind, key, state, sent },
      },
    );
    this.log.debug('notification state recorded', { kind, key, state, sent });
  }
}

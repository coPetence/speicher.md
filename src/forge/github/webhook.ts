/**
 * GitHub webhook signature verification and event mapping
 *
 * Shared between the HTTP endpoint and the SQS handler that replays deliveries
 *
 * Verification uses HMAC-SHA256 per GitHub's webhook docs; the hex digest is
 * compared with timingSafeEqual to avoid timing side channels
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { WebhookVerification } from '../../webhooks/signed-delivery';
import { ForgeAction } from '../driver';

export function verifyGithubSignature(
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
  secret: string,
): WebhookVerification {
  const signature = headerValue(headers, 'x-hub-signature-256');
  const deliveryId = headerValue(headers, 'x-github-delivery');
  const event = headerValue(headers, 'x-github-event');

  if (secret === '' || !signature || !signature.startsWith('sha256=')) {
    return { valid: false, deliveryId, event };
  }

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const provided = Buffer.from(signature, 'utf8');
  const computed = Buffer.from(expected, 'utf8');

  const valid = provided.length === computed.length && timingSafeEqual(provided, computed);

  return { valid, deliveryId, event };
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' ? value : null;
}

export function mapGithubEvent(
  event: string,
  payload: Record<string, any>,
  trackedBranchOf: (forgeRepoId: string) => string | undefined,
): ForgeAction[] {
  const repoId = payload.repository?.id !== undefined ? String(payload.repository.id) : null;

  switch (event) {
    case 'push': {
      // Sync only if on the tracked branch, ignore deletion
      if (!repoId)
        return [
          {
            kind: 'ignore',
            reason: 'Push event has no repository ID; cannot determine which repository to sync.',
          },
        ];
      const ref = typeof payload.ref === 'string' ? payload.ref : '';
      const branch = ref.replace(/^refs\/heads\//, '');
      const tracked = trackedBranchOf(repoId) ?? payload.repository?.default_branch;

      if (!ref.startsWith('refs/heads/') || branch !== tracked) {
        return [{ kind: 'ignore', reason: `push to ${ref || 'a non-branch ref'}` }];
      }
      if (payload.deleted === true) {
        return [
          { kind: 'ignore', reason: 'Push event is a branch deletion; no code to synchronize.' },
        ];
      }
      return [
        {
          kind: 'sync',
          forgeRepoId: repoId,
          sha: typeof payload.after === 'string' ? payload.after : undefined,
          reason: 'push',
        },
      ];
    }

    case 'pull_request': {
      // PR opened, synchronised or reopened triggers a validation run
      if (!repoId)
        return [
          { kind: 'ignore', reason: 'Pull request event has no repository ID; cannot validate.' },
        ];
      const action = payload.action;
      if (action !== 'opened' && action !== 'synchronize' && action !== 'reopened') {
        return [{ kind: 'ignore', reason: `pull_request.${action}` }];
      }
      const sha = payload.pull_request?.head?.sha;
      const number = payload.pull_request?.number;
      if (typeof sha !== 'string' || typeof number !== 'number') {
        return [
          {
            kind: 'ignore',
            reason: 'Pull request payload is missing the head SHA or PR number; cannot validate.',
          },
        ];
      }

      return [{ kind: 'validate-pr', forgeRepoId: repoId, sha, prNumber: number }];
    }

    case 'repository': {
      // Rename updates the local mapping; delete/archive/transfer/privatize purges
      if (!repoId)
        return [
          { kind: 'ignore', reason: 'Repository event has no repository ID; cannot process.' },
        ];
      switch (payload.action) {
        case 'renamed':
          return [
            {
              kind: 'rename',
              forgeRepoId: repoId,
              oldName: String(payload.changes?.repository?.name?.from ?? ''),
              newName: String(payload.repository?.name ?? ''),
            },
          ];
        case 'deleted':
        case 'archived':
        case 'transferred':
        case 'privatized':
          return [{ kind: 'purge', forgeRepoId: repoId, reason: `repository.${payload.action}` }];
        case 'publicized':
        case 'unarchived':
          return [{ kind: 'sync', forgeRepoId: repoId, reason: `repository.${payload.action}` }];
        default:
          return [{ kind: 'ignore', reason: `repository.${payload.action}` }];
      }
    }

    case 'installation': {
      // App-level lifecycle: discover new, purge removed/suspended
      const installationId = String(payload.installation?.id ?? '');
      if (!installationId)
        return [
          { kind: 'ignore', reason: 'Installation event has no installation ID; cannot process.' },
        ];
      if (payload.action === 'created') return [{ kind: 'discover', installationId }];
      if (payload.action === 'deleted' || payload.action === 'suspend') {
        return [{ kind: 'purge-installation', installationId }];
      }
      if (payload.action === 'unsuspend') return [{ kind: 'discover', installationId }];
      return [{ kind: 'ignore', reason: `installation.${payload.action}` }];
    }

    case 'installation_repositories': {
      // Added repos trigger discovery; removed repos are purged
      const installationId = String(payload.installation?.id ?? '');
      const actions: ForgeAction[] = [];
      if (
        installationId &&
        Array.isArray(payload.repositories_added) &&
        payload.repositories_added.length
      ) {
        actions.push({ kind: 'discover', installationId });
      }
      for (const repo of payload.repositories_removed ?? []) {
        actions.push({
          kind: 'purge',
          forgeRepoId: String(repo.id),
          reason: 'installation_repositories.removed',
        });
      }
      return actions.length ? actions : [{ kind: 'ignore', reason: 'installation_repositories' }];
    }

    case 'ping':
      return [{ kind: 'ignore', reason: 'ping' }];

    default:
      return [{ kind: 'ignore', reason: `unhandled event ${event}` }];
  }
}

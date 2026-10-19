import type { Request, Response } from 'express';

import { DeadJobRow } from '../../../../dashboard.repository';
import { DashboardResponder } from '../../../../respond';
import { isoOf, relativeTime } from '../../../../../common/time';
import { renderInlineIcon } from '../../../../../content-reader/icons';
import { renderTemplate } from '../../../../../content-reader/views';
import { pagerOf } from '../../../../../global-ui/components/pager/pager';
import { DEFAULT_MAX_ATTEMPTS, JOB_DESCRIPTIONS, isJobKind } from '../../../../../jobs/queue';

/** Putting a dead job back on the queue, on both Retry buttons */
export const RETRY_ICON = 'rotate-ccw';

export const DELETE_ICON = 'trash-2';

export interface DeadJobsPayload {
  dead_jobs: DeadJobRow[];
  total: number;
  page: number;
  pages: number;
  per_page: number;
}

export interface DeadJobsBanners {
  retried: number | null;
  deleted: number | null;
}

/** Sends the dead jobs page: the jobs the worker gave up on, each with a Retry, a Delete and a checkbox */
export function sendDeadJobs(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  payload: DeadJobsPayload,
  banners: DeadJobsBanners,
): void {
  respond.send(req, res, isAdmin, {
    section: 'dead-jobs',
    title: 'Dead jobs',
    island: 'dead-jobs',
    payload,
    page: (data) =>
      renderTemplate('dashboard/ui/views/sync-status/dead-jobs', {
        intro: `This page shows all jobs that failed ${DEFAULT_MAX_ATTEMPTS} times in a row. These jobs will not be retried automatically. You can either retry them manually, or delete them if they are no longer relevant.`,
        toast: toastOf(banners),
        retry_icon: renderInlineIcon(RETRY_ICON, 'spr-icon'),
        delete_icon: renderInlineIcon(DELETE_ICON, 'spr-icon'),
        total: data.total,
        page: data.page,
        pages: data.pages,
        pager: pagerOf(data.page, data.pages, pageHref),
        range: `${(data.page - 1) * data.per_page + 1}–${(data.page - 1) * data.per_page + data.dead_jobs.length} of ${data.total}`,
        previous_icon: renderInlineIcon('chevron-left', 'spr-icon'),
        next_icon: renderInlineIcon('chevron-right', 'spr-icon'),
        dead: data.dead_jobs.map((row) => ({
          id: row.id,
          kind: row.kind,
          description: isJobKind(row.kind) ? JOB_DESCRIPTIONS[row.kind] : null,
          repository: row.repo_slug ? `${row.repo_namespace}/${row.repo_slug}` : null,
          repositoryHref: row.repo_slug ? `/-/status/${row.repo_namespace}/${row.repo_slug}` : null,
          forge: row.forge_key,
          error: row.last_error,
          when: relativeTime(row.updated_at),
          whenAt: isoOf(row.updated_at),
        })),
      }),
  });
}

/** The toast after a Retry or a Delete */
function toastOf(banners: DeadJobsBanners): { text: string; level: 'ok' | 'info' } | null {
  if (banners.retried !== null) {
    return banners.retried > 0
      ? { text: `${banners.retried} job(s) put back on the queue.`, level: 'ok' }
      : {
          text: 'No job was put back on the queue, because none of the chosen jobs is dead anymore.',
          level: 'info',
        };
  }
  if (banners.deleted === null) return null;
  return banners.deleted > 0
    ? { text: `${banners.deleted} job(s) deleted.`, level: 'ok' }
    : {
        text: 'No job was deleted, because none of the chosen jobs is dead anymore.',
        level: 'info',
      };
}

function pageHref(page: number): string {
  return page > 1 ? `/-/dead-jobs?page=${page}` : '/-/dead-jobs';
}

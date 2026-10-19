import type { Request, Response } from 'express';

import { runLevel, severityLevel } from '../../../levels';
import { DashboardResponder } from '../../../../respond';
import { RunRow } from '../../../../dashboard.repository';
import { RunPayload } from '../../../../status/status.types';
import { elapsed, isoOf, relativeTime } from '../../../../../common/time';
import { renderInlineIcon } from '../../../../../content-reader/icons';
import { escapeHtml, renderTemplate } from '../../../../../content-reader/views';
import type { Note } from '../../../../../global-ui/note';

/**
 * A finding's severity as a mark rather than a word. The badge keeps the word —
 * clipped, for a screen reader and the tooltip — and its colour, so the picture is
 * the third way the severity is said and never the only one.
 */
const SEVERITY_ICONS: Record<string, string> = {
  reject: 'circle-x',
  warn: 'triangle-alert',
  info: 'info',
};

// Escalation order: a run is summed up by its worst finding
const SEVERITY_RANK: Record<string, number> = { info: 0, warn: 1, reject: 2 };

/** The badge one finding — or the worst of a run's — is drawn with */
function severityBadge(severity: string) {
  return {
    level: severityLevel(severity),
    severity,
    iconHtml: renderInlineIcon(SEVERITY_ICONS[severity] ?? 'info', 'spr-icon'),
  };
}

/** The most escalated severity among findings, or null when there are none */
function worstSeverity(findings: { severity: string }[]): string | null {
  return findings.reduce<string | null>(
    (worst, { severity }) =>
      worst === null || (SEVERITY_RANK[severity] ?? 0) > (SEVERITY_RANK[worst] ?? 0)
        ? severity
        : worst,
    null,
  );
}

/** Where one run of one repository is drawn */
export function runHref(namespace: string, slug: string, runId: string): string {
  return (
    `/-/status/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}` +
    `/runs/${encodeURIComponent(runId)}`
  );
}

/**
 * A run as both pages draw it: a row of the repository's table and the head of
 * its own page. One mapping, so the row a reader clicked and the page it opens
 * cannot come to say different things about one run.
 */
export function runView(namespace: string, slug: string, run: RunRow) {
  return {
    href: runHref(namespace, slug, run.id),
    level: runLevel(run.status),
    status: run.status,
    trigger: run.trigger,
    sha: run.sha?.slice(0, 8) ?? '—',
    started: relativeTime(run.started_at),
    startedAt: isoOf(run.started_at),
    took: elapsed(run.started_at, run.finished_at),
    documents: run.stats?.documents ?? null,
    assets: run.stats?.assets ?? null,
    droppedGrants: run.stats?.dropped_grants ?? 0,

    failedSubtrees: run.stats?.failed_subtrees ?? [],

    /*
      The table's Findings cell: the count, and beside it the mark of the most
      escalated finding, so a run that rejected something is told apart from one
      that only warned without opening either.
    */
    worst: ((severity) => (severity === null ? null : severityBadge(severity)))(
      worstSeverity(run.findings ?? []),
    ),

    findings: (run.findings ?? []).map((finding) => ({
      ...severityBadge(finding.severity),
      code: finding.code,
      source: finding.line ? `${finding.source}:${finding.line}` : finding.source,

      // Admin gets the internal message, everyone else the public one
      message: finding.adminMessage ?? finding.message,
    })),
  };
}

export function failedSubtreesNote(
  subtrees: string[],
  publishedPages: number,
  isAdmin: boolean,
): Note | null {
  if (subtrees.length === 0) return null;
  const because = isAdmin
    ? 'because of the problems listed under Findings'
    : 'because of problems in this commit';

  if (subtrees.includes('')) {
    return {
      level: 'fail',
      text:
        publishedPages > 0
          ? `None of the changes in this commit were published, ${because}. Readers still see the pages from the last successful sync.`
          : `Nothing from this repository is published yet, ${because}. No earlier sync has succeeded, so there is no previous version to show instead.`,
    };
  }

  const paths = subtrees.map((path) => `<code>${escapeHtml(path)}</code>`);
  const listed =
    paths.length === 1 ? paths[0] : `${paths.slice(0, -1).join(', ')} and ${paths.at(-1)}`;
  return {
    level: 'fail',
    html: `The pages under ${listed} were not updated, ${because}. Readers still see what was published there before.`,
  };
}

/** An instant a person reads and can match against a log line: minutes, in UTC */
function stamp(value: Date): string {
  const iso = isoOf(value);
  return iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '';
}

/** Sends one sync run: what it did, what it left serving, and its findings */
export function sendRun(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  payload: RunPayload,
): void {
  const name = `${payload.namespace}/${payload.slug}`;
  respond.send(req, res, isAdmin, {
    section: 'status',
    title: `${name} · ${stamp(payload.run.started_at)}`,
    payload,
    page: (answer) =>
      renderTemplate('dashboard/ui/views/sync-status/run-status', {
        name,
        repo_href: `/-/status/${encodeURIComponent(answer.namespace)}/${encodeURIComponent(answer.slug)}`,
        stamp: stamp(answer.run.started_at),
        sha_full: answer.run.sha ?? '',
        /*
          Findings are fetched for an administrator only — the SQL withholds them —
          so a maintainer's empty list is not "this run found nothing". The section
          is drawn on the same fact the query was asked with, rather than on the
          list being empty.
        */
        show_findings: isAdmin,
        run: runView(answer.namespace, answer.slug, answer.run),
        failed_subtrees_note: failedSubtreesNote(
          answer.run.stats?.failed_subtrees ?? [],
          answer.published_pages,
          isAdmin,
        ),
      }),
  });
}

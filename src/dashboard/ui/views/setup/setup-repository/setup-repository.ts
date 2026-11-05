import type { Request, Response } from 'express';

import { renderInlineIcon } from '../../../../../content-reader/icons';
import { escapeHtml, renderTemplate } from '../../../../../content-reader/views';
import type { ConfigFileModal } from '../../../../configurator/config-page/payloads';
import { DashboardResponder, guidedThroughSetup } from '../../../../respond';
import { BLOCKING_FIXES, RepositoryFix } from '../../../../setup/repository-fix';
import { RepositoryTableRow, repositoryMatchText } from '../../../../setup/repository-table';
import { REPOSITORY_SECTION_ID } from '../../../../setup/setup-sections';
import { walkthroughView } from '../../../../setup/walkthrough-view';
import { SYNCING_ICON, SYNC_ICON } from '../../sync-status/repo-status/repo-status';
import { QUEUED_ICON, STATE_DISPLAY } from '../../sync-status/status-overview/status-overview';

export interface RepositoryPayload {
  finished: boolean;
  me: { name: string; provider: string; groups: string[] } | null;
  fix: RepositoryFix | null;
  check_href: string | null;
  can_refresh: boolean;
  query: string;
  config_file: ConfigFileModal | null;
  picker: ConfigFileModal | null;
  form_origins: string[];
  rows: RepositoryTableRow[];
  // The file to commit, for the sources whose repositories are not checked
  snippet: string | null;
  // Whether a sync or a discovery is queued or running, which the page is refreshed more often for
  busy: boolean;
  // Whether the administrator can read a synced page, which lets them complete the setup
  readable: boolean;
}

/**
 * groupNote returns the note of the group card after the setup: which groups the administrator is in.
 *
 * @param me who is signed in, or null for a claim session
 */
function groupNote(me: RepositoryPayload['me']): { text?: string; html?: string } {
  if (!me) return { text: 'You are not signed in with an identity provider.' };
  if (me.groups.length === 0) {
    return {
      text: `You are signed in as ${me.name} with ${me.provider}, but you are not a member of any group.`,
    };
  }
  const groups = me.groups.map((name) => `<code>${escapeHtml(name)}</code>`).join(', ');
  return {
    html: `You are signed in as ${escapeHtml(me.name)} with ${escapeHtml(me.provider)} and are in the following groups: ${groups}.`,
  };
}

export function sendSetupRepository(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  payload: RepositoryPayload,
): void {
  const guided = guidedThroughSetup(req);
  const walkthrough = walkthroughView(req, res, 'repositories');
  respond.send(req, res, isAdmin, {
    section: guided ? 'setup' : 'repositories',
    subsection: guided ? REPOSITORY_SECTION_ID : undefined,
    title: 'Repositories',
    payload,
    // The modal of a new `.speicher.yaml` posts to a redirect to GitHub's new-file page
    formActions: payload.form_origins.length > 0 ? payload.form_origins : undefined,
    // Refreshes the table, and runs the checks of the GitHub sources
    island: 'setup',
    page: (data) =>
      renderTemplate('dashboard/ui/views/setup/setup-repository', {
        ...(data as unknown as Record<string, unknown>),
        rows: data.rows.map((row) => ({ ...row, search: repositoryMatchText(row) })),
        walkthrough,
        head_icon: renderInlineIcon('book-marked', 'spr-icon'),
        search_icon: renderInlineIcon('search', 'spr-icon'),
        external_icon: renderInlineIcon('external-link', 'spr-icon'),
        copy_icon: renderInlineIcon('copy', 'spr-icon'),
        create_icon: renderInlineIcon('plus', 'spr-icon'),
        edit_icon: renderInlineIcon('pencil', 'spr-icon'),
        copied_icon: renderInlineIcon('check', 'spr-icon'),
        readable_icon: renderInlineIcon('circle-check', 'spr-icon'),
        group_note: groupNote(data.me),
        blocked: data.fix !== null && BLOCKING_FIXES.includes(data.fix.id),
        arrow_icon: renderInlineIcon('arrow-right', 'spr-icon'),
        // As on the sync status page
        state_display: STATE_DISPLAY,
        syncing_icon: renderInlineIcon(SYNCING_ICON, 'spr-icon spr-spin'),
        queued_icon: renderInlineIcon(QUEUED_ICON, 'spr-icon'),
        refresh_icon: renderInlineIcon(SYNC_ICON, 'spr-icon'),
      }),
  });
}

import type { Request, Response } from 'express';

import type { CheckModal, ConfigFileModal } from '../../../../configurator/config-page/payloads';
import { DashboardResponder, guidedThroughSetup } from '../../../../respond';
import { RepositoryTableRow, repositoryMatchText } from '../../../../setup/repository-table';
import { REPOSITORY_SECTION_ID } from '../../../../setup/setup-sections';
import { renderInlineIcon } from '../../../../../content-reader/icons';
import { escapeHtml, renderTemplate } from '../../../../../content-reader/views';
import { SYNCING_ICON } from '../../sync-status/repo-status/repo-status';
import { QUEUED_ICON, STATE_DISPLAY } from '../../sync-status/status-overview/status-overview';

/** A GitHub source whose repositories are checked: the address the check runs at while it has not yet, or what it found */
export interface RepositoryCheck {
  id: string;
  pending: string | null;
  problem?: CheckModal['problem'];
  empty?: boolean;
  // Whether its repositories name groups the instance does not have
  missing?: boolean;
  more?: boolean;
}

export interface RepositoryPayload {
  finished: boolean;
  me: { name: string; provider: string; groups: string[] } | null;
  query: string;
  config_file: ConfigFileModal | null;
  picker: ConfigFileModal | null;
  form_origins: string[];
  checks: RepositoryCheck[];
  rows: RepositoryTableRow[];
  // The file to commit, for the sources whose repositories are not checked
  snippet: string | null;
  // The sources whose repositories are being discovered
  discovering: string[];
  // Whether a sync or a discovery is queued or running, which the page is refreshed more often for
  busy: boolean;
  // Whether the administrator can read a synced page, which lets them complete the setup
  readable: boolean;
  // How far the step is, for the note at its foot; none while the guide bar offers to complete the setup
  status:
    | 'no-administrator'
    | 'no-group'
    | 'syncing'
    | 'no-repository'
    | 'no-access'
    | 'waiting'
    | null;
}

/**
 * groupNote returns the note of the group card: what it takes to be in a group, or which groups the administrator is in.
 *
 * @param me who is signed in, or null for a claim session
 */
function groupNote(me: RepositoryPayload['me']): { level?: string; text?: string; html?: string } {
  if (!me) {
    return {
      text: 'To add yourself to a group, you need to first log in as the administrator of this instance.',
    };
  }
  if (me.groups.length === 0) {
    return {
      text: `You are signed in as ${me.name} with ${me.provider}, but you are not a member of any group of this instance yet. Add yourself to a group, so a repository can grant you access.`,
    };
  }
  const groups = me.groups.map((name) => `<code>${escapeHtml(name)}</code>`).join(', ');
  return {
    level: 'ok',
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
        head_icon: renderInlineIcon('book-marked', 'spr-icon'),
        search_icon: renderInlineIcon('search', 'spr-icon'),
        external_icon: renderInlineIcon('external-link', 'spr-icon'),
        copy_icon: renderInlineIcon('copy', 'spr-icon'),
        create_icon: renderInlineIcon('plus', 'spr-icon'),
        edit_icon: renderInlineIcon('pencil', 'spr-icon'),
        copied_icon: renderInlineIcon('check', 'spr-icon'),
        readable_icon: renderInlineIcon('circle-check', 'spr-icon'),
        group_note: groupNote(data.me),
        // As on the sync status page
        state_display: STATE_DISPLAY,
        syncing_icon: renderInlineIcon(SYNCING_ICON, 'spr-icon spr-spin'),
        queued_icon: renderInlineIcon(QUEUED_ICON, 'spr-icon'),
      }),
  });
}

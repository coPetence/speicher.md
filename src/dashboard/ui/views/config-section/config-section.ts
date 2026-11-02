import type { Request, Response } from 'express';

import type { SaveVerdict } from '../../../../config/classification';
import { sectionEmptyArt, tableEmptyArt } from '../../../../content-reader/empty-state';
import { renderInlineIcon } from '../../../../content-reader/icons';
import { escapeHtml, renderTemplate } from '../../../../content-reader/views';
import { renderHelp } from '../../../../global-ui/help-markup';
import { missingHostKeysText, unreadableLinesText } from '../../../../global-ui/known-hosts-notes';
import type { Note } from '../../../../global-ui/note';
import { CONFIG_SECTIONS } from '../../../configurator/config-form/fields';
import { memberOf, memberPosition, nounOf } from '../../../configurator/config-form/members';
import { allFields, cardItems } from '../../../configurator/config-form/model';
import { sourceCheckPath } from '../../../configurator/config-page/github-app-manifest';
import { ConfigSectionPayload } from '../../../configurator/config-page/payloads';
import { quickSetupPath } from '../../../configurator/quick-setup/model';
import { dashboardSectionTitle } from '../../../dashboard-sections';
import { DashboardResponder } from '../../../respond';
import { walkthroughView } from '../../../setup/walkthrough-view';
import { brokenVersionsDialog, loadNotes, versionNotes } from '../../config-notes';
import { markSprite, renderInlineMark } from '../../provider-marks';
import { SYNCING_ICON } from '../sync-status/repo-status/repo-status';

// The mark of each state a checked repository can be in
export const CHECK_ICONS = {
  ready: 'circle-check',
  unpublished: 'circle-dashed',
  'unknown-groups': 'triangle-alert',
  invalid: 'circle-x',
  unreadable: 'circle-help',
} as const;

/** Render a config section, using a fallback title if parsing failed */
export function sendConfigSection(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  sectionId: string,
  payload: ConfigSectionPayload,
  inSetup: boolean,
  status?: number,
): void {
  // Opens by itself the first time the guided setup reaches the page, and from its link at any time
  const walkthrough = walkthroughView(req, res, sectionId);
  respond.send(req, res, isAdmin, {
    section: 'config',
    subsection: sectionId,
    title: payload.section?.title ?? titleOfSection(sectionId),
    payload,
    island: 'config',
    formActions: payload.config_file ? [payload.config_file.leads_to] : undefined,
    embedsFrames: payload.section
      ? allFields([payload.section]).some((f) => f.kind === 'template')
      : false,
    overlay: brokenVersionsDialog,
    page: (data) =>
      renderTemplate('dashboard/ui/views/config-section', {
        ...(data as unknown as Record<string, unknown>),
        // Deduplicate page logos in a sprite; keep markup out of the payload
        walkthrough,
        marks_sprite: markSprite([
          payload.section?.mark ?? '',
          ...[
            ...(payload.section?.entries ?? []),
            // Include provider logos from table rows
            ...(payload.section?.tables ?? []).flatMap((table) => table.entries),
          ].flatMap((entry) => [
            entry.mark,
            // Group lines can use different providers
            ...entry.lines.map((line) => line.mark),
          ]),
        ]),
        // Inline icons avoid dependencies on the navigation sprite
        tile_icons: Object.fromEntries(
          (payload.section?.entries ?? [])
            .filter((entry) => entry.icon !== '')
            .map((entry) => [entry.icon, renderInlineIcon(entry.icon, 'spr-icon')]),
        ),
        page_arrow: renderInlineIcon('chevron-right', 'spr-icon spr-tile-arrow'),
        badge_icons: Object.fromEntries(
          [
            ...(payload.section?.entries ?? []).flatMap((entry) =>
              entry.badges.map((badge) => badge.icon),
            ),
            ...(payload.section ? cardItems([payload.section]) : []).flatMap((item) =>
              item.kind === 'copy-value'
                ? ['copy', 'check']
                : item.kind === 'github-app-links'
                  ? ['external-link']
                  : [],
            ),
          ]
            .filter((icon) => icon !== '')
            .map((icon) => [icon, renderInlineIcon(icon, 'spr-icon')]),
        ),
        // Inline logos keep browser-cloned options independent of SVG references
        option_marks: Object.fromEntries(
          [
            ...(payload.section ? allFields([payload.section]) : []).flatMap((f) =>
              'options' in f ? f.options : [],
            ),
            ...(payload.section?.addOps ?? []).flatMap((op) => [
              ...op.typeOptions,
              ...(op.nameOptions ?? []),
            ]),
            ...(payload.section?.tables ?? []).flatMap((table) =>
              (table.add?.kinds ?? []).flatMap((kind) => kind.options),
            ),
          ]
            .map((option) => option.mark ?? '')
            .filter((mark) => mark !== '')
            .map((mark) => [mark, renderInlineMark(mark, 'spr-icon')]),
        ),
        section_id: sectionId,
        // Where the add modal posts a kind it sets up in one go
        quick_action: quickSetupPath(sectionId),
        section_title: payload.section?.title ?? titleOfSection(sectionId),
        // Breadcrumbs run from the overview to the current page
        crumbs: configTrail(
          sectionId,
          payload.section?.title ?? titleOfSection(sectionId),
          // Hide breadcrumbs during setup, when navigation uses a different root
          !inSetup,
        ),
        // Use the section icon unless the heading already has a provider logo
        head_icon: payload.section?.mark
          ? ''
          : renderInlineIcon(
              CONFIG_SECTIONS.find((section) => section.id === sectionId)?.icon ?? '',
              'spr-icon',
            ),
        pencil_icon: payload.section?.renameOp ? renderInlineIcon('pencil', 'spr-icon') : '',
        edit_icon: renderInlineIcon('pencil', 'spr-icon'),
        equals_icon: renderInlineIcon('arrow-right', 'spr-icon'),
        note_icon: renderInlineIcon('sticky-note', 'spr-icon'),
        external_icon: renderInlineIcon('external-link', 'spr-icon'),
        syncing_icon: renderInlineIcon(SYNCING_ICON, 'spr-icon spr-spin'),
        // The large check a quick setup ends on
        ready_icon: payload.ready ? renderInlineIcon('circle-check', 'spr-icon') : '',
        ready_arrow_icon:
          payload.ready || payload.check ? renderInlineIcon('arrow-right', 'spr-icon') : '',
        // A mark per state of a checked repository
        check_icons: payload.check
          ? Object.fromEntries(
              Object.entries(CHECK_ICONS).map(([state, icon]) => [
                state,
                renderInlineIcon(icon, 'spr-icon'),
              ]),
            )
          : {},
        check_again_href: payload.check ? sourceCheckPath(payload.check.id) : '',
        expiry_icon: renderInlineIcon('calendar-clock', 'spr-icon'),
        add_icon: renderInlineIcon('plus', 'spr-icon'),
        chevron_icon: renderInlineIcon('chevron-right', 'spr-icon'),
        kind_icons: Object.fromEntries(
          (payload.section?.tables ?? [])
            .flatMap((table) => table.add?.kinds ?? [])
            .map((kind) => [kind.icon, renderInlineIcon(kind.icon, 'spr-icon')]),
        ),
        // Always include empty-state art so filtering can reveal it
        empty_art: sectionEmptyArt(sectionId),
        table_empty_art: tableEmptyArt(sectionId),
        remove_icon: renderInlineIcon('trash-2', 'spr-icon'),
        warn_icon: renderInlineIcon('triangle-alert', 'spr-icon'),
        // Distinguish resetting values from deleting named entries
        reset_icon: renderInlineIcon('rotate-ccw', 'spr-icon'),
        search_icon: renderInlineIcon('search', 'spr-icon'),
        // Format problems here; omit those already shown at a field or row
        problems_html: listedProblems(payload).map(({ text }) => renderHelp(text)),
        listed_codes: listedProblems(payload).map(({ code }) => code),
        // Render help links in the error headline
        error_html: payload.error ? renderHelp(payload.error) : '',
        // Build value-dependent notes here; fixed notes live in the view
        load_notes: loadNotes(payload),
        version_notes: versionNotes(payload),
        source_note: payload.editable
          ? null
          : {
              level: 'idle',
              html: `This instance takes its configuration from <code>${escapeHtml(payload.config_path || 'inline')}</code>, which is authoritative. The settings below are shown as they are and cannot be changed from here.`,
            },
        rename_note: renameNote(payload),
        restart_note: restartNote(payload.verdict),
        empty_text: `No ${payload.section?.entryNoun || 'entry'}s here yet.`,
        no_match_html: `Nothing here matches <code data-spr-needle>${escapeHtml(payload.query)}</code>. <a href="/-/config/${escapeHtml(sectionId)}">Show all</a>`,
        host_key_notes: hostKeyNotes(payload),
      }),
    status,
  });
}

/** Return problems not already shown at a field or row */
function listedProblems(payload: ConfigSectionPayload): { text: string; code: string }[] {
  return payload.problems
    .map((text, i) => ({
      text,
      code: payload.problem_codes?.[i] ?? '',
      shown: payload.problems_shown?.[i] === true,
    }))
    .filter(({ shown }) => !shown);
}

/** List repositories affected by a rename, or confirm none are affected */
function renameNote(payload: ConfigSectionPayload): Note | null {
  if (!payload.section?.renameOp) return null;
  const noun = escapeHtml(payload.section.noun || 'entry');
  if (payload.usage.length === 0) {
    return {
      level: 'ok',
      html: `No <code>.speicher.yaml</code> references this ${noun}. You do not need to manually update it anywhere`,
    };
  }
  const repositories = payload.usage
    .map(
      (repo) =>
        `<li><code>${escapeHtml(repo.namespace)}/${escapeHtml(repo.slug)}</code> (${repo.pages} page${repo.pages === 1 ? '' : 's'})</li>`,
    )
    .join('');
  return {
    level: 'warn',
    tag: 'div',
    html: `<p>Renaming will break ${noun} references in <code>.speicher.yaml</code> files across these repositories:</p><ul class="spr-problems">${repositories}</ul>`,
  };
}

/** Explain a required restart, or return null if none is needed */
function restartNote(verdict: SaveVerdict | null): Note | null {
  if (!verdict || verdict.effect === 'none') return null;
  if (!verdict.hotReloadAvailable) {
    return {
      level: 'warn',
      text: 'Takes effect when the instance restarts, because this instance does not reload its configuration while running.',
    };
  }
  const restarting = verdict.changed.filter((change) => change.requiresRestart);
  if (restarting.length === 0) return null;
  const keys = restarting.map((change) => `<code>${escapeHtml(change.key)}</code>`).join(', ');
  return {
    level: 'warn',
    html: `Takes effect when the instance restarts, because ${keys} builds objects that only exist at startup. Everything else in this change waits with it — half of one version beside half of another is a combination nothing has validated.`,
  };
}

/** Map known-hosts field paths to missing-key and unreadable-line notes */
function hostKeyNotes(
  payload: ConfigSectionPayload,
): Record<string, { missing: Note; unreadable: Note }> {
  const fields = payload.section ? allFields([payload.section]) : [];
  return Object.fromEntries(
    fields.flatMap((f) =>
      f.kind === 'known-hosts'
        ? [
            [
              f.path,
              {
                missing: { level: 'info', text: missingHostKeysText(f.missing) },
                unreadable: { level: 'warn', text: unreadableLinesText(f.unreadable) },
              },
            ],
          ]
        : [],
    ),
  );
}

/** Build breadcrumbs from the section path */
function configTrail(
  sectionId: string,
  title: string,
  rooted = true,
): { href: string; title: string }[] {
  // The view hides trails containing only the current page
  const trail: { href: string; title: string }[] = [{ href: '', title }];
  if (!rooted) return trail;
  for (let id = sectionId; ; ) {
    const cut = id.lastIndexOf('/');
    if (cut === -1) break;
    id = id.slice(0, cut);
    trail.unshift({ href: `/-/config/${id}`, title: titleOfSection(id) });
  }
  // Share the overview title with navigation
  trail.unshift({ href: '/-/config', title: dashboardSectionTitle('config') });
  return trail;
}

/** Derive a section or member title without a parsed config */
function titleOfSection(id: string): string {
  const member = memberOf(id);
  // Sequence members use the noun and one-based position instead of a key
  if (member) {
    const position = memberPosition(member);
    if (!position) return member.id;
    const noun = nounOf(member.section);
    return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${position.at + 1}`;
  }
  return CONFIG_SECTIONS.find((section) => section.id === id)?.title ?? 'Configuration';
}

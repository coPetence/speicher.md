import type { Request, Response } from 'express';

import { sectionEmptyArt, tableEmptyArt } from '../../../../content-reader/empty-state';
import { renderInlineIcon } from '../../../../content-reader/icons';
import { escapeHtml, renderTemplate } from '../../../../content-reader/views';
import { CONFIG_SECTIONS } from '../../../configurator/config-form/fields';
import { renderHelp } from '../../../../global-ui/help-markup';
import { missingHostKeysText, unreadableLinesText } from '../../../../global-ui/known-hosts-notes';
import type { Note } from '../../../../global-ui/note';
import { brokenVersionsDialog, loadNotes, versionNotes } from '../../config-notes';
import { memberOf, memberPosition, nounOf } from '../../../configurator/config-form/members';
import { allFields, cardItems } from '../../../configurator/config-form/model';
import { ConfigSectionPayload } from '../../../configurator/config-page/payloads';
import type { SaveVerdict } from '../../../../config/classification';
import { dashboardSectionTitle } from '../../../dashboard-sections';
import { DashboardResponder } from '../../../respond';
import { markSprite, renderInlineMark } from '../../provider-marks';

/**
 * Sends one section's page.
 *
 * `subsection` is what the left column marks as current; the title is the
 * section's own when the document parsed and the index's when it did not, so a
 * broken configuration still gives its pages the right names.
 */
export function sendConfigSection(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  sectionId: string,
  payload: ConfigSectionPayload,
  hasAdministrator: boolean,
  status?: number,
): void {
  respond.send(req, res, isAdmin, {
    section: 'config',
    subsection: sectionId,
    title: payload.section?.title ?? titleOfSection(sectionId),
    payload,
    island: 'config',
    embedsFrames: payload.section
      ? allFields([payload.section]).some((f) => f.kind === 'template')
      : false,
    overlay: brokenVersionsDialog,
    page: (data) =>
      renderTemplate('dashboard/ui/views/config-section', {
        ...(data as unknown as Record<string, unknown>),
        // Help markup, rendered by the template's `md()`
        // The logos this page draws, once each. Markup, so it belongs to the
        // rendering and not to the payload — see `provider-marks.ts`.
        marks_sprite: markSprite([
          payload.section?.mark ?? '',
          ...[
            ...(payload.section?.entries ?? []),
            // A table's rows carry marks too: a group's rows each name a provider
            ...(payload.section?.tables ?? []).flatMap((table) => table.entries),
          ].flatMap((entry) => [
            entry.mark,
            // A line carries one too: a group draws from more than one provider,
            // and the sprite is built from what the page draws rather than from
            // what the section is.
            ...entry.lines.map((line) => line.mark),
          ]),
        ]),
        /*
          The badge icons this page draws, by name — inline SVG, for the reason
          the back arrow and the pencil are: the page's sprite is assembled from
          what the *left column* names, so a badge that referenced a symbol would
          lose its picture the day the nav changed. A map rather than markup on
          the entry, because a badge is a fact about a member and belongs in the
          payload, while a path is not an answer a JSON caller asked for.
        */
        /*
          The icons the tiles draw, by name — inline, exactly as the badges are
          and for the same reason: the page's sprite is assembled from what the
          *left column* names, so a tile referencing a symbol would lose its
          picture the day the nav changed. Only a fixed child carries one; a
          provider draws its logo from the marks sprite instead, and a group row
          draws nothing. A name the icon set does not have leaves the tile
          without a picture, which is the right failure for a decoration.
        */
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
        /*
          The logos this page's dropdowns draw, by name — inline, and *not* out
          of the marks sprite above. A mark inside an `<option>` is cloned into
          the closed control by the browsers that draw the list themselves, and
          a clone is not a place to be depending on a `<use>` resolving; see
          `renderInlineMark`. Markup here rather than on the option, for the
          reason every other drawing on this page is: the payload says which
          mark, the page says how it is drawn.
        */
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
        section_title: payload.section?.title ?? titleOfSection(sectionId),
        // The whole path to this page, outermost first, ending in the page
        // itself — see `configTrail`, and the view for what is a link.
        crumbs: configTrail(
          sectionId,
          payload.section?.title ?? titleOfSection(sectionId),
          // While the first run is unfinished the trail is *wrong*, not merely
          // redundant: it is rooted at `Configuration`, which the column has taken
          // out — its three relevant sections hang under `Set up` — so it names a
          // parent that is not on screen and links to a page reached from `All
          // settings`. Two accounts of where you are, disagreeing.
          //
          // Dropped rather than rewritten to say `Set up / Identity`, because the
          // column already marks the child as the current page and the heading
          // says which page it is. The same fact governs both, so they cannot
          // come apart.
          hasAdministrator,
        ),
        // The section's own symbol, in front of its heading: the same one the
        // left column draws beside the link that got here, so the page confirms
        // where the click landed rather than opening under a bare word. Drawn
        // inline for the reason the arrow is — the page's sprite is assembled
        // from what the left column names, and a heading that referenced a
        // symbol would depend on that column happening to carry one.
        //
        // Read off `CONFIG_SECTIONS`, which is the one list that says what a
        // page of this surface is called and drawn with; a member's page is not
        // in it and gets nothing here, because it draws its provider's logo
        // instead. Never both — two symbols in front of one heading is the
        // second one saying nothing.
        head_icon: payload.section?.mark
          ? ''
          : renderInlineIcon(
              CONFIG_SECTIONS.find((section) => section.id === sectionId)?.icon ?? '',
              'spr-icon',
            ),
        // The pencil beside a member's name. Inline, for the reason the back
        // arrow is: the page's sprite is what the left column named.
        pencil_icon: payload.section?.renameOp ? renderInlineIcon('pencil', 'spr-icon') : '',
        // The pen on each card of a row list, which opens the card for editing
        edit_icon: renderInlineIcon('pencil', 'spr-icon'),
        // The arrow from what a card is to what it matches, and the marks in
        // front of its note and its expiry
        equals_icon: renderInlineIcon('arrow-right', 'spr-icon'),
        note_icon: renderInlineIcon('sticky-note', 'spr-icon'),
        // The arrow out on a match that has a page elsewhere, e.g. in the Entra portal
        external_icon: renderInlineIcon('external-link', 'spr-icon'),
        expiry_icon: renderInlineIcon('calendar-clock', 'spr-icon'),
        // The plus on the Add tile, inline for the same reason.
        add_icon: renderInlineIcon('plus', 'spr-icon'),
        // The chevron on each kind of the Add members modal, as the filter dialog draws its groups
        chevron_icon: renderInlineIcon('chevron-right', 'spr-icon'),
        // And the icon in front of each kind, by name
        kind_icons: Object.fromEntries(
          (payload.section?.tables ?? [])
            .flatMap((table) => table.add?.kinds ?? [])
            .map((kind) => [kind.icon, renderInlineIcon(kind.icon, 'spr-icon')]),
        ),
        // The drawing over an index with nothing in it, for the sections that
        // have one. Asked of the id and not of the entries: the island shows and
        // hides the block as a filter is typed, so it is on the page either way.
        empty_art: sectionEmptyArt(sectionId),
        // And the one over a table of rows with none, as a group with no members
        table_empty_art: tableEmptyArt(sectionId),
        // And the bin in front of every Remove. One icon for the three places a
        // removal is offered from — a card's header, a row's action cell, and the
        // foot of a member's own page — because they are one act on three shapes
        // of thing, and a reader scanning for "the one that deletes" is looking
        // for a picture rather than reading three sentences. Inline, for the
        // reason the plus and the pencil are.
        remove_icon: renderInlineIcon('trash-2', 'spr-icon'),
        warn_icon: renderInlineIcon('triangle-alert', 'spr-icon'),
        // And the arrow in front of Reset. Its own mark rather than the bin:
        // a reset takes values out of the document without deleting anything an
        // operator named, and a row of bins is what a reader scans for when they
        // are looking for the one that deletes.
        reset_icon: renderInlineIcon('rotate-ccw', 'spr-icon'),
        // The mark inside the filter box. The nav happens to carry a search icon
        // on this page, and depending on that is how a page loses its icon the day
        // the left column changes — so this one is its own.
        search_icon: renderInlineIcon('search', 'spr-icon'),
        // The loader's own problems, with the little markup they are allowed to
        // carry — a key in `code`, and the page to go and fix it on as a link.
        // Rendered here rather than in the view for the reason the field help is:
        // a second code path that printed them raw would be one that quietly
        // stopped formatting. The payload keeps the source text, which is what a
        // JSON caller and a log line want.
        problems_html: payload.problems.map((problem) => renderHelp(problem)),
        // The notes whose text is built from values; the fixed ones are in the view
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

/** Says which repositories a rename would break references in, or that it breaks none */
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

/** Says why a change waits for a restart, or null when it applies to the next request */
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

/** The notes of each known-hosts field on the page, by the field's path */
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

/* Short ID Help string */
function configTrail(
  sectionId: string,
  title: string,
  rooted = true,
): { href: string; title: string }[] {
  // Not rooted: the page draws no trail at all. The view keys on there being more
  // than one entry, so a lone crumb — the page you are on, which is never a link —
  // is the shape that means "nothing to draw".
  const trail: { href: string; title: string }[] = [{ href: '', title }];
  if (!rooted) return trail;
  for (let id = sectionId; ; ) {
    const cut = id.lastIndexOf('/');
    if (cut === -1) break;
    id = id.slice(0, cut);
    trail.unshift({ href: `/-/config/${id}`, title: titleOfSection(id) });
  }
  // The overview. Named from the same list the left column names it from, so the
  // two cannot come to call it different things.
  trail.unshift({ href: '/-/config', title: dashboardSectionTitle('config') });
  return trail;
}

/**
 * A section's title without a parsed document, for a page that has no form.
 *
 * A member's page is titled by its own key, which is the only name it has: there
 * is no index to read it off, because there is one such page per member this
 * instance happens to have.
 */
function titleOfSection(id: string): string {
  const member = memberOf(id);
  // A member of a sequence has a position rather than a name, so `0` is not a
  // title. It is drawn as the field model draws it — the noun and its place in the
  // list — which is the only thing that can be said about it without a document.
  if (member) {
    const position = memberPosition(member);
    if (!position) return member.id;
    const noun = nounOf(member.section);
    return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${position.at + 1}`;
  }
  return CONFIG_SECTIONS.find((section) => section.id === id)?.title ?? 'Configuration';
}

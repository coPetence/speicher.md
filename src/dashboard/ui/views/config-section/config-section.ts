import type { Request, Response } from 'express';

import { dashboardSectionTitle } from '../../../dashboard-sections';
import { CONFIG_SECTIONS } from '../../../configurator/config-form/fields';
import { renderHelp } from '../../../configurator/config-form/help';
import {
  GROUP_ID_HELP,
  PROVIDER_ID_HELP,
  memberOf,
  memberPosition,
  nounOf,
} from '../../../configurator/config-form/members';
import { allFields } from '../../../configurator/config-form/model';
import { ConfigSectionPayload } from '../../../configurator/config-page/payloads';
import { markSprite, renderInlineMark } from '../../provider-marks';
import { DashboardResponder } from '../../../respond';
import { sectionEmptyArt } from '../../../../content-reader/empty-state';
import { renderInlineIcon } from '../../../../content-reader/icons';
import { renderTemplate } from '../../../../content-reader/views';

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
    page: (data) =>
      renderTemplate('dashboard/ui/views/config-section', {
        ...(data as unknown as Record<string, unknown>),
        // See `sendConfig`: markup, through the one renderer.
        waiting_consequences_html: data.waiting_consequences.map(renderHelp),
        member_id_help_html: renderHelp(
          sectionId.startsWith('groups/') ? GROUP_ID_HELP : PROVIDER_ID_HELP,
        ),
        // The logos this page draws, once each. Markup, so it belongs to the
        // rendering and not to the payload — see `provider-marks.ts`.
        marks_sprite: markSprite([
          payload.section?.mark ?? '',
          ...(payload.section?.entries ?? []).flatMap((entry) => [
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
        badge_icons: Object.fromEntries(
          [
            ...(payload.section?.entries ?? []).flatMap((entry) =>
              entry.badges.map((badge) => badge.icon),
            ),
            // A field's live check draws its mark from the same map, for the same
            // reason: inline, never out of the page's sprite, which is assembled
            // from what the left column names. Both marks while the check has only
            // been offered, as below — the field draws the two answers hidden and
            // the island picks, so neither may be missing from here.
            ...(payload.section ? allFields([payload.section]) : []).flatMap((field) =>
              field.status ? [field.status.icon] : field.checkHref ? ['check', 'circle-alert'] : [],
            ),
            // And the section's own, drawn at the foot of the page. Both marks
            // when the check has not been made: the page draws the two answers
            // hidden and the island picks — see the note in the template.
            payload.section?.status?.icon ?? '',
            ...(payload.section?.checkHref && !payload.section.status
              ? ['check', 'circle-alert']
              : []),
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
            ...(payload.section ? allFields([payload.section]) : []).flatMap((f) => f.options),
            ...(payload.section?.addOps ?? []).flatMap((op) => [
              ...op.typeOptions,
              ...(op.nameOptions ?? []),
            ]),
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
        // The plus on the Add tile, inline for the same reason.
        add_icon: renderInlineIcon('plus', 'spr-icon'),
        // The drawing over an index with nothing in it, for the sections that
        // have one. Asked of the id and not of the entries: the island shows and
        // hides the block as a filter is typed, so it is on the page either way.
        empty_art: sectionEmptyArt(sectionId),
        // The marks on the rename modal's notes. A note says what a rename
        // reaches, and the two answers are not the same weight: one is a
        // consequence to read before pressing the button, the other is the
        // absence of one. Colour alone does not say which — the whole reason
        // `spr-badge` carries its word — so the level is drawn as well as tinted.
        warn_icon: renderInlineIcon('triangle-alert', 'spr-icon'),
        ok_icon: renderInlineIcon('circle-check', 'spr-icon'),
        // And the bin in front of every Remove. One icon for the three places a
        // removal is offered from — a card's header, a row's action cell, and the
        // foot of a member's own page — because they are one act on three shapes
        // of thing, and a reader scanning for "the one that deletes" is looking
        // for a picture rather than reading three sentences. Inline, for the
        // reason the plus and the pencil are.
        remove_icon: renderInlineIcon('trash-2', 'spr-icon'),
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
      }),
    status,
  });
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
  // An *entry* is named by the provider it is about, so it is titled like any other
  // member: what it is a page of is a name.
  if (member) {
    const position = memberPosition(member);
    if (!position) return member.entry ?? member.id;
    const noun = nounOf(member.section);
    return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${position.at + 1}`;
  }
  return CONFIG_SECTIONS.find((section) => section.id === id)?.title ?? 'Configuration';
}

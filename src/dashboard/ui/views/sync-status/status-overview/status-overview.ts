import type { Request, Response } from 'express';

import { forgeMark } from '../../../../configurator/config-form/members';
import { Level } from '../../../levels';
import { markSprite, renderMarkRef } from '../../../provider-marks';
import { DashboardResponder } from '../../../../respond';
import {
  DEFAULT_REPO_STATES,
  REPO_STATES,
  RepoState,
  StatusPayload,
  repoMatchText,
} from '../../../../status.service';
import { approximateDuration, isoOf, relativeTime } from '../../../../../common/time';
import { emptyStateArt } from '../../../../../content-reader/empty-state';
import { renderInlineIcon } from '../../../../../content-reader/icons';
import { renderTemplate } from '../../../../../content-reader/views';

/** Counts shown in the banner after a redirect from a re-embed or a discovery */
export interface StatusBanners {
  reembedding: number | null;
  discovering: number | null;
}

/** Asking a content source what it holds, on the button and nowhere else */
export const DISCOVER_ICON = 'radar';

/** Sends the sync-status overview: freshness and errors per repository */
export function sendStatus(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  payload: StatusPayload,
  banners: StatusBanners,
): void {
  respond.send(req, res, isAdmin, {
    section: 'status',
    title: 'Sync status',
    /*
      The repository filter, which is the whole of the script on this page: the box
      is a `GET` form the server answers, and the island removes the round trip and
      the button. See `src/global-ui/client-side-islands/status.ts`.
    */
    island: 'status',
    payload,
    page: (data) =>
      renderTemplate('dashboard/ui/views/sync-status/status-overview', {
        scope: data.scope,
        query: data.query,
        tiles: statusTiles(data),
        total: data.totals.repositories,
        state_filter: REPO_STATES.map((state) => ({
          value: state,
          ...STATE_DISPLAY[state],
          count: data.state_counts[state],
          checked: data.states.includes(state),
        })),
        // Every state but all of them is a narrowing, the default included
        state_filtered: data.states.length < REPO_STATES.length,
        // Carried by the links that clear the text, so they keep the states
        states_query: sameStates(data.states, DEFAULT_REPO_STATES)
          ? ''
          : data.states.map((state) => `state=${state}`).join('&'),
        all_states_query: REPO_STATES.map((state) => `state=${state}`).join('&'),
        default_hides_all:
          data.repos.length === 0 &&
          data.totals.repositories > 0 &&
          data.state_counts.unpublished === data.totals.repositories &&
          sameStates(data.states, DEFAULT_REPO_STATES),
        filter_icon: renderInlineIcon('funnel', 'spr-icon'),
        problem_icon: renderInlineIcon('circle-x', 'spr-icon'),
        repos: data.repos.map((repo) => {
          const { label, level } = STATE_DISPLAY[repo.state];
          return {
            name: `${repo.namespace}/${repo.slug}`,
            href: `/-/status/${encodeURIComponent(repo.namespace)}/${encodeURIComponent(repo.slug)}`,
            level,
            /*
              The source's mark, before the name it holds. A reference into the
              page's sprite rather than the shapes: the same two or three marks
              are drawn once per row, and the Octocat is a kilobyte of path.
            */
            markHtml: renderMarkRef(forgeMark(repo.forge_type)),
            /*
              The text the server matched, handed to the row so the island filters
              on the same answer. One function decides it — see `repoMatchText`.
            */
            search: repoMatchText(repo),

            state: label,
            lastRun: relativeTime(repo.last_run_at),
            lastRunAt: isoOf(repo.last_run_at),

            pollEvery: repo.poll_interval_ms ? approximateDuration(repo.poll_interval_ms) : '',
            sha: repo.last_sha?.slice(0, 8) ?? '—',
            documents: repo.documents,
            droppedGrants: repo.dropped_grants,

            problems: repo.last_error ? problemsOf(repo.last_error) : [],
            problemSummary: repo.last_error ? problemSummary(problemsOf(repo.last_error)) : '',
          };
        }),
        /*
          One copy of each mark the rows between them named, and nothing for an
          instance whose every repository came from a kind with no logo.
        */
        marks_sprite: markSprite(data.repos.map((repo) => forgeMark(repo.forge_type))),

        search_icon: renderInlineIcon('search', 'spr-icon'),

        discover_icon: renderInlineIcon(DISCOVER_ICON, 'spr-icon'),
        /*
          The folder with nothing read from it — the drawing `/-/config/sources`
          uses for the same emptiness, which is the page this one sends you to.
        */
        empty_art: emptyStateArt('sources'),
        instance: data.instance,
        reembedding_note:
          banners.reembedding === null
            ? null
            : {
                text: `Re-embedding ${banners.reembedding} chunks for semantic search.`,
              },
        discovering_note:
          banners.discovering === null
            ? null
            : {
                text: `Discovering the repositories of ${banners.discovering} content ${banners.discovering === 1 ? 'source' : 'sources'}.`,
              },
      }),
  });
}

const STATE_DISPLAY: Record<RepoState, { label: string; level: Level }> = {
  ok: { label: 'ok', level: 'ok' },
  failed: { label: 'failed', level: 'fail' },
  stale: { label: 'stale', level: 'warn' },
  'never-synced': { label: 'never synced', level: 'warn' },
  unpublished: { label: 'not published', level: 'idle' },
};

interface Problem {
  location: string | null;
  message: string;
}

const PROBLEM_LINE = /^(\S+?)\s{2,}(\S.*)$/;

/** Splits a repo's error into its problems */
export function problemsOf(error: string): Problem[] {
  const lines = error
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const matches = lines.map((line) => PROBLEM_LINE.exec(line));
  if (lines.length > 0 && matches.every((match) => match !== null)) {
    return matches.map((match) => ({ location: match![1], message: match![2] }));
  }
  return [{ location: null, message: error.trim() }];
}

/** The line a list of problems folds into, e.g. `2 problems in .speicher.yaml` */
export function problemSummary(problems: Problem[]): string {
  const files = [
    ...new Set(
      problems.flatMap((problem) =>
        problem.location ? [problem.location.replace(/:\d+$/, '')] : [],
      ),
    ),
  ];
  const count = `${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}`;
  if (files.length === 1) return `${count} in ${files[0]}`;
  if (files.length > 1) return `${count} in ${files.length} files`;
  return count;
}

function sameStates(a: readonly RepoState[], b: readonly RepoState[]): boolean {
  return a.length === b.length && a.every((state) => b.includes(state));
}

/**
 * The mark on each summary tile: what is being counted, never how it is going.
 *
 * The level already says the second thing, in colour and in the label's own word,
 * and a tile whose picture changed from a tick to a cross would be saying it a
 * third time — in the one channel a reader may not have. So `Failed` carries a
 * crossed circle whether the count is nought or nine.
 */
const STAT_ICONS = {
  repositories: 'book-marked',
  pages: 'file-text',
  failed: 'circle-x',
  stale: 'clock-alert',
  dropped: 'shield-x',
  dead: 'octagon-x',
} as const;

/** One tile of the row over the table; `href` is where its count is acted on */
interface StatusTile {
  label: string;
  value: string;
  level: Level;
  iconHtml: string;
  href?: string;
  tone?: 'blue' | 'violet';
}

/** Derives the summary tiles for the status page from the payload */
function statusTiles(payload: StatusPayload): StatusTile[] {
  const { repositories, pages, failed, stale, dropped_grants: dropped } = payload.totals;
  // The instance's own figures, so a filtered list leaves every tile where it was
  const tile = (
    label: string,
    value: number,
    level: Level,
    icon: (typeof STAT_ICONS)[keyof typeof STAT_ICONS],
    href?: string,
  ): StatusTile => ({
    label,
    value: String(value),
    level,
    iconHtml: renderInlineIcon(icon, 'spr-icon'),
    ...(href === undefined ? {} : { href }),
  });

  /*
    A tile links to the page where its count can be acted on, and only for a
    caller who can open that page. `/-/logs` and `/-/graph` are administrator-only,
    and `payload.instance` is the half of the payload only an administrator gets —
    so a maintainer's tiles carry no link that would 404 on them.
  */
  const isAdmin = payload.instance !== null;

  /*
    A count of nothing is `idle`, never `ok`.

    These three tiles count things that have gone wrong, and `ok` is the green of
    the status vocabulary: `Failed 0` in green said "failing, and that is fine",
    which as a 3px bar down one edge nobody read and as a filled panel is the first
    thing on the page. So the colour is earned by there being something in the
    tile — grey while the number is nought, red or amber the moment it is not —
    and the tiles that colour are exactly the ones an operator can act on.

    Which is also why `ok` is not used here at all: a green tile would have to
    stand for a fact about the instance rather than for the absence of one, and
    "nothing is failing" is what the whole page says by having no red on it.
  */
  return [
    { ...tile('Repositories', repositories, 'idle', STAT_ICONS.repositories), tone: 'blue' },
    { ...tile('Pages', pages, 'idle', STAT_ICONS.pages), tone: 'violet' },
    tile('Failed', failed, failed > 0 ? 'fail' : 'idle', STAT_ICONS.failed),
    tile('Stale', stale, stale > 0 ? 'warn' : 'idle', STAT_ICONS.stale),
    tile(
      'Dropped grants',
      dropped,
      dropped > 0 ? 'warn' : 'idle',
      STAT_ICONS.dropped,
      isAdmin ? '/-/graph' : undefined,
    ),
    /*
      Dead jobs, as a figure rather than as a line in a panel of instance facts.

      It is the one thing that panel said which nothing else on this page does, and
      it is a count of work that has stopped — which is what this row is for. Admin
      only, because `instance` is: whose jobs they are is instance-wide, and a
      maintainer's tile would be counting somebody else's failures. `/-/logs` is
      where they can be retried, so the tile links there.
    */
    ...(payload.instance
      ? [
          tile(
            'Dead jobs',
            payload.instance.dead_jobs,
            payload.instance.dead_jobs > 0 ? 'fail' : 'idle',
            STAT_ICONS.dead,
            '/-/logs',
          ),
        ]
      : []),
  ];
}

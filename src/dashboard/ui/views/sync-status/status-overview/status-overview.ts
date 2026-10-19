import type { Request, Response } from 'express';

import { forgeMark } from '../../../../configurator/config-form/members';
import { Level } from '../../../levels';
import { markSprite, renderMarkRef } from '../../../provider-marks';
import { DashboardResponder } from '../../../../respond';
import { SYNCING_ICON } from '../repo-status/repo-status';
import {
  DEFAULT_REPO_FILTER,
  FILTER_DIMENSIONS,
  FilterDimension,
  PageRange,
  repoFilterQuery,
  repoMatchText,
} from '../../../../status/repo-filter';
import { RepoSort } from '../../../../status/repo-sort';
import { RepoState, StatusPayload } from '../../../../status/status.types';
import { approximateDuration, isoOf, relativeTime } from '../../../../../common/time';
import { emptyStateArt } from '../../../../../content-reader/empty-state';
import { renderInlineIcon } from '../../../../../content-reader/icons';
import { renderTemplate } from '../../../../../content-reader/views';

/** Counts shown in the banner after a redirect from a re-embed */
export interface StatusBanners {
  reembedding: number | null;
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
        filter_groups: filterGroups(data),
        filter_applied: FILTER_DIMENSIONS.filter((key) => data.filter[key].length > 0).length,
        facet_rows: JSON.stringify(data.facet_rows),
        sort: data.sort,
        sort_name_href: sortHref(data, 'name'),
        sort_pages_href: sortHref(data, data.sort === 'pages-desc' ? 'pages-asc' : 'pages-desc'),
        sort_pages_icon: renderInlineIcon(
          data.sort === 'pages-desc'
            ? 'arrow-down'
            : data.sort === 'pages-asc'
              ? 'arrow-up'
              : 'arrow-up-down',
          'spr-icon',
        ),
        repos_matching: data.facet_rows.filter((row) =>
          FILTER_DIMENSIONS.every(
            (key) =>
              data.filter[key].length === 0 || (data.filter[key] as string[]).includes(row[key]),
          ),
        ).length,
        default_hides_all:
          data.repos.length === 0 &&
          data.totals.repositories > 0 &&
          data.facets.state.find((option) => option.value === 'unpublished')?.count ===
            data.totals.repositories &&
          repoFilterQuery(data.filter) === repoFilterQuery(DEFAULT_REPO_FILTER),
        filter_icon: renderInlineIcon('funnel', 'spr-icon'),
        clear_icon: renderInlineIcon('x', 'spr-icon'),
        chevron_icon: renderInlineIcon('chevron-right', 'spr-icon'),
        problem_icon: renderInlineIcon('circle-x', 'spr-icon'),
        syncing_icon: renderInlineIcon(SYNCING_ICON, 'spr-icon spr-spin'),
        queued_icon: renderInlineIcon(QUEUED_ICON, 'spr-icon'),
        busy:
          data.repos.some((repo) => repo.activity !== null) ||
          (data.instance !== null && data.instance.running_jobs + data.instance.queued_jobs > 0),
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
            activity: repo.activity,
            lastRun: relativeTime(repo.last_run_at),
            lastRunAt: isoOf(repo.last_run_at),

            pollEvery: repo.poll_interval_ms ? approximateDuration(repo.poll_interval_ms) : '',
            sha: repo.last_sha?.slice(0, 8) ?? '—',
            documents: repo.documents,

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
          data.instance && data.instance.discovering.length > 0
            ? {
                text: `Speicher is discovering the repositories of ${listed(data.instance.discovering)}.`,
              }
            : null,
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

const QUEUED_ICON = 'clock';

/** `gh`, `gh and gl`, `gh, gl and git` */
function listed(items: string[]): string {
  return items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function sortHref(data: StatusPayload, sort: RepoSort): string {
  const params = new URLSearchParams(repoFilterQuery(data.filter));
  if (data.query) params.set('q', data.query);
  if (sort !== 'name') params.set('sort', sort);
  return `/-/status?${params.toString()}`;
}

const PAGE_RANGE_LABELS: Record<PageRange, string> = {
  none: 'No pages',
  '1-9': '1-9',
  '10-99': '10-99',
  '100+': '100 or more',
};

const FILTER_GROUPS: {
  key: FilterDimension;
  label: string;
  icon: string;
  label_of: (value: string) => string;
  searchable: boolean;
}[] = [
  {
    key: 'state',
    label: 'State',
    icon: 'circle-dot',
    label_of: (value) => STATE_DISPLAY[value as RepoState].label,
    searchable: false,
  },
  { key: 'owner', label: 'Owner', icon: 'users', label_of: (value) => value, searchable: true },
  {
    key: 'source',
    label: 'Content source',
    icon: 'database',
    label_of: (value) => value,
    searchable: true,
  },
  {
    key: 'pages',
    label: 'Pages',
    icon: 'file-text',
    label_of: (value) => PAGE_RANGE_LABELS[value as PageRange],
    searchable: false,
  },
];

function filterGroups(data: StatusPayload) {
  return FILTER_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    searchable: group.searchable,
    icon: renderInlineIcon(group.icon, 'spr-icon'),
    selected: data.filter[group.key].length,
    options: data.facets[group.key].map((option) => ({
      value: option.value,
      label: group.label_of(option.value),
      count: option.count,
      checked: (data.filter[group.key] as string[]).includes(option.value),
    })),
  }));
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
  running: SYNCING_ICON,
  queued: QUEUED_ICON,
  failed: 'circle-x',
  stale: 'clock-alert',
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
  const { repositories, pages, failed, stale } = payload.totals;
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
    ...(payload.instance
      ? [
          {
            ...tile('Running', payload.instance.running_jobs, 'idle', STAT_ICONS.running),
            ...(payload.instance.running_jobs > 0
              ? {
                  tone: 'blue' as const,
                  iconHtml: renderInlineIcon(STAT_ICONS.running, 'spr-icon spr-spin'),
                }
              : {}),
          },
          tile('Queued', payload.instance.queued_jobs, 'idle', STAT_ICONS.queued),
        ]
      : []),
    tile('Failed', failed, failed > 0 ? 'fail' : 'idle', STAT_ICONS.failed),
    tile('Stale', stale, stale > 0 ? 'warn' : 'idle', STAT_ICONS.stale),
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

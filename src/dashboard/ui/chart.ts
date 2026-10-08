/**
 * Bar chart SVG for stats views
 *
 * Produces a stacked bar of web (people) and MCP (agents) views per time bucket
 * The chart fills a fixed frame and scales all bars to the peak total in the series
 * Empty points are skipped in the SVG but appear as gaps in the label axis
 *
 * Not an interactive chart library to keep the bundle small, no tooltips or
 * click handling
 */

import { Granularity, bucketLabel, bucketStart } from '../analytics/buckets';

export interface ChartPoint {
  label: string;
  people: number;
  agents: number;
}

const HEIGHT = 40;
const BAR = 6;
const GAP = 2;

/**
 * Fill a time series to a fixed number of slots, backfilling missing buckets
 *
 * The data from the query may have gaps; this pads every slot from now back to
 * the requested range so the chart always has the same number of bars
 */
export function densify(
  rows: { bucket: Date; webViews: number; mcpViews: number }[],
  now: Date,
  slots: number,
  timeZone: string,
  granularity: Granularity,
): ChartPoint[] {
  const step = granularity === 'hour' ? 3_600_000 : 86_400_000;
  const counts = new Map(
    rows.map((row) => [row.bucket.toISOString(), { people: row.webViews, agents: row.mcpViews }]),
  );

  const seen = new Set<string>();
  const points: ChartPoint[] = [];
  for (let i = slots - 1; i >= 0; i -= 1) {
    const bucket = bucketStart(new Date(now.getTime() - i * step), timeZone, granularity);
    const key = bucket.toISOString();
    if (seen.has(key)) continue;
    seen.add(key);
    const found = counts.get(key);
    points.push({
      label: bucketLabel(bucket, timeZone, granularity),
      people: found?.people ?? 0,
      agents: found?.agents ?? 0,
    });
  }
  return points;
}

/**
 * Render points as a stacked SVG bar chart
 *
 * Web views sit above MCP views in each bar; MCP bar is semi-transparent
 */
export function barChart(points: ChartPoint[], title: string): string {
  if (points.length === 0) return '';

  const width = points.length * (BAR + GAP) - GAP;
  const peak = Math.max(...points.map((p) => p.people + p.agents), 1);

  const bars = points
    .map((point, index) => {
      const x = index * (BAR + GAP);
      const total = point.people + point.agents;

      if (total === 0) return '';
      const peopleHeight = (point.people / peak) * HEIGHT;
      const agentsHeight = (point.agents / peak) * HEIGHT;
      const parts = [
        agentsHeight > 0
          ? rect(x, HEIGHT - agentsHeight - peopleHeight, agentsHeight, ' opacity="0.45"')
          : '',
        peopleHeight > 0 ? rect(x, HEIGHT - peopleHeight, peopleHeight, '') : '',
      ];
      return parts.join('');
    })
    .join('');

  return [
    `<svg class="spr-chart" viewBox="0 0 ${round(width)} ${HEIGHT}"`,
    ` preserveAspectRatio="none" role="img" aria-labelledby="spr-chart-title">`,
    `<title id="spr-chart-title">${escapeText(title)}</title>`,
    bars,
    '</svg>',
  ].join('');
}

function rect(x: number, y: number, height: number, extra: string): string {
  return `<rect x="${round(x)}" y="${round(y)}" width="${BAR}" height="${round(height)}"${extra} />`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Sample data for preview in the admin panel settings
 *
 * Not: the last row has 28 agents with 1 person to show the bars can exceed the
 * usual ratio
 */
export const CHART_EXAMPLE: ChartPoint[] = [
  { label: 'Mon', people: 12, agents: 3 },
  { label: 'Tue', people: 18, agents: 4 },
  { label: 'Wed', people: 9, agents: 2 },
  { label: 'Thu', people: 0, agents: 0 },
  { label: 'Fri', people: 22, agents: 6 },
  { label: 'Sat', people: 3, agents: 1 },
  { label: 'Sun', people: 0, agents: 0 },
  { label: 'Mon', people: 26, agents: 9 },
  { label: 'Tue', people: 31, agents: 12 },
  { label: 'Wed', people: 17, agents: 5 },
  { label: 'Thu', people: 20, agents: 7 },
  { label: 'Fri', people: 14, agents: 4 },
  { label: 'Sat', people: 2, agents: 28 },
  { label: 'Sun', people: 1, agents: 0 },
];

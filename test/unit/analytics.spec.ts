import { bucketLabel, bucketStart, isKnownTimeZone } from '../../src/dashboard/analytics/buckets';
import {
  HLL_REGISTERS,
  addToSketch,
  emptySketch,
  estimateSketch,
  newSalt,
  unionSketch,
} from '../../src/dashboard/analytics/hll';
import { MAX_BUCKETS, ViewBuffer } from '../../src/dashboard/analytics/recorder';
import { CHART_EXAMPLE, barChart, densify } from '../../src/dashboard/ui/chart';

describe('the reader sketch', () => {
  const salt = Buffer.alloc(32, 7);

  const sketchOf = (members: string[]): Buffer => {
    const sketch = emptySketch();
    for (const member of members) addToSketch(sketch, salt, member);
    return sketch;
  };

  it('counts nothing before anything is added', () => {
    expect(estimateSketch(emptySketch())).toBe(0);
    expect(estimateSketch(null)).toBe(0);
    expect(estimateSketch(Buffer.alloc(5))).toBe(0);
  });

  it('is exact on a team small enough for the number to matter', () => {
    for (const size of [1, 2, 3, 5, 8, 12]) {
      const members = Array.from({ length: size }, (_, i) => `user-${i}`);
      expect(estimateSketch(sketchOf(members))).toBe(size);
    }
  });

  it('is an estimate above that, and says so by being one', () => {
    for (const size of [40, 100, 2000]) {
      const members = Array.from({ length: size }, (_, i) => `user-${i}`);
      const estimate = estimateSketch(sketchOf(members));
      expect(Math.abs(estimate - size) / size).toBeLessThan(0.1);
    }
  });

  it('counts a repeat reader once', () => {
    const sketch = sketchOf(['alice', 'alice', 'alice', 'bob']);
    expect(estimateSketch(sketch)).toBe(2);
  });

  it('unions exactly, so flushing often and flushing once agree', () => {
    const first = sketchOf(['alice', 'bob']);
    const second = sketchOf(['bob', 'carol']);
    const merged = unionSketch(first, second);
    expect(estimateSketch(merged)).toBe(estimateSketch(sketchOf(['alice', 'bob', 'carol'])));
  });

  it('holds no member, at a fixed size whatever it counted', () => {
    const one = sketchOf(['ferdinand@example.test']);
    const many = sketchOf(Array.from({ length: 40 }, (_, i) => `user-${i}`));
    expect(one.length).toBe(HLL_REGISTERS);
    expect(many.length).toBe(HLL_REGISTERS);
    expect(one.includes(Buffer.from('ferdinand@example.test'))).toBe(false);
  });

  it('hashes the same person differently under a different salt', () => {
    const other = newSalt();
    const a = emptySketch();
    const b = emptySketch();
    addToSketch(a, salt, 'alice');
    addToSketch(b, other, 'alice');
    expect(a.equals(b)).toBe(false);
  });
});

describe('bucket boundaries', () => {
  it('recognises a zone the runtime knows, and refuses one it does not', () => {
    expect(isKnownTimeZone('Europe/Berlin')).toBe(true);
    expect(isKnownTimeZone('UTC')).toBe(true);
    expect(isKnownTimeZone('Europe/Berln')).toBe(false);
  });

  it('starts the day in the configured zone, not in UTC', () => {
    const at = new Date('2026-08-27T23:30:00Z');
    expect(bucketLabel(bucketStart(at, 'Europe/Berlin', 'day'), 'Europe/Berlin', 'day')).toBe(
      '2026-08-28',
    );
    expect(bucketLabel(bucketStart(at, 'UTC', 'day'), 'UTC', 'day')).toBe('2026-08-27');
  });

  it('puts everything in one local day into one bucket', () => {
    const zone = 'Europe/Berlin';
    const morning = bucketStart(new Date('2026-08-28T06:00:00Z'), zone, 'day');
    const evening = bucketStart(new Date('2026-08-28T20:00:00Z'), zone, 'day');
    expect(morning.getTime()).toBe(evening.getTime());
  });

  it('survives a daylight-saving transition', () => {
    const zone = 'Europe/Berlin';
    const before = new Date('2026-03-28T23:30:00Z');
    const after = new Date('2026-03-29T12:00:00Z');
    expect(bucketLabel(bucketStart(before, zone, 'day'), zone, 'day')).toBe('2026-03-29');
    expect(bucketStart(before, zone, 'day').getTime()).toBe(
      bucketStart(after, zone, 'day').getTime(),
    );
  });

  it('separates hours when asked to, and labels them in the zone', () => {
    const zone = 'Europe/Berlin';
    const at = new Date('2026-08-28T12:20:00Z');
    expect(bucketLabel(bucketStart(at, zone, 'hour'), zone, 'hour')).toBe('2026-08-28 14:00');
    expect(
      bucketStart(at, zone, 'hour').getTime() ===
        bucketStart(new Date('2026-08-28T13:20:00Z'), zone, 'hour').getTime(),
    ).toBe(false);
  });
});

describe('the buffer', () => {
  const key = { repoId: 'r1', slugPath: 'guide/setup', surface: 'web' as const };
  const at = new Date('2026-08-28T10:00:00Z');

  it('adds up reads of one page into one bucket', () => {
    const buffer = new ViewBuffer();
    buffer.record(key, at, 'UTC', 'day', null);
    buffer.record(key, at, 'UTC', 'day', null);
    const { views } = buffer.drain();
    expect(views).toHaveLength(1);
    expect(views[0].views).toBe(2);
  });

  it('writes a daily row even when the instance is hourly, and an hourly one beside it', () => {
    const buffer = new ViewBuffer();
    buffer.record(key, at, 'UTC', 'hour', null);
    const { views } = buffer.drain();
    const byGranularity = Object.fromEntries(views.map((v) => [v.granularity, v]));
    expect(Object.keys(byGranularity).sort()).toEqual(['day', 'hour']);
    expect(byGranularity.day.views).toBe(1);
    expect(byGranularity.hour.views).toBe(1);
  });

  it('never puts reach on an hourly row', () => {
    const buffer = new ViewBuffer();
    buffer.record(key, at, 'UTC', 'hour', 'oidc:alice');
    const { views } = buffer.drain();
    expect(views.find((v) => v.granularity === 'hour')?.readers).toBeNull();
    expect(views.find((v) => v.granularity === 'day')?.readers).not.toBeNull();
  });

  it('counts an anonymous read without inventing a reader', () => {
    const buffer = new ViewBuffer();
    buffer.record(key, at, 'UTC', 'day', null);
    const { views } = buffer.drain();
    expect(views[0].views).toBe(1);
    expect(views[0].readers).toBeNull();
  });

  it('counts one person reading twice as two reads and one reader', () => {
    const buffer = new ViewBuffer();
    buffer.record(key, at, 'UTC', 'day', 'oidc:alice');
    buffer.record(key, at, 'UTC', 'day', 'oidc:alice');
    buffer.record(key, at, 'UTC', 'day', 'oidc:bob');
    const { views } = buffer.drain();
    expect(views[0].views).toBe(3);
    expect(estimateSketch(views[0].readers)).toBe(2);
  });

  it('keeps one salt across a whole local day, or a reader is counted twice', () => {
    const buffer = new ViewBuffer();
    const zone = 'Europe/Berlin';
    buffer.record(key, new Date('2026-08-28T08:00:00Z'), zone, 'day', 'oidc:alice');
    buffer.record(key, new Date('2026-08-28T21:30:00Z'), zone, 'day', 'oidc:alice');
    const { views } = buffer.drain();
    expect(views).toHaveLength(1);
    expect(views[0].views).toBe(2);
    expect(estimateSketch(views[0].readers)).toBe(1);
  });

  it('separates surfaces, so an agent and a person are never one number', () => {
    const buffer = new ViewBuffer();
    buffer.record(key, at, 'UTC', 'day', null);
    buffer.record({ ...key, surface: 'mcp' }, at, 'UTC', 'day', null);
    const { views } = buffer.drain();
    expect(views.map((v) => v.surface).sort()).toEqual(['mcp', 'web']);
  });

  it('normalises a search query, so one missing page is one row', () => {
    const buffer = new ViewBuffer();
    buffer.recordMiss('  Pricing ', at, 'UTC');
    buffer.recordMiss('pricing', at, 'UTC');
    const { misses } = buffer.drain();
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ query: 'pricing', misses: 2 });
  });

  it('ignores an empty query rather than storing a row for it', () => {
    const buffer = new ViewBuffer();
    buffer.recordMiss('   ', at, 'UTC');
    expect(buffer.drain().misses).toHaveLength(0);
  });

  it('stops taking new buckets rather than growing without bound', () => {
    const buffer = new ViewBuffer();
    for (let i = 0; i < MAX_BUCKETS + 5; i += 1) {
      buffer.record({ repoId: 'r1', slugPath: `p/${i}`, surface: 'web' }, at, 'UTC', 'day', null);
    }
    const { views, dropped } = buffer.drain();
    expect(views).toHaveLength(MAX_BUCKETS);
    expect(dropped).toBe(5);
  });

  it('empties on drain, so a flush cannot count the same read twice', () => {
    const buffer = new ViewBuffer();
    buffer.record(key, at, 'UTC', 'day', null);
    expect(buffer.drain().views).toHaveLength(1);
    expect(buffer.drain().views).toHaveLength(0);
    expect(buffer.size).toBe(0);
  });
});

describe('the chart', () => {
  const at = new Date('2026-08-28T12:00:00Z');

  it('fills the window, so scattered reads do not read as steady traffic', () => {
    const points = densify(
      [{ bucket: bucketStart(at, 'UTC', 'day'), webViews: 5, mcpViews: 1 }],
      at,
      7,
      'UTC',
      'day',
    );
    expect(points).toHaveLength(7);
    expect(points.filter((p) => p.people > 0)).toHaveLength(1);
    expect(points[6]).toMatchObject({ people: 5, agents: 1 });
  });

  it('draws an empty day as an empty slot, never as a value', () => {
    const svg = barChart(
      [
        { label: 'Mon', people: 4, agents: 0 },
        { label: 'Tue', people: 0, agents: 0 },
        { label: 'Wed', people: 8, agents: 0 },
      ],
      'Reads',
    );
    expect(svg.match(/<rect/g) ?? []).toHaveLength(2);
  });

  it('carries no inline style, which the CSP would refuse anyway', () => {
    const svg = barChart(CHART_EXAMPLE, 'Reads');
    expect(svg).not.toContain('style=');
    expect(svg).toMatch(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+"/);
  });

  it('hard-codes no colour, so a template recolours it', () => {
    const svg = barChart(CHART_EXAMPLE, 'Reads');
    expect(svg).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|\bfill="(?!currentColor)[a-z]/i);
  });

  it('scales to its own peak, so a quiet window is still legible', () => {
    const quiet = barChart([{ label: 'Mon', people: 1, agents: 0 }], 'Reads');
    const busy = barChart([{ label: 'Mon', people: 900, agents: 0 }], 'Reads');
    expect(quiet.match(/height="([\d.]+)"/)?.[1]).toBe(busy.match(/height="([\d.]+)"/)?.[1]);
  });

  it('names itself, since an svg has no accessible name', () => {
    const svg = barChart(CHART_EXAMPLE, 'Reads over two weeks');
    expect(svg).toContain('role="img"');
    expect(svg).toContain('<title id="spr-chart-title">Reads over two weeks</title>');
  });

  it('escapes its title rather than trusting where it came from', () => {
    const svg = barChart(CHART_EXAMPLE, '<script>alert(1)</script>');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('draws nothing at all rather than an empty frame', () => {
    expect(barChart([], 'Reads')).toBe('');
  });
});

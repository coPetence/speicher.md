import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OVERRIDDEN_TOKENS, PALETTE_KEYS, themeOverrides } from '../../src/config/palette';

const SHEET = readFileSync(join(__dirname, '../../src/global-ui/theme/default.css'), 'utf8');

// Tokens the sheet defines for the admin UI alone. They live here so they get a dark
// variant with everything else, but they are not offered in the palette.
const ADMIN_ONLY_TOKENS = new Set(['--spr-bar-bg']);

describe('the theme overrides', () => {
  it('says nothing about an instance that overrides nothing', () => {
    expect(themeOverrides(undefined)).toBeNull();
    expect(themeOverrides({})).toBeNull();
    expect(themeOverrides({ template: 'editorial' })).toBeNull();
    expect(themeOverrides({ palette: {} })).toBeNull();
    expect(themeOverrides({ palette: { light: {} } })).toBeNull();
    expect(themeOverrides({ font: 'system' })).toBeNull();
  });

  it('writes each scheme inside the query that selects it, and never on a bare root', () => {
    const css = themeOverrides({ palette: { light: { accent: '#123456' } } })!;
    expect(css).toContain('@media (prefers-color-scheme: light)');
    expect(css).toContain('--spr-accent:#123456');
    expect(css).not.toContain('prefers-color-scheme: dark');
    expect(css.replace(/@media[^{]+\{:root\{[^}]*\}\}/g, '')).toBe('');
  });

  it('drops the query entirely for a reader who has fixed the scheme', () => {
    const both = { palette: { light: { accent: '#2f5d8a' }, dark: { accent: '#86b3de' } } };

    const dark = themeOverrides(both, 'dark')!;
    expect(dark).toBe(':root{--spr-accent:#86b3de}');

    const light = themeOverrides(both, 'light')!;
    expect(light).toBe(':root{--spr-accent:#2f5d8a}');

    expect(themeOverrides({ palette: { light: { accent: '#2f5d8a' } } }, 'dark')).toBeNull();
  });

  it('squares every corner when rounded corners are turned off, in both schemes', () => {
    expect(themeOverrides({ rounded_corners: true })).toBeNull();
    for (const scheme of [null, 'light', 'dark'] as const) {
      expect(themeOverrides({ rounded_corners: false }, scheme)).toBe(
        ':root{--spr-radius:0;--spr-radius-sm:0;--spr-radius-lg:0;--spr-radius-xl:0}',
      );
    }
  });

  it('keeps the typeface out of the scheme, because a face does not change with the light', () => {
    for (const scheme of [null, 'light', 'dark'] as const) {
      expect(themeOverrides({ font: 'serif' }, scheme)).toContain('--spr-font-body:Georgia');
    }
  });

  it('leaves a scheme alone when it was not answered', () => {
    const css = themeOverrides({
      palette: { light: { bg: '#ffffff', fg: '#111111' } },
    })!;
    expect(css).toContain('prefers-color-scheme: light');
    expect(css).not.toContain('prefers-color-scheme: dark');
  });

  it('answers both when both are given, and keeps them apart', () => {
    const css = themeOverrides({
      palette: { light: { accent: '#2f5d8a' }, dark: { accent: '#86b3de' } },
    })!;
    const light = /light\)\{:root\{([^}]*)\}/.exec(css)?.[1];
    const dark = /dark\)\{:root\{([^}]*)\}/.exec(css)?.[1];
    expect(light).toContain('#2f5d8a');
    expect(light).not.toContain('#86b3de');
    expect(dark).toContain('#86b3de');
    expect(dark).not.toContain('#2f5d8a');
  });

  it('mixes the neutrals nobody answered out of the two that carry a page', () => {
    const css = themeOverrides({ palette: { light: { bg: '#0b1220', fg: '#e8eef7' } } })!;
    for (const key of ['muted', 'line', 'surface']) {
      expect(css).toContain(`--spr-${key}:color-mix(in oklab, var(--spr-fg)`);
    }
  });

  it('does not mix over a colour that was asked for', () => {
    const css = themeOverrides({
      palette: { light: { bg: '#ffffff', fg: '#000000', line: '#ff0000' } },
    })!;
    expect(css).toContain('--spr-line:#ff0000');
    expect(css).not.toContain('--spr-line:color-mix');
    expect(css).toContain('--spr-muted:color-mix');
  });

  it('mixes nothing when there is no ground to mix against', () => {
    const css = themeOverrides({ palette: { light: { accent: '#2f5d8a' } } })!;
    expect(css).not.toContain('color-mix');
  });

  it('refuses anything that is not a hex colour, whatever the schema let through', () => {
    const nasty = [
      'red',
      '#12345',
      'url(https://evil.example/x)',
      '#fff;} a[href^="/handbook/pay"] { background: url(https://evil.example/x)',
      '#ff00ff /*',
      '',
      '  ',
    ];
    for (const value of nasty) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(themeOverrides({ palette: { light: { accent: value } as any } })).toBeNull();
    }
  });

  it('expands three digits, because that is what a brand guide prints', () => {
    const css = themeOverrides({ palette: { light: { accent: '#F0A' } } })!;
    expect(css).toContain('--spr-accent:#ff00aa');
  });

  it('takes the code-size correction back out when the body face becomes the code face', () => {
    const mono = themeOverrides({ font: 'mono' })!;
    expect(mono).toContain('--spr-font-body:var(--spr-font-mono)');
    expect(mono).toContain('--spr-font-size-code:1em');

    const serif = themeOverrides({ font: 'serif' })!;
    expect(serif).not.toContain('--spr-font-size-code');
  });

  it('names an unrecognised face nothing at all', () => {
    expect(themeOverrides({ font: 'Comic Sans MS' })).toBeNull();
  });

  it('writes only tokens the base stylesheet actually defines', () => {
    const defined = new Set(SHEET.match(/--spr-[a-z0-9-]+(?=\s*:)/g) ?? []);
    expect(defined.size).toBeGreaterThan(20);
    for (const token of OVERRIDDEN_TOKENS) expect([...defined]).toContain(token);
  });

  it('offers every colour the sheet chooses, and only the ones it chooses', () => {
    const chosen = new Set(
      [...SHEET.matchAll(/(--spr-[a-z0-9-]+)\s*:\s*#[0-9a-fA-F]{3,6}\s*;/g)].map(
        (match) => match[1],
      ),
    );
    const themeable = [...chosen].filter((token) => !ADMIN_ONLY_TOKENS.has(token));
    expect([...PALETTE_KEYS].map((key) => `--spr-${key}`).sort()).toEqual(themeable.sort());

    for (const token of chosen) {
      const dark = SHEET.slice(SHEET.indexOf('prefers-color-scheme: dark'));
      expect(dark).toContain(`${token}:`);
    }
  });

  it('describes every colour it offers, in the schema the loader reads', () => {
    const schema = JSON.parse(
      readFileSync(join(__dirname, '../../src/config/schema/instance.schema.json'), 'utf8'),
    );
    const palette = schema.$defs.palette;
    expect(Object.keys(palette.properties).sort()).toEqual([...PALETTE_KEYS].sort());
    for (const key of PALETTE_KEYS) {
      expect(palette.properties[key].$ref).toBe('#/$defs/colour');
      expect(palette.properties[key].description).toBeTruthy();
    }
  });
});

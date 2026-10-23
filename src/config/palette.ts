/**
 * Theme palette and font token generation
 *
 * Converts a palette config into CSS custom property declarations
 * Missing colours are mixed from fg and bg when those are present
 * Font stacks are referenced by short name, mono uses a variable for runtime selection
 *
 * Not using CSS cascade layers to keep the output compatible with older tools that
 * strip unknown at-rules
 */

import type { PaletteConfig, ThemeConfig } from './types';

export type ColourScheme = 'light' | 'dark';

export const PALETTE_GROUPS = [
  {
    id: 'core',
    keys: ['bg', 'fg', 'accent', 'muted', 'line', 'surface'],
  },
  {
    id: 'highlight',
    keys: ['warn-bg', 'warn-fg', 'mark-bg', 'mark-fg'],
  },
  {
    id: 'callout',
    keys: ['callout-info', 'callout-tip', 'callout-important', 'callout-warning', 'callout-danger'],
  },
  {
    id: 'code',
    keys: [
      'code-keyword',
      'code-type',
      'code-function',
      'code-tag',
      'code-attr',
      'code-string',
      'code-number',
      'code-variable',
      'code-comment',
      'code-meta',
      'code-inserted',
      'code-inserted-bg',
      'code-deleted',
      'code-deleted-bg',
    ],
  },
] as const;

export type PaletteGroupId = (typeof PALETTE_GROUPS)[number]['id'];

export const PALETTE_KEYS = PALETTE_GROUPS.flatMap(
  (group) => group.keys,
) as readonly PaletteGroupKey[];

type PaletteGroupKey = (typeof PALETTE_GROUPS)[number]['keys'][number];

export type PaletteKey = PaletteGroupKey;

/** Mix percentages for derived colours when the key is absent from the palette */
const MIXED: Partial<Record<PaletteKey, number>> = { muted: 65, line: 11, surface: 4 };

const FONT_STACKS: Record<string, string> = {
  sans: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  serif: "Georgia, Cambria, 'Times New Roman', Times, serif",

  mono: 'var(--spr-font-mono)',
};

const RADIUS_TOKENS = ['--spr-radius', '--spr-radius-sm', '--spr-radius-lg', '--spr-radius-xl'];

/** Token names emitted by themeOverrides */
export const OVERRIDDEN_TOKENS = [
  ...PALETTE_KEYS.map((key) => `--spr-${key}`),
  '--spr-font-body',
  '--spr-font-size-code',
  ...RADIUS_TOKENS,
];

// Matches 3- or 6-digit hex colour; capture group is the digits without #
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Normalises a hex string to six-digit lower-case form, or returns null */
function hex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = HEX.exec(value.trim());
  if (!match) return null;
  const digits = match[1].toLowerCase();
  return digits.length === 3
    ? `#${digits[0]}${digits[0]}${digits[1]}${digits[1]}${digits[2]}${digits[2]}`
    : `#${digits}`;
}

/** Produces semicolon-joined CSS declarations for a single scheme's palette */
function declarations(palette: PaletteConfig | undefined): string {
  if (!palette) return '';

  const out: string[] = [];
  for (const key of PALETTE_KEYS) {
    const value = hex(palette[key]);
    if (value !== null) out.push(`--spr-${key}:${value}`);
  }
  if (out.length === 0) return '';

  const grounded = hex(palette.bg) !== null || hex(palette.fg) !== null;
  if (grounded) {
    for (const [key, share] of Object.entries(MIXED)) {
      if (hex(palette[key as PaletteKey]) !== null) continue;
      out.push(`--spr-${key}:color-mix(in oklab, var(--spr-fg) ${share}%, var(--spr-bg))`);
    }
  }

  return out.join(';');
}

/**
 * Returns concatenated CSS with font, corner and colour overrides
 *
 * When scheme is null both schemes are emitted inside prefers-colour-scheme
 * media queries.  When set the output is a bare :root rule for that scheme
 */
export function themeOverrides(
  theme: ThemeConfig | undefined,
  scheme: ColourScheme | null = null,
): string | null {
  if (!theme) return null;

  const blocks: string[] = [];

  const stack = typeof theme.font === 'string' ? FONT_STACKS[theme.font] : undefined;
  if (stack) {
    // Mono uses a variable font stack and resets code-font-size to avoid cascade
    const correction = theme.font === 'mono' ? ';--spr-font-size-code:1em' : '';
    blocks.push(`:root{--spr-font-body:${stack}${correction}}`);
  }

  if (theme.tui === true) {
    blocks.push(':root{--spr-font-body:var(--spr-font-mono);--spr-font-size-code:1em}');
  }

  if (theme.rounded_corners === false || theme.tui === true) {
    blocks.push(`:root{${RADIUS_TOKENS.map((token) => `${token}:0`).join(';')}}`);
  }

  for (const [name, media] of [
    ['light', '@media (prefers-color-scheme: light)'],
    ['dark', '@media (prefers-color-scheme: dark)'],
  ] as const) {
    if (scheme !== null && scheme !== name) continue;
    const block = declarations(theme.palette?.[name]);
    if (!block) continue;
    blocks.push(scheme === null ? `${media}{:root{${block}}}` : `:root{${block}}`);
  }

  return blocks.length > 0 ? blocks.join('') : null;
}

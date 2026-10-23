import type { BrandImageSpec } from '../../../../config/brand';
import {
  BRAND_ICON,
  BRAND_LOGO,
  BRAND_LOGO_DARK,
  BRAND_WALLPAPER,
  BRAND_WALLPAPER_DARK,
  describeBytes,
  parseBrandImage,
  parseBrandRef,
} from '../../../../config/brand';
import type { PaletteGroupId, PaletteKey } from '../../../../config/palette';
import { PALETTE_GROUPS } from '../../../../config/palette';
import { NEUTRAL_BRAND } from '../../../../config/types';
import { DEFAULT_TEMPLATE, templateNames } from '../../../../content-reader/assets.controller';
import { templatePalette } from '../../../../content-reader/template-palette';
import type { TemplatePhoto } from '../../../../content-reader/template-wallpapers';
import { TEMPLATE_WALLPAPERS } from '../../../../content-reader/template-wallpapers';

import type { CardItem, Field, Obj } from '../config-fields';
import {
  at,
  booleanField,
  colorField,
  fileField,
  selectField,
  templateField,
  textField,
} from '../config-fields';
import { STORED_IMAGE } from '../config-fields/file';
import type { Card, Option } from '../model';
import { fieldsOf } from '../model';
import type { SectionSource } from './registry';
import { sectionHead, subsectionEntry } from './registry';

function storedImage(raw: unknown, spec: BrandImageSpec): { stored: string; storedHash: string } {
  if (typeof raw !== 'string') return { stored: '', storedHash: '' };

  const hash = parseBrandRef(raw);
  if (hash !== null) return { stored: STORED_IMAGE, storedHash: hash };

  const { image, problem } = parseBrandImage(raw, spec);
  if (!image) return { stored: problem ?? '', storedHash: '' };
  const type = (spec.types[image.mediaType] ?? '').toUpperCase();
  return {
    stored: `${type}, ${describeBytes(image.bytes.length)}`,
    storedHash: image.hash,
  };
}

function imageField(root: Obj, spec: BrandImageSpec, label: string, help: string): Field {
  return fileField(['brand', spec.field], spec.key, label, {
    ...storedImage(at(root, ['brand', spec.field]), spec),
    accept: Object.keys(spec.types).join(','),
    help,
  });
}

function templateOptions(stored: unknown): Option[] {
  const names = templateNames();
  const options: Option[] = names.map((name) => ({
    value: name,
    label: titleCase(name),
    previewHref: `/-/config/preview/${encodeURIComponent(name)}`,
  }));
  if (names.length === 0) return [];
  // Include the stored template even when it is not in this build
  if (typeof stored === 'string' && stored !== '' && !names.includes(stored)) {
    options.push({ value: stored, label: `${stored} — not in this build` });
  }
  return options;
}

function titleCase(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const LOGOS_BLURB =
  'Set a custom logo for the page header, the icon for the browser tab and a wallpaper behind the pages.';

const APPEARANCE_BLURB =
  'Configure custom colours and typefaces. Find out more in our [documentation](https://docs.speicher.md/themes/tokens)';

export function brandingSection(root: Obj): SectionSource {
  return {
    ...sectionHead('branding'),
    blurb:
      'Personalize the look of your instance. Find out more in our [documentation](https://docs.speicher.md/themes)',
    entries: [
      subsectionEntry('branding/logos', LOGOS_BLURB),
      subsectionEntry('branding/appearance', APPEARANCE_BLURB),
    ],
    layout: 'tiles',
    entriesArePages: true,
    fields: [
      textField(root, ['brand', 'name'], 'brand.name', 'Header name', {
        placeholder: NEUTRAL_BRAND,
        help: 'The title at the top of every page, linking home. Fallback: host of SPEICHER_PUBLIC_URL',
        // Show-name checkbox attached below the header name field
        attached: [
          booleanField(
            root,
            ['brand', 'show_name'],
            'brand.show_name',
            'Show the name beside the logo',
            {
              fallback: true,
              help: 'Turn on to show logo _and_ header name',
            },
          ),
        ],
      }),
      selectField(root, ['brand', 'name_align'], 'brand.name_align', 'Name alignment', {
        fallback: 'center',
        options: [
          { value: 'center', label: 'Centered on the logo' },
          { value: 'bottom', label: 'On the bottom edge of the logo' },
        ],
        help: 'where the header name sits next to the logo',
      }),
      templateField(root, ['theme', 'template'], 'theme.template', 'Theme', {
        fallback: DEFAULT_TEMPLATE,
        options: templateOptions(at(root, ['theme', 'template'])),
        help: 'Select one of the standard themes or create your own. Find out more in our [documentation](https://docs.speicher.md/themes)',
      }),
      booleanField(root, ['attribution'], 'attribution', 'Show "Published with speicher.md"', {
        fallback: true,
      }),
      booleanField(root, ['theme', 'rounded_corners'], 'theme.rounded_corners', 'Rounded corners', {
        fallback: true,
        help: 'Rounds the corners of panes, cards, buttons and fields. Turn it off for square corners.',
      }),
    ],
    cards: [],
    addOps: [],
  };
}

export function logosSection(root: Obj): SectionSource {
  return {
    ...sectionHead('branding/logos'),
    blurb: LOGOS_BLURB,
    fields: [
      imageField(
        root,
        BRAND_LOGO,
        'Header logo',
        `PNG, WebP or SVG (max. ${describeBytes(BRAND_LOGO.maxBytes)}). Shown at the top of ` +
          'every page, and on dark pages too unless a seperate logo for dark mode is added',
      ),
      imageField(
        root,
        BRAND_LOGO_DARK,
        'Header logo for dark pages',
        `PNG, WebP or SVG (max. ${describeBytes(BRAND_LOGO_DARK.maxBytes)}). Shown to a reader with dark mode`,
      ),
      imageField(
        root,
        BRAND_ICON,
        'Favicon (Browser Tab)',
        `Square PNG or SVG (max. ${describeBytes(BRAND_ICON.maxBytes)})`,
      ),
      imageField(
        root,
        BRAND_WALLPAPER,
        'Wallpaper',
        `JPEG, PNG, WebP or SVG up to 4K (max. ${describeBytes(BRAND_WALLPAPER.maxBytes)}). Shown behind the pages through a frosted glass effect. This is most prominent in the Glass theme. ` +
          glassCredits(),
      ),
      imageField(
        root,
        BRAND_WALLPAPER_DARK,
        'Wallpaper for dark pages',
        `JPEG, PNG, WebP or SVG up to 4K (max. ${describeBytes(BRAND_WALLPAPER_DARK.maxBytes)}). Shown to a reader with dark mode`,
      ),
    ],
    cards: [],
    addOps: [],
  };
}

/** "For a mode without an upload, the Glass theme shows …", with a link to each photo */
function glassCredits(): string {
  const { light, dark } = TEMPLATE_WALLPAPERS.glass;
  const credit = (photo: TemplatePhoto) => `[${photo.photographer}](${photo.source})`;
  return (
    `Without an uploaded wallpaper, the Glass theme shows photos by ${credit(light)} (light) ` +
    `and ${credit(dark)} (dark) on Unsplash.`
  );
}

export const APPEARANCE_RESET_OP = 'reset:branding/appearance';

export function appearanceSection(root: Obj): SectionSource {
  const fields = [
    selectField(root, ['theme', 'font'], 'theme.font', 'Body typeface', {
      fallback: 'system',
      options: FONT_OPTIONS,
      help: 'Currently only those fonts are supported. Web Fonts are not used for security reasons.',
    }),
  ];
  const cards = [paletteCard(root, 'light'), paletteCard(root, 'dark')];

  return {
    ...sectionHead('branding/appearance'),
    blurb: APPEARANCE_BLURB,
    /*
      Offered only where there is something to take back out.

      Asked of the field model rather than of the two keys this page happens to
      write, because the reset clears what the model offers: two answers to "what
      does this page set" is how a colour added to the page comes to be cleared by
      a button that claims not to be there. An unanswered page draws nothing — a
      control that does nothing when pressed is worse than an absent one, and here
      the absence is itself the news that nothing has been overridden.
    */
    resetOp: answered(fields, cards) ? APPEARANCE_RESET_OP : null,
    fields,
    cards,
    addOps: [],
  };
}

/** Whether anything on the page has a stored value behind it. */
function answered(items: CardItem[], cards: Card[]): boolean {
  return (
    fieldsOf(items).some((each) => 'value' in each && each.value !== '') ||
    cards.some((card) => answered(card.items, card.cards))
  );
}

/*
 * The four stacks, and the first of them is spelled as *no answer*.
 *
 * `system` is the schema's own default, so an empty value and `system` describe the
 * same instance — and offering both would be two rows reading "System", one of which
 * quietly writes a key. Blank is the answer every other control on this page can
 * give, and the typeface could not: the one control that could not be unset was the
 * one that wrote the schema's default back into the document, which is what a Reset
 * has to be able to take out. A stored `system` still selects this row and is taken
 * out by the next save of this page, which is the same instance written the shorter
 * way.
 */
const FONT_OPTIONS: Option[] = [
  { value: '', label: 'System' },
  { value: 'sans', label: 'Sans-serif' },
  { value: 'serif', label: 'Serif' },
  { value: 'mono', label: 'Monospace' },
];

const PALETTE_HELP: Record<PaletteKey, { label: string; help: string }> = {
  bg: {
    label: 'Page background',
    help: 'Make sure to use a high contrast between background and text.',
  },
  fg: {
    label: 'Body text',
    help: 'Reading text',
  },
  accent: {
    label: 'Accent',
    help: 'Links, focus rings, the marks on a chart. Use your brand color.',
  },
  muted: {
    label: 'Quiet text',
    help: 'Captions, dates, breadcrumbs, punctuation in code. A grey tone works almost every time.',
  },
  line: {
    label: 'Rules and borders',
    help: 'Hairlines, table rules, the edge of a box.',
  },
  surface: {
    label: 'Panels',
    help:
      'What sits on the page rather than in it — code blocks, table heads, the ' +
      'tree. Mixed from the two above when empty.',
  },

  'warn-bg': {
    label: 'Warning strip',
    help:
      'Behind the band a reader sees over a page whose repository has stopped ' +
      'syncing. It is the one colour here that has to carry a whole line of text.',
  },
  'warn-fg': {
    label: 'Warning text',
    help: 'The words on that band, read against the colour above and against nothing else.',
  },
  'mark-bg': {
    label: 'Search highlight',
    help: 'Behind a search term picked out of a result snippet.',
  },
  'mark-fg': {
    label: 'Highlighted term',
    help: 'The term itself. Left empty against a background that moved, it is the pair that stops matching.',
  },

  'callout-info': { label: 'Info', help: 'The `info` callout.' },
  'callout-tip': { label: 'Tip', help: 'The `tip` callout.' },
  'callout-important': { label: 'Important', help: 'The `important` callout.' },
  'callout-warning': {
    label: 'Warning',
    help:
      'The `warning` callout — and, on the operational surface, anything reported ' +
      'as a warning. One colour, because they are one idea.',
  },
  'callout-danger': {
    label: 'Danger',
    help: 'The `danger` callout, and a failure on the operational surface.',
  },

  'code-keyword': { label: 'Keywords', help: '`if`, `return`, `class`.' },
  'code-type': { label: 'Types', help: 'Type and class names.' },
  'code-function': { label: 'Functions', help: 'Function and method names.' },
  'code-tag': { label: 'Tags', help: 'Markup tag names.' },
  'code-attr': { label: 'Attributes', help: 'Markup attributes, and keys in JSON or YAML.' },
  'code-string': { label: 'Strings', help: 'String literals.' },
  'code-number': { label: 'Numbers', help: 'Numeric and boolean literals.' },
  'code-variable': { label: 'Variables', help: 'Variables, and interpolations inside a string.' },
  'code-comment': { label: 'Comments', help: 'Comments.' },
  'code-meta': { label: 'Directives', help: 'Preprocessor lines, shebangs, annotations.' },
  'code-inserted': { label: 'Added line', help: 'An added line in a diff.' },
  'code-inserted-bg': { label: 'Behind an added line', help: 'The tint that line sits on.' },
  'code-deleted': { label: 'Removed line', help: 'A removed line in a diff.' },
  'code-deleted-bg': { label: 'Behind a removed line', help: 'The tint that line sits on.' },
};

const PALETTE_GROUP_HEADS: Record<PaletteGroupId, { title: string; subtitle: string } | null> = {
  core: null,
  highlight: {
    title: 'Highlights',
    subtitle:
      'The two places a colour sits behind words rather than beside them. Each is a pair, and a pair is only ever as readable as both halves.',
  },
  callout: {
    title: 'Callouts',
    subtitle:
      'One colour per level. The box tints its own background out of the level colour and the page, so these move the whole callout — and `note` is not here because it follows the quiet text, which is what makes it the quiet one.',
  },
  code: {
    title: 'Code',
    subtitle:
      'Fourteen colours every language maps onto, so recolouring code needs to know nothing about any particular one. Punctuation is not here: it follows the quiet text.',
  },
};

function paletteCard(root: Obj, scheme: 'light' | 'dark'): Card {
  const base = ['theme', 'palette', scheme];

  /*
    What the template puts there when this page answers nothing — shown, never
    submitted.

    A placeholder rather than a value, and the distinction is the whole feature's:
    absence is what keeps the template's own colour, so a box holding one would
    write it into the document on the next save and an instance that had chosen
    nothing would end up having chosen everything. It is also what makes Reset
    survive the save that follows it.

    Read from the sheet the *document* names, since that is the template this page
    is describing; a name this build does not have falls back exactly as the
    reader's stylesheet does.
  */
  const defaults = templatePalette(
    typeof at(root, ['theme', 'template']) === 'string'
      ? (at(root, ['theme', 'template']) as string)
      : DEFAULT_TEMPLATE,
    scheme,
  );

  const colour = (key: PaletteKey): Field =>
    colorField(root, [...base, key], `theme.palette.${scheme}.${key}`, PALETTE_HELP[key].label, {
      help: PALETTE_HELP[key].help,
      pattern: HEX_PATTERN,
      patternHint: HEX_HINT,
      placeholder: defaults[key] ?? '',
    });

  const groups = PALETTE_GROUPS.map((group) => ({ group, head: PALETTE_GROUP_HEADS[group.id] }));

  return {
    title: scheme === 'light' ? 'Light' : 'Dark',
    subtitle:
      scheme === 'light'
        ? 'What a reader sees unless their system asks for a dark page.'
        : "What a reader whose system asks for a dark page sees. Leave it empty and the template's own dark scheme stands, which is the safe answer.",
    removeOp: null,
    items: groups.flatMap(({ group, head }) =>
      head === null ? group.keys.map((key) => colour(key)) : [],
    ),
    cards: groups.flatMap(({ group, head }) =>
      head === null
        ? []
        : [
            {
              title: head.title,
              subtitle: head.subtitle,
              removeOp: null,
              items: group.keys.map((key) => colour(key)),
              cards: [],
              addOps: [],
              notes: [],
            },
          ],
    ),
    addOps: [],
    notes: [],
  };
}

const HEX_PATTERN = '#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})';
const HEX_HINT = 'A hex colour: # followed by three or six digits, like #1a73e8.';

# Branding

Branding changes how your instance looks to readers: the name and logo in the header, the browser tab icon, the template, the typeface and the colours. Repositories cannot change any of it, so every page of the instance looks the same.

You find all settings in the dashboard under **Configuration → Branding**. Changes apply right away and never trigger a new sync.

## Name and logo

The header shows the instance's name, linking to the home page. Set it under **Header name** (`brand.name`). Without a name, the header shows the host of `SPEICHER_PUBLIC_URL`.

Under **Branding → Logos** you can upload three images:

| Image                      | Formats          | Size limit | Used for                                                  |
| -------------------------- | ---------------- | ---------- | --------------------------------------------------------- |
| Header logo                | PNG, WebP or SVG | 64 KB      | The header, in light mode and in dark mode                |
| Header logo for dark pages | PNG, WebP or SVG | 64 KB      | The header for readers in dark mode, instead of the above |
| Favicon                    | PNG or SVG       | 32 KB      | The browser tab                                           |

- The favicon must be square. A PNG favicon must be at least 32×32 pixels.
- SVG files may not contain scripts, event handlers, embedded HTML, entities, or references to anything outside the file, such as external images or stylesheets. Speicher refuses such a file when you upload it.
- Speicher checks the file's actual content, so a file whose extension does not match its format is refused.

With a logo, the name is still shown beside it. If your logo already contains the name, turn off **Show name** (`brand.show_name`). **Name alignment** (`brand.name_align`) decides whether the name is centred on the logo's height or sits on its bottom edge.

<!-- screenshot: the header with a logo and the name aligned to the bottom edge -->

:::note
Uploaded images are stored in the database, and the configuration refers to them as `sha256:<hash>`. In a configuration file, you can instead give an image as a `data:` URI, for example `data:image/png;base64,iVBORw0…`.
:::

## Template

A template sets the overall look of every page. Choose it under **Theme** (`theme.template`). Speicher ships four:

- `default`
- `blueprint`
- `editorial`
- `workspace`

The dashboard shows a preview of each one before you save. Every template has a light and a dark variant. Readers see the one their system asks for, unless they choose light or dark themselves.

<!-- screenshot: the template picker with the preview open -->

## Typeface

**Body typeface** (`theme.font`) sets the font of the body text:

| Value    | Font                               |
| -------- | ---------------------------------- |
| `system` | The reader's system font (default) |
| `sans`   | A sans-serif font                  |
| `serif`  | A serif font                       |
| `mono`   | A monospace font                   |

Each value uses fonts already installed on the reader's device. Speicher loads no web fonts, so you cannot choose a font by name.

## Colours

Under **Branding → Appearance** you can override any colour of the template, separately for light and dark mode (`theme.palette.light` and `theme.palette.dark`). A colour you leave empty keeps the template's own.

Three colours make most of the difference:

- **Page background** (`bg`)
- **Body text** (`fg`)
- **Accent** (`accent`): links, focus rings and highlights. Use your brand colour here.

If you leave **Quiet text**, **Rules and borders** and **Panels** empty, Speicher mixes them from the background and text colours, so they stay in tune when you change those two. The other colours cover search highlights, the warning strip, the five callout types and syntax highlighting in code blocks.

Colours are hex values with three or six digits, such as `#0b5fff` or `#fff`.

:::caution
Set the dark palette too if you change the light one. Otherwise, readers in dark mode keep the template's dark colours, which may not match your accent. Also check that text stays readable against the background in both modes.
:::

The palette applies to the documentation only, not to the dashboard. If you choose colours that make pages hard to read, you can still fix them in the dashboard. **Reset** on the Appearance page removes all colour and typeface overrides.

## Attribution

At the bottom of every page, Speicher shows `Published with speicher.md`, linking to the Speicher website. Turn it off with **Show "Published with `speicher.md`"** (`attribution: false`). The text itself cannot be changed.

## Configuration file

```yaml
brand:
  name: Acme Engineering Docs
  show_name: false
  name_align: bottom

theme:
  template: editorial
  font: serif
  palette:
    light:
      accent: '#0b5fff'
    dark:
      accent: '#7aa7ff'

attribution: false
```

Every colour key is listed under `theme.palette` in the [instance configuration reference](../../06-reference/03-instance-configuration.md).

## Settings

### brand

<!-- generated: schema instance#/properties/brand -->
<!-- prettier-ignore-start -->
| Key | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `brand` | object |  |  | The name, logos and favicon in the page header and browser tab. Only the instance sets these; repositories cannot. |
| `brand.name` | string |  |  | The name shown at the top of every page, linking to the home page. It is also the logo's alt text. Without it, the header shows the host of `SPEICHER_PUBLIC_URL`. Example: `Acme Engineering Docs`. |
| `brand.show_name` | boolean | `true` |  | Whether the name is shown beside the logo. Turn it off if your logo already contains the name. Without a logo, the name is always shown. Example: `false`. |
| `brand.name_align` | `center`, `bottom` | `center` |  | How the name lines up with the logo: `center` centres it on the logo's height, `bottom` sets it on the logo's bottom edge. Example: `bottom`. |
| `brand.logo` | string |  |  | The header logo: a PNG, WebP or SVG of at most 64 KB, as a `data:` URI or a `sha256:` reference to an uploaded image. Used in dark mode too, unless `logo_dark` is set. |
| `brand.logo_dark` | string |  |  | The header logo for readers in dark mode: a PNG, WebP or SVG of at most 64 KB, as a `data:` URI or a `sha256:` reference to an uploaded image. |
| `brand.icon` | string |  |  | The favicon shown in the browser tab: a square PNG or SVG of at most 32 KB, as a `data:` URI or a `sha256:` reference to an uploaded image. A PNG must be at least 32×32 pixels. |
<!-- prettier-ignore-end -->
<!-- /generated -->

### theme

<!-- generated: schema instance#/properties/theme/properties/template theme.template -->
<!-- prettier-ignore-start -->
| Key | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `theme.template` | string | `default` |  | The template for all pages: `default`, `blueprint`, `editorial` or `workspace`. An unknown name falls back to `default`. |
<!-- prettier-ignore-end -->
<!-- /generated -->

<!-- generated: schema instance#/properties/theme/properties/font theme.font -->
<!-- prettier-ignore-start -->
| Key | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `theme.font` | `system`, `sans`, `serif`, `mono` | `system` |  | The typeface of the body text. Each value uses fonts already installed on the reader's device; web fonts are not loaded. |
<!-- prettier-ignore-end -->
<!-- /generated -->

### attribution

<!-- generated: schema instance#/properties/attribution -->
<!-- prettier-ignore-start -->
| Key | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `attribution` | boolean | `true` |  | Whether pages show `Published with speicher.md` at the bottom, linking to the Speicher website. The text cannot be changed. Example: `false`. |
<!-- prettier-ignore-end -->
<!-- /generated -->

import { ConfigError } from '../../src/common/errors';
import {
  BRAND_ICON,
  BRAND_LOGO,
  BRAND_WALLPAPER,
  BrandImageResult,
  describeBytes,
  MAX_BRAND_ICON_BYTES,
  MAX_BRAND_LOGO_BYTES,
  MAX_BRAND_WALLPAPER_BYTES,
  MIN_BRAND_ICON_PIXELS,
  parseBrandImage,
  sniffMediaType,
} from '../../src/config/brand';
import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfig } from '../../src/config/parser';

const MINIMAL = `
version: 1
auth:
  providers:
    entra:
      type: oidc
      issuer: https://login.example.test/v2.0
      client_id: abc
groups:
  engineering:
    - { provider: entra, id: "grp-eng" }
admins:
  groups: [engineering]
forges:
  gh:
    type: github
    app_id: "1"
    private_key: k
    webhook_secret: s
`;

function parseBrandLogo(value: string): BrandImageResult {
  return parseBrandImage(value, BRAND_LOGO);
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function dataUri(mediaType: string, bytes: Buffer | string): string {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  return `data:${mediaType};base64,${buf.toString('base64')}`;
}

function svg(inner: string, attrs = ''): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${inner}</svg>`;
}

function refusal(value: string): string {
  const { image, problem } = parseBrandLogo(value);
  expect(image).toBeNull();
  return problem ?? '';
}

function pngSized(width: number, height: number): Buffer {
  const resized = Buffer.from(PNG);
  resized.writeUInt32BE(width, 16);
  resized.writeUInt32BE(height, 20);
  return resized;
}

function sizedSvg(attrs: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect /></svg>`;
}

function iconRefusal(value: string): string {
  const { image, problem } = parseBrandImage(value, BRAND_ICON);
  expect(image).toBeNull();
  return problem ?? '';
}

function icon(value: string): string | null {
  return parseBrandImage(value, BRAND_ICON).problem;
}

describe('what a logo may be', () => {
  it('accepts a PNG, a WebP and an SVG', () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x1a, 0, 0, 0]),
      Buffer.from('WEBPVP8 '),
      Buffer.alloc(10),
    ]);
    expect(parseBrandLogo(dataUri('image/png', PNG)).image?.mediaType).toBe('image/png');
    expect(parseBrandLogo(dataUri('image/webp', webp)).image?.mediaType).toBe('image/webp');
    expect(
      parseBrandLogo(dataUri('image/svg+xml', svg('<circle cx="5" cy="5" r="4" />'))).image
        ?.mediaType,
    ).toBe('image/svg+xml');
  });

  it('names the file after its own bytes', () => {
    const one = parseBrandLogo(dataUri('image/png', PNG)).image;
    const again = parseBrandLogo(dataUri('image/png', PNG)).image;
    const other = parseBrandLogo(dataUri('image/svg+xml', svg('<rect />'))).image;
    expect(one?.file).toBe(again?.file);
    expect(one?.file).toMatch(/^[0-9a-f]{64}\.png$/);
    expect(other?.file).toMatch(/^[0-9a-f]{64}\.svg$/);
    expect(one?.file).not.toBe(other?.file);
  });

  it('refuses anything that is not one of the three types', () => {
    expect(refusal(dataUri('image/gif', 'GIF89a'))).toMatch(/must be one of/);
    expect(refusal('https://cdn.example.test/logo.svg')).toMatch(/data:/);
  });

  it('refuses a file whose bytes are not what it says they are', () => {
    expect(refusal(dataUri('image/png', svg('<script>alert(1)</script>')))).toMatch(
      /says image\/png but the bytes are image\/svg/,
    );
    expect(refusal(dataUri('image/webp', PNG))).toMatch(/says image\/webp but the bytes are/);
    expect(refusal(dataUri('image/png', 'not an image at all'))).toMatch(
      /not a JPEG, a PNG, a WebP or/,
    );
  });

  it('refuses a logo larger than the cap, and names the cap it broke', () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(MAX_BRAND_LOGO_BYTES)]);
    const problem = refusal(dataUri('image/png', huge));
    expect(problem).toContain('`brand.logo`');
    expect(problem).toContain(describeBytes(MAX_BRAND_LOGO_BYTES));
  });

  it('refuses base64 that does not decode to what it claims', () => {
    expect(refusal('data:image/png;base64,')).toMatch(/data:/);
    expect(refusal(dataUri('image/png', Buffer.alloc(0)))).toMatch(/data:/);
  });
});

describe('what an SVG may not contain', () => {
  it('refuses script and event handlers', () => {
    expect(refusal(dataUri('image/svg+xml', svg('<script>alert(1)</script>')))).toMatch(/<script>/);
    expect(refusal(dataUri('image/svg+xml', svg('<rect onload="alert(1)" />')))).toMatch(
      /event handler/,
    );
  });

  it('refuses anything that points outside the file', () => {
    expect(
      refusal(dataUri('image/svg+xml', svg('<image href="https://tracker.example/px.png" />'))),
    ).toMatch(/outside itself/);
    expect(
      refusal(dataUri('image/svg+xml', svg('<a xlink:href="https://evil.example">x</a>'))),
    ).toMatch(/outside itself/);
    expect(
      refusal(
        dataUri('image/svg+xml', svg('<style>@import url(https://evil.example/x.css)</style>')),
      ),
    ).toMatch(/imports a stylesheet/);
  });

  it('allows a gradient, which is what a real logo is made of', () => {
    const gradient = svg(
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#000" /></linearGradient></defs>' +
        '<path d="M0 0h10v10H0z" fill="url(#g)" />',
    );
    expect(parseBrandLogo(dataUri('image/svg+xml', gradient)).problem).toBeNull();
    const spaced = gradient.replace('url(#g)', "url( '#g' )");
    expect(parseBrandLogo(dataUri('image/svg+xml', spaced)).problem).toBeNull();

    const reuse = svg('<defs><path id="s" d="M0 0h4v4H0z" /></defs><use href="#s" />');
    expect(parseBrandLogo(dataUri('image/svg+xml', reuse)).problem).toBeNull();
  });

  it('still refuses a url() that leaves the file', () => {
    for (const target of [
      'https://tracker.example/p.png',
      '//tracker.example/p.png',
      'data:image/png;base64,AAAA',
      '/-/brand/other.png',
    ]) {
      const leaking = svg(`<rect fill="url(${target})" />`);
      expect(refusal(dataUri('image/svg+xml', leaking))).toMatch(/outside itself/);
    }
    expect(
      refusal(dataUri('image/svg+xml', svg('<style>@import "https://evil.example/x.css"</style>'))),
    ).toMatch(/imports a stylesheet/);
  });

  it('refuses an entity declaration, and the subset it arrives in', () => {
    const bomb = `<!DOCTYPE svg [<!ENTITY a "aaaa">]>${svg('<rect />')}`;
    expect(refusal(dataUri('image/svg+xml', bomb))).toMatch(/entity/);
    const subset = `<!DOCTYPE svg [ <!ELEMENT svg ANY> ]>${svg('<rect />')}`;
    expect(refusal(dataUri('image/svg+xml', subset))).toMatch(/internal subset/);
  });

  it('allows the doctype a real exporter writes', () => {
    const illustrator =
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" ' +
      '"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
      svg('<rect width="10" height="10" />');
    expect(parseBrandLogo(dataUri('image/svg+xml', illustrator)).problem).toBeNull();
    expect(
      parseBrandLogo(dataUri('image/svg+xml', `<!DOCTYPE svg>${svg('<rect />')}`)).problem,
    ).toBeNull();
  });

  it('recognises an SVG that opens with a declaration or a comment', () => {
    expect(sniffMediaType(Buffer.from(`<?xml version="1.0"?>\n${svg('<rect />')}`))).toBe(
      'image/svg+xml',
    );
    expect(sniffMediaType(Buffer.from(`<!-- Made with a tool -->\n${svg('<rect />')}`))).toBe(
      'image/svg+xml',
    );
    expect(
      sniffMediaType(Buffer.concat([Buffer.alloc(2000, 0x20), Buffer.from(svg(''))])),
    ).toBeNull();
  });
});

describe('what a favicon may be', () => {
  it('accepts a square PNG and a square SVG', () => {
    expect(icon(dataUri('image/png', pngSized(64, 64)))).toBeNull();
    expect(icon(dataUri('image/svg+xml', svg('<circle cx="5" cy="5" r="4" />')))).toBeNull();
  });

  it('refuses a WebP, which a logo may be and a tab icon may not', () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x1a, 0, 0, 0]),
      Buffer.from('WEBPVP8 '),
      Buffer.alloc(10),
    ]);
    expect(iconRefusal(dataUri('image/webp', webp))).toBe(
      '`brand.icon` is image/webp; it must be one of image/svg+xml, image/png',
    );
  });

  it('refuses a wordmark, because nothing here can crop one into a square', () => {
    const png = iconRefusal(dataUri('image/png', pngSized(400, 80)));
    expect(png).toContain('`brand.icon`');
    expect(png).toContain('400×80');
    expect(iconRefusal(dataUri('image/svg+xml', sizedSvg('viewBox="0 0 120 24"')))).toContain(
      '120×24',
    );
  });

  it('refuses one too small for the display most readers have', () => {
    expect(iconRefusal(dataUri('image/png', PNG))).toMatch(
      /is 1×1; a favicon needs to be at least/,
    );
    expect(iconRefusal(dataUri('image/png', pngSized(16, 16)))).toMatch(
      new RegExp(`at least ${MIN_BRAND_ICON_PIXELS}×${MIN_BRAND_ICON_PIXELS}`),
    );
    expect(
      icon(dataUri('image/png', pngSized(MIN_BRAND_ICON_PIXELS, MIN_BRAND_ICON_PIXELS))),
    ).toBeNull();
  });

  it('tolerates the rounding an exporter chose and the operator did not', () => {
    expect(icon(dataUri('image/png', pngSized(32, 33)))).toBeNull();
    expect(iconRefusal(dataUri('image/png', pngSized(32, 48)))).toContain('32×48');
  });

  it('measures an SVG by its viewBox, and by its width and height when it has none', () => {
    expect(icon(dataUri('image/svg+xml', sizedSvg('viewBox="0 0 48 48"')))).toBeNull();
    expect(icon(dataUri('image/svg+xml', sizedSvg('width="48px" height="48px"')))).toBeNull();
    expect(iconRefusal(dataUri('image/svg+xml', sizedSvg('width="200" height="40"')))).toMatch(
      /is 200×40/,
    );
  });

  it('lets an SVG that declares no size at all through, since it scales into the square', () => {
    expect(icon(dataUri('image/svg+xml', sizedSvg('')))).toBeNull();
  });

  it('is capped at 1 MB, and the message names its own cap', () => {
    const square = pngSized(64, 64);
    const huge = Buffer.concat([square, Buffer.alloc(MAX_BRAND_ICON_BYTES)]);
    expect(iconRefusal(dataUri('image/png', huge))).toMatch(/limit is 1 MB/);
  });

  it('refuses the same SVG a logo refuses, and names itself when it does', () => {
    expect(iconRefusal(dataUri('image/svg+xml', svg('<script>alert(1)</script>')))).toMatch(
      /^`brand.icon`: the SVG contains a <script>/,
    );
  });

  it('is the only one of the three that has a shape; a logo may be any', () => {
    expect(parseBrandLogo(dataUri('image/png', pngSized(400, 80))).problem).toBeNull();
  });
});

describe('the loader and the running config', () => {
  const withLogo = (uri: string) =>
    MINIMAL.replace('version: 1', `version: 1\nbrand:\n  name: Acme\n  logo: ${uri}`);

  it('refuses to load a configuration whose logo it would not serve', () => {
    expect(() =>
      loadInstanceConfig(withLogo(dataUri('image/svg+xml', svg('<script></script>')))),
    ).toThrow(ConfigError);
  });

  it('serves the bytes and the URL from a configuration that loaded', () => {
    const config = new ConfigService(loadInstanceConfig(withLogo(dataUri('image/png', PNG))));
    expect(config.brandLogo?.bytes.equals(PNG)).toBe(true);
    expect(config.brandLogoUrl).toBe(`/-/brand/${config.brandLogo?.file}`);
    expect(config.brand).toBe('Acme');
    expect(config.brandShowName).toBe(true);
  });

  it('decodes once per version rather than once per page', () => {
    const config = new ConfigService(loadInstanceConfig(withLogo(dataUri('image/png', PNG))));
    expect(config.brandLogo).toBe(config.brandLogo);
  });

  it('lets an instance whose logo spells its name turn the text off', () => {
    const yaml = MINIMAL.replace(
      'version: 1',
      `version: 1\nbrand:\n  name: Acme\n  show_name: false\n  logo: ${dataUri('image/png', PNG)}`,
    );
    expect(new ConfigService(loadInstanceConfig(yaml)).brandShowName).toBe(false);
  });

  it('centres the name on the logo unless told to set it on the bottom edge', () => {
    const config = new ConfigService(loadInstanceConfig(withLogo(dataUri('image/png', PNG))));
    expect(config.brandNameAlign).toBe('center');

    const yaml = MINIMAL.replace(
      'version: 1',
      `version: 1\nbrand:\n  name: Acme\n  name_align: bottom\n  logo: ${dataUri('image/png', PNG)}`,
    );
    expect(new ConfigService(loadInstanceConfig(yaml)).brandNameAlign).toBe('bottom');
  });

  it('has no logo, and no URL, when the instance set none', () => {
    const config = new ConfigService(loadInstanceConfig(MINIMAL));
    expect(config.brandLogo).toBeNull();
    expect(config.brandLogoUrl).toBeNull();
  });

  const withBrand = (lines: string[]) =>
    MINIMAL.replace('version: 1', ['version: 1', 'brand:', '  name: Acme', ...lines].join('\n'));

  it('keeps the two logos apart, and serves each under its own name', () => {
    const config = new ConfigService(
      loadInstanceConfig(
        withBrand([
          `  logo: ${dataUri('image/png', PNG)}`,
          `  logo_dark: ${dataUri('image/svg+xml', svg('<rect />'))}`,
        ]),
      ),
    );

    expect(config.brandLogoUrl).toMatch(/\.png$/);
    expect(config.brandLogoDarkUrl).toMatch(/\.svg$/);
    expect(config.brandLogoUrl).not.toBe(config.brandLogoDarkUrl);
    expect(config.brandImages.map((image) => image.file)).toEqual([
      config.brandLogo?.file,
      config.brandLogoDark?.file,
    ]);
  });

  it('has no dark logo to fall back on, which is the stylesheet’s job and not this one’s', () => {
    const config = new ConfigService(
      loadInstanceConfig(withBrand([`  logo: ${dataUri('image/png', PNG)}`])),
    );
    expect(config.brandLogoDark).toBeNull();
    expect(config.brandLogoDarkUrl).toBeNull();
    expect(config.brandImages).toHaveLength(1);
  });

  it('points the tab at the configured icon, under the name of its own bytes', () => {
    const config = new ConfigService(
      loadInstanceConfig(withBrand([`  icon: ${dataUri('image/png', pngSized(64, 64))}`])),
    );

    expect(config.faviconUrl).toBe(`/-/brand/${config.brandIcon?.file}`);
    expect(config.faviconType).toBe('image/png');
    expect(config.brandIcon).toBe(config.brandIcon);
  });

  it('points it at the un-hashed route when there is no icon, since the default can change', () => {
    const config = new ConfigService(loadInstanceConfig(MINIMAL));
    expect(config.brandIcon).toBeNull();
    expect(config.faviconUrl).toBe('/favicon.ico');
    expect(config.faviconType).toBe('image/svg+xml');
  });

  it('refuses to load a configuration whose icon is not square', () => {
    expect(() =>
      loadInstanceConfig(withBrand([`  icon: ${dataUri('image/png', pngSized(400, 80))}`])),
    ).toThrow(ConfigError);
  });
});

describe('the wallpaper', () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

  it('takes a JPEG, which a logo does not', () => {
    expect(sniffMediaType(JPEG)).toBe('image/jpeg');
    expect(parseBrandImage(dataUri('image/jpeg', JPEG), BRAND_WALLPAPER).problem).toBeNull();
    expect(parseBrandLogo(dataUri('image/jpeg', JPEG)).problem).toMatch(/must be one of/);
  });

  it('takes a file far past the logo cap, up to the size of a 4K photo', () => {
    const photo = Buffer.concat([JPEG, Buffer.alloc(4 * 1024 * 1024)]);
    expect(parseBrandImage(dataUri('image/jpeg', photo), BRAND_WALLPAPER).problem).toBeNull();

    const huge = Buffer.concat([JPEG, Buffer.alloc(MAX_BRAND_WALLPAPER_BYTES)]);
    expect(parseBrandImage(dataUri('image/jpeg', huge), BRAND_WALLPAPER).problem).toMatch(
      /limit is 5 MB/,
    );
  });

  it('loads from a configuration file that carries the whole photo inline', () => {
    const photo = Buffer.concat([JPEG, Buffer.alloc(4 * 1024 * 1024)]);
    const yaml = MINIMAL.replace(
      'version: 1',
      `version: 1\nbrand:\n  wallpaper: ${dataUri('image/jpeg', photo)}`,
    );
    const config = new ConfigService(loadInstanceConfig(yaml));
    expect(config.brandWallpaperUrl).toMatch(/^\/-\/brand\/[0-9a-f]{64}\.jpg$/);
    expect(config.brandWallpaperDarkUrl).toBeNull();
  });
});

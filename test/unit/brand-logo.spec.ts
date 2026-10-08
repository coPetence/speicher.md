import { ConfigError } from '../../src/common/errors';
import { MAX_BRAND_LOGO_BYTES, parseBrandLogo, sniffMediaType } from '../../src/config/brand';
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
  const { logo, problem } = parseBrandLogo(value);
  expect(logo).toBeNull();
  return problem ?? '';
}

describe('what a logo may be', () => {
  it('accepts a PNG, a WebP and an SVG', () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x1a, 0, 0, 0]),
      Buffer.from('WEBPVP8 '),
      Buffer.alloc(10),
    ]);
    expect(parseBrandLogo(dataUri('image/png', PNG)).logo?.mediaType).toBe('image/png');
    expect(parseBrandLogo(dataUri('image/webp', webp)).logo?.mediaType).toBe('image/webp');
    expect(
      parseBrandLogo(dataUri('image/svg+xml', svg('<circle cx="5" cy="5" r="4" />'))).logo
        ?.mediaType,
    ).toBe('image/svg+xml');
  });

  it('names the file after its own bytes', () => {
    const one = parseBrandLogo(dataUri('image/png', PNG)).logo;
    const again = parseBrandLogo(dataUri('image/png', PNG)).logo;
    const other = parseBrandLogo(dataUri('image/svg+xml', svg('<rect />'))).logo;
    expect(one?.file).toBe(again?.file);
    expect(one?.file).toMatch(/^[0-9a-f]{16}\.png$/);
    expect(other?.file).toMatch(/^[0-9a-f]{16}\.svg$/);
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
    expect(refusal(dataUri('image/png', 'not an image at all'))).toMatch(/not a PNG, a WebP or/);
  });

  it('refuses a logo larger than the cap, and says why the cap exists', () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(MAX_BRAND_LOGO_BYTES)]);
    expect(refusal(dataUri('image/png', huge))).toMatch(/limit is 64 KB.*carries a copy/);
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

  it('has no logo, and no URL, when the instance set none', () => {
    const config = new ConfigService(loadInstanceConfig(MINIMAL));
    expect(config.brandLogo).toBeNull();
    expect(config.brandLogoUrl).toBeNull();
  });
});

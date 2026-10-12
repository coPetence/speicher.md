import { readFileSync } from 'node:fs';

import { QueryTypes } from 'sequelize';

import {
  BRAND_ICON,
  BRAND_LOGO,
  brandImageOf,
  brandRef,
  parseBrandImage,
  parseBrandRef,
} from '../../src/config/brand';
import {
  attachStoredBrandImages,
  resolveBrandImages,
  resolveBrandImagesForTenantId,
} from '../../src/config/brand-resolve';
import { brandImageExists, internBrandImage, sweepBrandImages } from '../../src/config/brand-store';
import { ConfigService } from '../../src/config/config.service';
import {
  CONFIG_SOURCE_ENV,
  INSTANCE_CONFIG_PATH_ENV,
  appendConfigVersion,
  loadActiveInstanceConfig,
} from '../../src/config/loader';
import { loadInstanceConfig } from '../../src/config/parser';
import type { InstanceConfig } from '../../src/config/types';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { Harness, createHarness } from '../helpers/harness';

let harness: Harness;

const ORIGINAL_SOURCE = process.env[CONFIG_SOURCE_ENV];
const ORIGINAL_PATH = process.env[INSTANCE_CONFIG_PATH_ENV] as string;
const FIXTURE_YAML = readFileSync(ORIGINAL_PATH, 'utf8');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  if (ORIGINAL_SOURCE === undefined) delete process.env[CONFIG_SOURCE_ENV];
  else process.env[CONFIG_SOURCE_ENV] = ORIGINAL_SOURCE;
  process.env[INSTANCE_CONFIG_PATH_ENV] = ORIGINAL_PATH;
  await clear();
});

afterAll(async () => {
  await harness?.close();
  await closeSequelize();
});

async function clear(): Promise<void> {
  await getSequelize().query(`DELETE FROM brand_images`, { type: QueryTypes.DELETE });
  await getSequelize().query(`DELETE FROM instance_configs`, { type: QueryTypes.DELETE });
}

async function rowCount(): Promise<number> {
  const rows = await getSequelize().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM brand_images WHERE tenant_id = :tenantId`,
    { type: QueryTypes.SELECT, replacements: { tenantId: harness.tenantId } },
  );
  return Number(rows[0].count);
}

/** The image the three keys are set to in these tests, already acceptable */
function logo(): ReturnType<typeof brandImageOf> {
  const parsed = parseBrandImage(`data:image/png;base64,${PNG.toString('base64')}`, BRAND_LOGO);
  return parsed.image as ReturnType<typeof brandImageOf>;
}

/** A config naming whatever is given at `brand.logo` */
function configWithLogo(value: string): InstanceConfig {
  return loadInstanceConfig(`${FIXTURE_YAML}\nbrand:\n  logo: ${value}\n`).raw;
}

describe('the brand_images table', () => {
  it('keeps one row per image however often it is stored', async () => {
    const image = logo();
    await internBrandImage(harness.tenantId, image);
    await internBrandImage(harness.tenantId, image);

    expect(await rowCount()).toBe(1);
    expect(await brandImageExists(harness.tenantId, image.hash)).toBe(true);
  });

  it('gives back the bytes that were stored, and says they are a PNG', async () => {
    const image = logo();
    await internBrandImage(harness.tenantId, image);

    const resolved = await resolveBrandImagesForTenantId(harness.tenantId, configWithLogo(brandRef(image)));

    expect(resolved.problems).toEqual([]);
    expect(resolved.images.get('logo')?.bytes.equals(PNG)).toBe(true);
    expect(resolved.images.get('logo')?.mediaType).toBe('image/png');
    // The name it is served under is the hash, so the reference and the URL agree
    expect(resolved.images.get('logo')?.file).toBe(`${image.hash}.png`);
  });
});

describe('resolving what the document says', () => {
  it('leaves a reference for the pass that can read it, and refuses nothing', () => {
    const image = logo();
    const resolution = resolveBrandImages(configWithLogo(brandRef(image)));

    expect(resolution.problems).toEqual([]);
    expect(resolution.images.size).toBe(0);
    expect(resolution.pending.get('logo')).toBe(image.hash);
  });

  it('still reads a logo the document carries inline', () => {
    const resolution = resolveBrandImages(
      configWithLogo(`data:image/png;base64,${PNG.toString('base64')}`),
    );

    expect(resolution.pending.size).toBe(0);
    expect(resolution.images.get('logo')?.bytes.equals(PNG)).toBe(true);
  });

  it('reports a reference to an image nobody stored, without throwing', async () => {
    const missing = `sha256:${'a'.repeat(64)}`;
    const resolved = await resolveBrandImagesForTenantId(harness.tenantId, configWithLogo(missing));

    expect(resolved.images.size).toBe(0);
    expect(resolved.problems).toEqual([
      '`brand.logo` names an image this instance does not have stored (aaaaaaaaaaaa…)',
    ]);
  });

  /*
    The row is the one input here that this code did not write, so the rules are
    applied to it again on the way out — an instance whose table was reached by
    anything else must not end up serving a script as its own header.
  */
  it('refuses bytes that would not have been accepted on the way in', async () => {
    const hostile = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      'utf8',
    );
    const image = brandImageOf(hostile, 'image/svg+xml', 'svg');
    await internBrandImage(harness.tenantId, image);

    const resolved = await resolveBrandImagesForTenantId(harness.tenantId, configWithLogo(brandRef(image)));

    expect(resolved.images.size).toBe(0);
    expect(resolved.problems).toEqual([
      '`brand.logo`: the SVG contains a <script> element, which is not allowed',
    ]);
  });

  it('refuses a stored image whose type the key does not take', async () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x1a, 0, 0, 0]),
      Buffer.from('WEBPVP8 '),
      Buffer.alloc(10),
    ]);
    const image = brandImageOf(webp, 'image/webp', 'webp');
    await internBrandImage(harness.tenantId, image);

    // A favicon may be a PNG or an SVG, and this one is a WebP
    const resolution = resolveBrandImages(
      loadInstanceConfig(`${FIXTURE_YAML}\nbrand:\n  icon: ${brandRef(image)}\n`).raw,
    );
    const resolved = await attachStoredBrandImages(harness.tenantId, resolution);

    expect(resolved.images.size).toBe(0);
    expect(resolved.problems).toEqual([
      `\`${BRAND_ICON.key}\` names a image/webp image; it must be one of image/svg+xml, image/png`,
    ]);
  });
});

describe('the configuration a process boots on', () => {
  it('serves a stored logo through the getters a page reads', async () => {
    const image = logo();
    await internBrandImage(harness.tenantId, image);
    await appendConfigVersion(harness.tenantId, {
      yaml: `${FIXTURE_YAML}\nbrand:\n  logo: ${brandRef(image)}\n`,
      resolutionHash: 'x',
      origin: 'admin',
      appliedBy: null,
    });

    process.env[CONFIG_SOURCE_ENV] = 'database';
    const config = new ConfigService(await loadActiveInstanceConfig());

    expect(config.brandLogo?.bytes.equals(PNG)).toBe(true);
    expect(config.brandLogoUrl).toBe(`/-/brand/${image.hash}.png`);
    expect(config.brandImages).toHaveLength(1);
  });

  /*
    A picture is presentation. Falling the instance back to an older version over
    one — which is what a thrown `ConfigError` here would do — would answer a
    missing logo by reverting who may read which page.
  */
  it('boots on a version whose logo has gone missing, and says so', async () => {
    const missing = `sha256:${'b'.repeat(64)}`;
    await appendConfigVersion(harness.tenantId, {
      yaml: `${FIXTURE_YAML}\nbrand:\n  logo: ${missing}\n`,
      resolutionHash: 'x',
      origin: 'admin',
      appliedBy: null,
    });

    process.env[CONFIG_SOURCE_ENV] = 'database';
    const loaded = await loadActiveInstanceConfig();

    expect(loaded.version).toBe(1);
    expect(loaded.skipped).toEqual([]);
    expect(loaded.brandProblems).toHaveLength(1);
    expect(new ConfigService(loaded).brandLogoUrl).toBeNull();
  });
});

describe('collecting the images nothing names', () => {
  /** The row, aged past the grace period so the sweep will consider it */
  async function age(hash: string): Promise<void> {
    await getSequelize().query(
      `UPDATE brand_images SET created_at = now() - interval '2 days' WHERE hash = :hash`,
      { type: QueryTypes.UPDATE, replacements: { hash } },
    );
  }

  it('leaves alone an image a stored version still names, however old', async () => {
    const image = logo();
    await internBrandImage(harness.tenantId, image);
    await age(image.hash);
    await appendConfigVersion(harness.tenantId, {
      yaml: `${FIXTURE_YAML}\nbrand:\n  logo: ${brandRef(image)}\n`,
      resolutionHash: 'x',
      origin: 'admin',
      appliedBy: null,
    });

    expect(await sweepBrandImages(harness.tenantId, [])).toBe(0);
    expect(await brandImageExists(harness.tenantId, image.hash)).toBe(true);
  });

  /*
    A version is never pruned and a restore replays one as it was written, so an
    image named by any version at all has to survive — including one whose
    version was long ago superseded.
  */
  it('leaves alone an image only a superseded version names', async () => {
    const image = logo();
    await internBrandImage(harness.tenantId, image);
    await age(image.hash);
    for (const yaml of [`${FIXTURE_YAML}\nbrand:\n  logo: ${brandRef(image)}\n`, FIXTURE_YAML]) {
      await appendConfigVersion(harness.tenantId, {
        yaml,
        resolutionHash: 'x',
        origin: 'admin',
        appliedBy: null,
      });
    }

    expect(await sweepBrandImages(harness.tenantId, [])).toBe(0);
    expect(await brandImageExists(harness.tenantId, image.hash)).toBe(true);
  });

  it('collects what a save left behind once the grace period is over', async () => {
    const image = logo();
    await internBrandImage(harness.tenantId, image);

    // Inside the window, because a page may still be about to save it
    expect(await sweepBrandImages(harness.tenantId, [])).toBe(0);
    expect(await brandImageExists(harness.tenantId, image.hash)).toBe(true);

    await age(image.hash);
    expect(await sweepBrandImages(harness.tenantId, [])).toBe(1);
    expect(await brandImageExists(harness.tenantId, image.hash)).toBe(false);
  });

  /*
    `file` mode's document is a file, so the table of versions can be empty while
    a picture is on every page. What the running configuration names is handed in
    rather than discovered, and it is the answer here.
  */
  it('leaves alone what the running configuration names', async () => {
    const image = logo();
    await internBrandImage(harness.tenantId, image);
    await age(image.hash);

    expect(await sweepBrandImages(harness.tenantId, [image.hash])).toBe(0);
    expect(await brandImageExists(harness.tenantId, image.hash)).toBe(true);
  });
});

describe('what a reference may say', () => {
  it('is the prefix and the whole hash, in lower case', () => {
    const image = logo();
    expect(parseBrandRef(brandRef(image))).toBe(image.hash);
    expect(parseBrandRef(` ${brandRef(image)} `)).toBe(image.hash);

    expect(parseBrandRef(`sha256:${image.hash.toUpperCase()}`)).toBeNull();
    expect(parseBrandRef(`sha256:${image.hash.slice(0, 16)}`)).toBeNull();
    expect(parseBrandRef(`sha256:${image.hash}.png`)).toBeNull();
    expect(parseBrandRef('sha256:')).toBeNull();
  });

  it('is refused by the loader when it is neither a reference nor a data URI', () => {
    expect(() => configWithLogo('https://cdn.example.test/logo.svg')).toThrow(
      /brand\.logo: must match pattern/,
    );
  });
});

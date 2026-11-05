import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parse } from 'yaml';

const INSTALLER = resolve(__dirname, '../../deploy/install.sh');
const IMAGE = 'ghcr.io/copetence/speicher.md:${SPEICHER_IMAGE_TAG}';

interface Service {
  image?: string;
  ports?: string[];
  environment?: Record<string, string>;
}

interface Compose {
  services: Record<string, Service>;
  volumes: Record<string, unknown>;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'speicher-install-spec-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Runs the installer without starting anything, as `bash install.sh --yes --no-start` */
function install(args: string[], script = INSTALLER) {
  const result = spawnSync('bash', [script, '--yes', '--no-start', ...args], {
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function installInto(dir: string, args: string[]): void {
  const result = install(['--dir', dir, ...args]);
  if (result.status !== 0) throw new Error(`install.sh failed:\n${result.stderr}`);
}

function readCompose(dir: string): Compose {
  return parse(readFileSync(join(dir, 'docker-compose.yaml'), 'utf8'), { merge: true }) as Compose;
}

function readEnv(dir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(join(dir, '.env'), 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }
  return env;
}

describe('install.sh local setup', () => {
  it('publishes port 32168 on all interfaces and runs every service on the image', () => {
    const dir = join(root, 'speicher');
    installInto(dir, ['--mode', 'local']);

    const compose = readCompose(dir);
    expect(Object.keys(compose.services).sort()).toEqual(['db', 'migrate', 'web', 'worker']);
    expect(compose.services.web.ports).toEqual(['32168:3000']);
    for (const name of ['migrate', 'web', 'worker']) {
      expect(compose.services[name].image).toBe(IMAGE);
      expect(compose.services[name].environment).not.toHaveProperty('SPEICHER_TRUST_PROXY');
    }
    expect(Object.keys(compose.volumes).sort()).toEqual(['speicher-data', 'speicher-db']);
    expect(existsSync(join(dir, 'Caddyfile'))).toBe(false);
  });

  it('writes the URL, the image tag and a new database password to .env, readable by the owner only', () => {
    const dir = join(root, 'speicher');
    installInto(dir, ['--mode', 'local', '--port', '8080', '--image-tag', '1.2.3']);

    expect(readCompose(dir).services.web.ports).toEqual(['8080:3000']);
    const env = readEnv(dir);
    expect(env.SPEICHER_PUBLIC_URL).toBe('http://localhost:8080');
    expect(env.SPEICHER_IMAGE_TAG).toBe('1.2.3');
    expect(env.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
  });

  it('gives every install its own database password', () => {
    installInto(join(root, 'a'), ['--mode', 'local']);
    installInto(join(root, 'b'), ['--mode', 'local']);
    expect(readEnv(join(root, 'a')).POSTGRES_PASSWORD).not.toBe(
      readEnv(join(root, 'b')).POSTGRES_PASSWORD,
    );
  });
});

describe('install.sh public setups', () => {
  it('puts Caddy in front on 80 and 443 and keeps the web port closed', () => {
    const dir = join(root, 'speicher');
    installInto(dir, ['--mode', 'public', '--domain', 'docs.example.com', '--caddy']);

    const compose = readCompose(dir);
    expect(compose.services.caddy.ports).toEqual(['80:80', '443:443', '443:443/udp']);
    expect(compose.services.web.ports).toBeUndefined();
    expect(compose.services.web.environment?.SPEICHER_TRUST_PROXY).toBe('uniquelocal');
    expect(compose.volumes).toHaveProperty('caddy-data');
    expect(readEnv(dir).SPEICHER_PUBLIC_URL).toBe('https://docs.example.com');
    expect(readFileSync(join(dir, 'Caddyfile'), 'utf8')).toBe(
      'docs.example.com {\n\treverse_proxy web:3000\n}\n',
    );
  });

  it('sets up Caddy by default and adds the ACME email to the Caddyfile', () => {
    const dir = join(root, 'speicher');
    installInto(dir, [
      '--mode',
      'public',
      '--domain',
      'docs.example.com',
      '--acme-email',
      'ops@example.com',
    ]);

    expect(readCompose(dir).services).toHaveProperty('caddy');
    expect(readFileSync(join(dir, 'Caddyfile'), 'utf8')).toBe(
      '{\n\temail ops@example.com\n}\n\ndocs.example.com {\n\treverse_proxy web:3000\n}\n',
    );
  });

  it('publishes the web port on 127.0.0.1 only for your own reverse proxy', () => {
    const dir = join(root, 'speicher');
    installInto(dir, [
      '--mode',
      'public',
      '--domain',
      'docs.example.com',
      '--no-caddy',
      '--port',
      '8080',
    ]);

    const compose = readCompose(dir);
    expect(compose.services).not.toHaveProperty('caddy');
    expect(compose.services.web.ports).toEqual(['127.0.0.1:8080:3000']);
    expect(compose.services.web.environment?.SPEICHER_TRUST_PROXY).toBe('uniquelocal');
    expect(existsSync(join(dir, 'Caddyfile'))).toBe(false);
  });
});

describe('install.sh in a directory with an earlier install', () => {
  it('refuses to replace the files without --overwrite', () => {
    const dir = join(root, 'speicher');
    installInto(dir, ['--mode', 'local']);
    const before = readFileSync(join(dir, 'docker-compose.yaml'), 'utf8');

    const result = install(['--dir', dir, '--mode', 'public', '--domain', 'docs.example.com']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('run with --overwrite to replace it');
    expect(readFileSync(join(dir, 'docker-compose.yaml'), 'utf8')).toBe(before);
  });

  it('keeps the database password and lines added by hand, and backs up the old files', () => {
    const dir = join(root, 'speicher');
    installInto(dir, ['--mode', 'local']);
    const password = readEnv(dir).POSTGRES_PASSWORD;
    appendFileSync(join(dir, '.env'), 'SPEICHER_GITHUB_TOKEN=secret\n');

    installInto(dir, ['--overwrite', '--mode', 'public', '--domain', 'docs.example.com']);

    const env = readEnv(dir);
    expect(env.POSTGRES_PASSWORD).toBe(password);
    expect(env.SPEICHER_GITHUB_TOKEN).toBe('secret');
    expect(env.SPEICHER_PUBLIC_URL).toBe('https://docs.example.com');
    expect(readCompose(dir).services).toHaveProperty('caddy');

    const files = readdirSync(dir);
    expect(files.filter((f) => f.startsWith('.env.bak-'))).toHaveLength(1);
    expect(files.filter((f) => f.startsWith('docker-compose.yaml.bak-'))).toHaveLength(1);
  });
});

describe('install.sh flags it refuses before writing anything', () => {
  it.each([
    [['--mode', 'remote'], '--mode is local or public, not remote'],
    [['--port', '0'], '--port must be a number from 1 to 65535'],
    [['--port', '65536'], '--port must be a number from 1 to 65535'],
    [['--port', 'http'], '--port must be a number from 1 to 65535'],
    [['--domain', 'https://docs.example.com'], '--domain must be a domain'],
    [['--domain', 'docs.example.com/path'], '--domain must be a domain'],
    [['--domain', 'localhost'], '--domain must be a domain'],
    [['--mode', 'public'], '--mode public needs --domain'],
    [['--image-tag'], '--image-tag needs a value'],
    [['--frobnicate'], 'unknown flag: --frobnicate'],
  ])('%j', (args, message) => {
    const dir = join(root, 'speicher');
    const result = install(['--dir', dir, ...args]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(existsSync(dir)).toBe(false);
  });

  it('prints the usage for --help', () => {
    const result = install(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Sets up Speicher locally or on a public domain.');
  });
});

describe('install.sh as the release workflow ships it', () => {
  // The same substitution as the "Stamp install script" step in .github/workflows/release.yml
  function stamp(version: string): string {
    const source = readFileSync(INSTALLER, 'utf8');
    const stamped = source.replace(
      /^SPEICHER_VERSION="__VERSION__"$/m,
      `SPEICHER_VERSION="${version}"`,
    );
    const file = join(root, 'install.sh');
    writeFileSync(file, stamped);
    return file;
  }

  it('has the version placeholder the release workflow replaces', () => {
    expect(readFileSync(INSTALLER, 'utf8')).toMatch(/^SPEICHER_VERSION="__VERSION__"$/m);
  });

  it('defaults to the latest image when it is not stamped', () => {
    expect(install(['--help']).stdout).toContain('(default: latest)');
  });

  it('defaults to the stamped version', () => {
    const script = stamp('1.2.3');
    expect(install(['--help'], script).stdout).toContain('(default: 1.2.3)');

    const dir = join(root, 'speicher');
    const result = install(['--dir', dir, '--mode', 'local'], script);
    expect(result.status).toBe(0);
    expect(readEnv(dir).SPEICHER_IMAGE_TAG).toBe('1.2.3');
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigError } from '../../src/common/errors';
import { loadInstanceConfig } from '../../src/config/parser';
import { loadDocument } from '../../src/dashboard/configurator/config-form/document';
import {
  convertPathToVariableName,
  EXPORT_HEADER,
  exportConfig,
} from '../../src/dashboard/configurator/config-form/export';
import { buildSections } from '../../src/dashboard/configurator/config-form/fields';
import { allFields } from '../../src/dashboard/configurator/config-form/model';

const FULL = readFileSync(join(__dirname, '../fixtures/instance-full.yaml'), 'utf8');

const LITERAL = FULL.replace(
  'client_secret: ${TEST_ENTRA_CLIENT_SECRET}\n      subject_claim',
  'client_secret: a-real-secret-value\n      subject_claim',
);

function bodyOf(yaml: string): string {
  return yaml.slice(yaml.indexOf('\n') + 1);
}

describe('exporting the configuration', () => {
  it('references a literal by name instead of dropping it', () => {
    expect(LITERAL).not.toBe(FULL);
    const exported = exportConfig(LITERAL);

    expect(exported.yaml).not.toContain('a-real-secret-value');
    expect(bodyOf(exported.yaml)).toContain('client_secret: ${AUTH_PROVIDERS_ENTRA_CLIENT_SECRET}');
    expect(exported.variables).toEqual(['AUTH_PROVIDERS_ENTRA_CLIENT_SECRET']);
  });

  it('produces a document that still loads', () => {
    const exported = exportConfig(LITERAL);
    const before = process.env.AUTH_PROVIDERS_ENTRA_CLIENT_SECRET;
    process.env.AUTH_PROVIDERS_ENTRA_CLIENT_SECRET = 'supplied-on-the-new-instance';
    try {
      const loaded = loadInstanceConfig(exported.yaml);
      const provider = loaded.raw.auth?.providers?.entra as { client_secret?: string } | undefined;
      expect(provider?.client_secret).toBe('supplied-on-the-new-instance');
    } finally {
      if (before === undefined) delete process.env.AUTH_PROVIDERS_ENTRA_CLIENT_SECRET;
      else process.env.AUTH_PROVIDERS_ENTRA_CLIENT_SECRET = before;
    }
  });

  it('carries the logo, which the view drops for length rather than secrecy', () => {
    expect(exportConfig(FULL).yaml).toContain('data:image/png;base64');
  });

  it('leaves a document that already references everything untouched', () => {
    const exported = exportConfig(FULL);
    expect(exported.variables).toEqual([]);
    expect(bodyOf(exported.yaml)).toBe(FULL);
    expect(exported.yaml).toContain('${TEST_GH_PRIVATE_KEY}');
  });

  it('writes the literals in when it is asked to', () => {
    const exported = exportConfig(LITERAL, { withSecrets: true });
    expect(exported.yaml).toContain('client_secret: a-real-secret-value');
    expect(exported.variables).toEqual([]);
  });

  it('names where it came from in its first line', () => {
    const { yaml } = exportConfig(LITERAL, { host: 'docs.example.test', version: 7 });
    expect(yaml.split('\n')[0]).toBe(`${EXPORT_HEADER} — docs.example.test, version 7`);
  });

  it('replaces its own header rather than stacking one on the last', () => {
    const once = exportConfig(LITERAL, { host: 'first.test', version: 1 }).yaml;
    const twice = exportConfig(once, { host: 'second.test', version: 2 }).yaml;

    expect(twice.split(EXPORT_HEADER)).toHaveLength(2);
    expect(twice).not.toContain('first.test');
    expect(twice).toContain('second.test');
  });

  // Without a parsed tree no secret field can be found, so a copy that promises no
  // secrets cannot be made; with them asked for, the document goes out as it is
  it('refuses an unparseable document unless its secrets were asked for', () => {
    const broken = 'version: 1\nclient_secret: a-real-secret-value\n  oops: [';
    expect(() => exportConfig(broken)).toThrow(ConfigError);
    expect(exportConfig(broken, { withSecrets: true })).toEqual({ yaml: broken, variables: [] });
  });

  // The parser quotes the offending line, and here that line holds the secret
  it('does not repeat the secret in the reason it refuses', () => {
    const broken = 'version: 1\nclient_secret: a-real-secret-value\n  oops: [';
    expect(() => exportConfig(broken)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('a-real-secret-value') }),
    );
  });
});

describe('the variable an export references', () => {
  it('is the whole path, so two providers cannot collide', () => {
    expect(convertPathToVariableName('auth.providers.entra.client_secret')).toBe(
      'AUTH_PROVIDERS_ENTRA_CLIENT_SECRET',
    );
    expect(convertPathToVariableName('auth.providers.google.client_secret')).toBe(
      'AUTH_PROVIDERS_GOOGLE_CLIENT_SECRET',
    );
    expect(convertPathToVariableName('auth.providers.entra.client_secret')).not.toBe(
      convertPathToVariableName('auth.providers.entra.directory.client_secret'),
    );
  });

  it('never claims a name `assertKnownEnv` would refuse', () => {
    const secrets = allFields(buildSections(loadDocument(FULL)))
      .filter((field) => field.kind === 'secret')
      .map((field) => convertPathToVariableName(field.path));

    expect(secrets.length).toBeGreaterThan(3);
    expect(secrets.filter((name) => name.startsWith('SPEICHER_'))).toEqual([]);
    expect(secrets.filter((name) => !/^[A-Z][A-Z0-9_]*$/.test(name))).toEqual([]);
  });
});

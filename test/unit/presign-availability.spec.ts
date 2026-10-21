/**
 * What the storage page says when pre-signing is asked for and cannot happen
 *
 * The store is a stand-in rather than a real driver: the question is only what a
 * `null` from `presign` does to the page, and the two stores that answer `null`
 * in earnest are a volume -- which is not offered the setting at all -- and azure
 * under an identity, whose credential chain spends minutes looking for an IMDS
 * endpoint that is not there
 */

import { Readable } from 'node:stream';

import { BlobStore, PresignRequest, StoreStatus } from '../../src/assets/blob-store';
import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfig } from '../../src/config/parser';
import { buildSections } from '../../src/dashboard/configurator/config-form/fields';
import { allFields } from '../../src/dashboard/configurator/config-form/model';
import { loadDocument } from '../../src/dashboard/configurator/config-form/document';
import { SectionChecks } from '../../src/dashboard/configurator/config-page/checks';
import type { ConfigSectionPayload } from '../../src/dashboard/configurator/config-page/payloads';

const yamlFor = (over: number): string => `
version: 1
auth:
  providers:
    entra:
      type: oidc
      issuer: https://login.microsoftonline.com/a-tenant/v2.0
      client_id: sign-in-client
      client_secret: sign-in-secret
      subject_claim: oid
groups:
  platform-ops:
    - { provider: entra, id: grp-ops }
admins:
  groups: [platform-ops]
assets:
  driver: azure
  account: acmedocs
  container: assets
  auth: workload_identity
  presign_over_bytes: ${over}
`;

/** A store that answers every probe, and signs only when told it can */
function storeThat(signs: boolean): BlobStore {
  return {
    kind: 'azure',
    probe: async (): Promise<StoreStatus> => ({
      level: 'ok',
      label: 'Container accessible',
      detail: 'a container',
    }),
    exists: async () => true,
    put: async () => undefined,
    get: async () => Buffer.alloc(0),
    stream: async () => Readable.from([]),
    presign: async (_repo: string, _hash: string, _request: PresignRequest) =>
      signs ? 'https://example.test/signed' : null,
    purgeRepo: async () => undefined,
  };
}

async function storagePage(over: number, signs: boolean): Promise<ConfigSectionPayload> {
  const yaml = yamlFor(over);
  const config = new ConfigService(loadInstanceConfig(yaml));
  const section = buildSections(loadDocument(yaml)).find(
    (each: { id: string }) => each.id === 'storage',
  )!;
  const payload = { section } as ConfigSectionPayload;

  // The same config in both places, so the page is checking the store in force
  await new SectionChecks(config, null, storeThat(signs)).stampSectionCheck(payload, yaml, true);
  return payload;
}

const presignField = (payload: ConfigSectionPayload) =>
  allFields([payload.section!]).find((each) => each.path === 'assets.presign_over_bytes');

describe('the pre-signing setting on the storage page', () => {
  it('is marked unavailable when the store will not sign a URL', async () => {
    const field = presignField(await storagePage(1_000_000, false));

    expect(field?.status?.level).toBe('warn');
    expect(field?.status?.label).toBe('Pre-signing is not available');
    expect(field?.status?.detail).toContain('served through this instance');
  });

  it('is left alone when the store does sign', async () => {
    expect(presignField(await storagePage(1_000_000, false))?.status).toBeDefined();
    expect(presignField(await storagePage(1_000_000, true))?.status).toBeUndefined();
  });

  it('says nothing at all while pre-signing is switched off', async () => {
    // Zero proxies everything by choice, so there is nothing to warn about
    expect(presignField(await storagePage(0, false))?.status).toBeUndefined();
  });

  it('still reports the store itself, so the warning never replaces the probe', async () => {
    const payload = await storagePage(1_000_000, false);

    expect(payload.section?.status?.level).toBe('ok');
    expect(payload.section?.status?.label).toBe('Container accessible');
  });
});

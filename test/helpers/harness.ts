import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { QueryTypes } from 'sequelize';

import { BlobStore, FilesystemBlobStore } from '../../src/assets/blob-store';
import { AuthzService } from '../../src/authz/authz.service';
import { Caller, ResolvedCaller } from '../../src/authz/caller';
import { ContentReports } from '../../src/authz/content/reports';
import { SearchRepository } from '../../src/authz/content/search.repository';
import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfigFromFile } from '../../src/config/parser';
import { migrateUp } from '../../src/db/migrate';
import { Forge, Repo, initModels } from '../../src/db/models';
import { getSequelize } from '../../src/db/sequelize';
import { VECTOR_INDEX_NAME } from '../../src/embed/distance';
import { IngestService } from '../../src/ingest/ingest.service';
import { assertTestDatabase } from './test-database';

export const FIXTURE_ROOT = resolve(__dirname, '../fixtures');
export const FIXTURE_SHA = '0'.repeat(40);

export const PRINCIPALS = {
  alice: { oid: 'alice-oid', email: 'alice@copetence.test', groups: ['grp-eng'] },
  bob: { oid: 'bob-oid', email: 'bob@copetence.test', groups: ['grp-com'] },
  carol: { oid: 'carol-oid', email: 'carol@northwind.test', groups: ['grp-northwind'] },
  dave: { oid: 'dave-oid', email: 'dave@partner.test', groups: [] as string[] },
  ops: { oid: 'ops-oid', email: 'ops@copetence.test', groups: ['grp-ops'] },
  mallory: { oid: 'mallory-oid', email: 'mallory@elsewhere.test', groups: [] as string[] },
} as const;

export type PrincipalName = keyof typeof PRINCIPALS;

export interface Harness {
  config: ConfigService;
  authz: AuthzService;
  search: SearchRepository;
  reports: ContentReports;
  ingest: IngestService;
  blobs: BlobStore;
  tenantId: string;
  repos: { handbook: string; specs: string; fieldkit: string; speicherDocs: string };
  caller(name: PrincipalName | 'anonymous'): ResolvedCaller;
  close(): Promise<void>;
}

let blobRoot: string | null = null;

export async function createHarness(): Promise<Harness> {
  const sequelize = getSequelize();
  initModels(sequelize);
  await migrateUp(sequelize);
  await truncateAll();
  await resetVectorIndex();

  const config = new ConfigService(
    loadInstanceConfigFromFile(process.env.SPEICHER_CONFIG as string),
  );
  const authz = new AuthzService(config);
  const search = new SearchRepository(sequelize);
  const reports = new ContentReports(sequelize);

  blobRoot = mkdtempSync(join(tmpdir(), 'speicher-blobs-'));
  process.env.SPEICHER_ASSET_PATH = blobRoot;
  const blobs = new FilesystemBlobStore(blobRoot);
  const ingest = new IngestService(config, blobs, sequelize);

  const tenantId = await defaultTenantId();
  // A configured instance, past its setup
  await sequelize.query(`UPDATE tenants SET setup_completed_at = now() WHERE id = :tenantId`, {
    type: QueryTypes.UPDATE,
    replacements: { tenantId },
  });
  const forge = await Forge.create({
    tenant_id: tenantId,
    key: 'gh',
    type: 'github',
    is_primary: true,
    default_repository_owner: 'copetence',
    config: {},
  });

  const handbook = await Repo.create({
    tenant_id: tenantId,
    forge_id: forge.id,
    forge_repo_id: '41775317',
    namespace: 'copetence',
    namespace_id: '9001',
    slug: 'handbook',
    branch: 'main',
  });
  const specs = await Repo.create({
    tenant_id: tenantId,
    forge_id: forge.id,
    forge_repo_id: '41775318',
    namespace: 'northwind-engineering',
    namespace_id: '9002',
    slug: 'specs',
    branch: 'main',
  });
  const fieldkit = await Repo.create({
    tenant_id: tenantId,
    forge_id: forge.id,
    forge_repo_id: '41775319',
    namespace: 'copetence',
    namespace_id: '9001',
    slug: 'fieldkit',
    branch: 'main',
  });

  const speicherDocs = await Repo.create({
    tenant_id: tenantId,
    forge_id: forge.id,
    forge_repo_id: '41775330',
    namespace: 'copetence',
    namespace_id: '9001',
    slug: 'speicher-docs',
    branch: 'main',
  });

  for (const [id, dir] of [
    [handbook.id, 'handbook'],
    [specs.id, 'specs'],
    [fieldkit.id, 'fieldkit'],
    [speicherDocs.id, 'speicher-docs'],
  ] as const) {
    const result = await ingest.syncRepo(id, {
      workingTree: join(FIXTURE_ROOT, 'repos', dir),
      sha: FIXTURE_SHA,
      trigger: 'manual',
      now: new Date('2026-08-21T12:00:00Z'),
    });
    if (result.status !== 'ok') {
      throw new Error(
        `fixture repo "${dir}" failed to ingest:\n` +
          `${result.authorSummary ?? '(no summary)'}\n` +
          result.findings.map((f) => `  ${f.severity} ${f.source} ${f.message}`).join('\n'),
      );
    }
  }

  return {
    config,
    authz,
    search,
    reports,
    ingest,
    blobs,
    tenantId,
    repos: {
      handbook: handbook.id,
      specs: specs.id,
      fieldkit: fieldkit.id,
      speicherDocs: speicherDocs.id,
    },
    caller(name) {
      return authz.resolve(rawCaller(name, tenantId));
    },
    async close() {
      if (blobRoot) rmSync(blobRoot, { recursive: true, force: true });
      blobRoot = null;
    },
  };
}

export function rawCaller(name: PrincipalName | 'anonymous', tenantId: string): Caller {
  if (name === 'anonymous') {
    return { tenantId, identity: null, rawGroupIds: [], viaBearer: false };
  }
  const p = PRINCIPALS[name];
  return {
    tenantId,
    identity: { provider: 'entra', subject: p.oid, email: p.email },
    rawGroupIds: [...p.groups],
    viaBearer: false,
  };
}

export async function defaultTenantId(): Promise<string> {
  const rows = await getSequelize().query<{ id: string }>(
    `SELECT id FROM tenants WHERE slug = 'default'`,
    { type: QueryTypes.SELECT },
  );
  return rows[0].id;
}

export async function resetVectorIndex(): Promise<void> {
  const sequelize = getSequelize();
  assertTestDatabase(sequelize.getDatabaseName());
  await sequelize.query(`DROP INDEX IF EXISTS ${VECTOR_INDEX_NAME}`);
  await sequelize.query(`ALTER TABLE chunks ALTER COLUMN embedding TYPE vector`);
}

export async function truncateAll(): Promise<void> {
  const sequelize = getSequelize();
  assertTestDatabase(sequelize.getDatabaseName());
  await sequelize.query(`
    TRUNCATE documents, folders, assets, redirects, chunks, sync_runs, jobs,
             repo_slug_history, repos, installations, forges, webhook_deliveries,
             sessions, magic_link_tokens, login_flows, notification_state,
             oauth_grants, oauth_codes,
             rate_limits, instance_state, instance_configs, brand_images,
             page_views, search_misses
      RESTART IDENTITY CASCADE
  `);
}

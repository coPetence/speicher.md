/**
 *   npm run dev:seed
 */
import { resolve } from 'node:path';

import { QueryTypes } from 'sequelize';

import { BlobStore, blobStoreFor } from '../src/assets/blob-store';
import { mcpResourceIdentifier } from '../src/auth/oauth/metadata';
import { SESSION_COOKIE } from '../src/auth/session.service';
import { ACCESS_TOKEN_PREFIX, hashToken, mintPrefixed, mintToken } from '../src/auth/tokens';
import { subjectPrincipal } from '../src/common/principals';
import { ConfigService } from '../src/config/config.service';
import { loadActiveInstanceConfig } from '../src/config/loader';
import { migrateUp } from '../src/db/migrate';
import { Forge, OauthGrant, Repo, Session, initModels } from '../src/db/models';
import { closeSequelize, getSequelize } from '../src/db/sequelize';
import { IngestService } from '../src/ingest/ingest.service';
import { devEnv } from './dev-env';

const FIXTURES = resolve(__dirname, '../test/fixtures');

let blobs: BlobStore | undefined;

process.env.SPEICHER_LOG_LEVEL ??= 'error';
Object.assign(process.env, devEnv());

const PEOPLE = [
  {
    name: 'alice',
    oid: 'alice-oid',
    email: 'alice@copetence.test',
    groups: ['grp-eng'],
    sees: 'engineering — handbook root, plus all of fieldkit',
  },
  {
    name: 'bob',
    oid: 'bob-oid',
    email: 'bob@copetence.test',
    groups: ['grp-com'],
    sees: 'commercial — plus the commercial subtree',
  },
  {
    name: 'carol',
    oid: 'carol-oid',
    email: 'carol@northwind.test',
    groups: ['grp-northwind'],
    sees: 'client-northwind — plus northwind/ and the second repo',
  },
  {
    name: 'dave',
    oid: 'dave-oid',
    email: 'dave@partner.test',
    groups: [],
    sees: 'an individual grant at the repo root, no groups',
  },
  {
    name: 'ops',
    oid: 'ops-oid',
    email: 'ops@copetence.test',
    groups: ['grp-ops'],
    sees: 'admin: /-/* but NO content at all',
  },
  {
    name: 'mallory',
    oid: 'mallory-oid',
    email: 'mallory@elsewhere.test',
    groups: [],
    sees: 'authenticated, granted nothing',
  },
] as const;

async function main(): Promise<void> {
  const sequelize = getSequelize();
  initModels(sequelize);
  await migrateUp(sequelize);

  const config = new ConfigService(await loadActiveInstanceConfig());

  await sequelize.query(
    `TRUNCATE documents, folders, assets, redirects, chunks, sync_runs, jobs,
             repo_slug_history, repos, installations, forges, webhook_deliveries,
             sessions, magic_link_tokens, login_flows, notification_state,
             oauth_grants, oauth_codes, rate_limits, instance_state
       RESTART IDENTITY CASCADE`,
  );

  const [tenant] = await sequelize.query<{ id: string }>(
    `SELECT id FROM tenants WHERE slug = 'default'`,
    { type: QueryTypes.SELECT },
  );

  const forge = await Forge.create({
    tenant_id: tenant.id,
    key: 'gh',
    type: 'github',
    is_primary: true,
    default_repository_owner: 'copetence',
    config: {},
  });

  const repos = [
    { dir: 'handbook', namespace: 'copetence', slug: 'handbook', forgeRepoId: '41775317' },
    { dir: 'specs', namespace: 'northwind-engineering', slug: 'specs', forgeRepoId: '41775318' },
    { dir: 'fieldkit', namespace: 'copetence', slug: 'fieldkit', forgeRepoId: '41775319' },
  ];

  blobs = blobStoreFor(config);
  const ingest = new IngestService(config, blobs, sequelize);

  for (const spec of repos) {
    const repo = await Repo.create({
      tenant_id: tenant.id,
      forge_id: forge.id,
      forge_repo_id: spec.forgeRepoId,
      namespace: spec.namespace,
      namespace_id: '9000',
      slug: spec.slug,
      branch: 'main',
    });
    const result = await ingest.syncRepo(repo.id, {
      workingTree: resolve(FIXTURES, 'repos', spec.dir),
      sha: '0'.repeat(40),
      trigger: 'manual',
    });
    if (result.status !== 'ok') {
      throw new Error(
        `${spec.dir} failed to ingest:\n${result.findings
          .map((f) => `  ${f.severity} ${f.source} ${f.message}`)
          .join('\n')}`,
      );
    }
    process.stdout.write(
      `ingested ${spec.namespace}/${spec.slug}: ` +
        `${result.stats.documents} pages, ${result.stats.assets} assets\n`,
    );
  }

  const rows: {
    name: string;
    subject: string;
    groups: string;
    cookie: string;
    key: string;
    sees: string;
  }[] = [];

  for (const person of PEOPLE) {
    const token = mintToken();
    await Session.create({
      tenant_id: tenant.id,
      token_hash: hashToken(token),
      provider: 'entra',
      subject: person.oid,
      email: person.email,
      raw_group_ids: [...person.groups],
      groups_fetched_at: new Date(),
      // Long enough to be useful for an afternoon of poking.
      expires_at: new Date(Date.now() + 7 * 24 * 3600_000),
    });

    // An MCP connection as OAuth would leave it, minus the refresh token
    const access = mintPrefixed(ACCESS_TOKEN_PREFIX);
    await OauthGrant.create({
      tenant_id: tenant.id,
      principal: subjectPrincipal('entra', person.oid),
      client_id: 'dev-seed',
      client_name: `${person.name} dev token`,
      resource: mcpResourceIdentifier() ?? 'http://127.0.0.1:3000/mcp',
      access_hash: access.hash,
      refresh_hash: null,
      scopes: ['read'],
      provider: 'entra',
      subject: person.oid,
      email: person.email,
      raw_group_ids: [...person.groups],
      access_expires_at: new Date(Date.now() + 7 * 24 * 3600_000),
      refresh_expires_at: null,
    });

    rows.push({
      name: person.name,
      subject: person.oid,
      groups: person.groups.join(','),
      cookie: token,
      key: access.token,
      sees: person.sees,
    });
  }

  const base = process.env.SPEICHER_PUBLIC_URL ?? 'http://127.0.0.1:3000';

  process.stdout.write('\nSeeded. Start the app, then browse as one of these:\n\n');
  for (const row of rows) {
    process.stdout.write(`  ${row.name}  — ${row.sees}\n`);
    process.stdout.write(
      `    browser : ${base}/api/auth/dev-login?subject=${row.subject}&groups=${row.groups}\n`,
    );
    process.stdout.write(
      `    curl    : curl -s -b '${SESSION_COOKIE}=${row.cookie}' ${base}/handbook/\n`,
    );
    process.stdout.write(`    mcp token: ${row.key}\n\n`);
  }
  process.stdout.write(
    'The browser links need SPEICHER_DEV_LOGIN=true; without it that route 404s like\n' +
      'any other. Never set it on anything reachable from outside your machine: it\n' +
      'hands out a session for any identity it is given, with no authentication.\n' +
      'The cookies and tokens above work regardless — they are real rows.\n',
  );
}

main()
  .catch((err) => {
    process.stderr.write(`${(err as Error).stack ?? (err as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await blobs?.close?.();
    await closeSequelize();
  });

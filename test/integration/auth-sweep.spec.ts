import { sweepExpiredAuth } from '../../src/auth/expiry-sweep';
import { hashToken, mintToken } from '../../src/auth/tokens';
import { OauthCode, OauthGrant, Session } from '../../src/db/models';
import { closeSequelize } from '../../src/db/sequelize';
import { Harness, createHarness } from '../helpers/harness';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
  await closeSequelize();
});

const HOUR = 3_600_000;
const at = (offset: number) => new Date(Date.now() + offset);

async function session(endsIn: number): Promise<string> {
  const row = await Session.create({
    tenant_id: harness.tenantId,
    token_hash: hashToken(mintToken()),
    provider: 'test',
    subject: 'someone',
    email: null,
    raw_group_ids: [],
    expires_at: at(endsIn),
  });
  return row.id;
}

async function code(endsIn: number): Promise<string> {
  const row = await OauthCode.create({
    tenant_id: harness.tenantId,
    code_hash: hashToken(mintToken()),
    client_id: 'https://client.example/metadata.json',
    client_name: null,
    redirect_uri: 'https://client.example/callback',
    resource: 'https://docs.example.com/mcp',
    scope: 'read',
    code_challenge: 'challenge',
    provider: 'test',
    subject: 'someone',
    email: null,
    raw_group_ids: [],
    expires_at: at(endsIn),
  });
  return row.id;
}

async function connection(options: { endsIn: number | null; revoked?: boolean }): Promise<string> {
  const row = await OauthGrant.create({
    tenant_id: harness.tenantId,
    principal: 'test:someone',
    client_id: 'https://client.example/metadata.json',
    client_name: null,
    resource: 'https://docs.example.com/mcp',
    access_hash: hashToken(mintToken()),
    refresh_hash: hashToken(mintToken()),
    scopes: ['read'],
    provider: 'test',
    subject: 'someone',
    email: null,
    raw_group_ids: [],
    access_expires_at: at(-HOUR),
    refresh_expires_at: options.endsIn === null ? null : at(options.endsIn),
    revoked_at: options.revoked ? new Date() : null,
  });
  return row.id;
}

describe('the sweep of expired sign-in state', () => {
  it('deletes sessions that have ended and keeps the ones still running', async () => {
    const ended = await session(-HOUR);
    const running = await session(HOUR);

    await sweepExpiredAuth();

    expect(await Session.findByPk(ended)).toBeNull();
    expect(await Session.findByPk(running)).not.toBeNull();
  });

  it('deletes authorization codes nobody exchanged in time', async () => {
    const stale = await code(-60_000);
    const fresh = await code(60_000);

    await sweepExpiredAuth();

    expect(await OauthCode.findByPk(stale)).toBeNull();
    expect(await OauthCode.findByPk(fresh)).not.toBeNull();
  });

  it('deletes connections that have ended or were disconnected', async () => {
    const ended = await connection({ endsIn: -HOUR });
    const disconnected = await connection({ endsIn: 30 * 24 * HOUR, revoked: true });

    await sweepExpiredAuth();

    expect(await OauthGrant.findByPk(ended)).toBeNull();
    expect(await OauthGrant.findByPk(disconnected)).toBeNull();
  });

  it('keeps a connection in use, even when only its access token has expired', async () => {
    const inUse = await connection({ endsIn: 30 * 24 * HOUR });
    const endless = await connection({ endsIn: null });

    await sweepExpiredAuth();

    expect(await OauthGrant.findByPk(inUse)).not.toBeNull();
    expect(await OauthGrant.findByPk(endless)).not.toBeNull();
  });

  it('says how much it deleted', async () => {
    await session(-HOUR);
    await code(-60_000);
    await connection({ endsIn: -HOUR });

    const swept = await sweepExpiredAuth();

    expect(swept.sessions).toBeGreaterThanOrEqual(1);
    expect(swept.codes).toBeGreaterThanOrEqual(1);
    expect(swept.connections).toBeGreaterThanOrEqual(1);
  });
});

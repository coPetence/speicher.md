import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { installErrorHandler } from '../../src/app-errors';
import { configureApp } from '../../src/app-setup';
import { mcpResourceIdentifier } from '../../src/auth/oauth/metadata';
import { SESSION_COOKIE } from '../../src/auth/session.service';
import { ACCESS_TOKEN_PREFIX, hashToken, mintPrefixed, mintToken } from '../../src/auth/tokens';
import { subjectPrincipal } from '../../src/common/principals';
import { ConfigService } from '../../src/config/config.service';
import { OauthGrant, Session, initModels } from '../../src/db/models';
import { GITHUB_APP_LOOKUP_FETCH } from '../../src/github/app-links';
import { PRINCIPALS, PrincipalName } from './harness';

const offlineFetch = (async () => {
  throw new Error('tests do not reach GitHub');
}) as typeof fetch;

export async function bootTestApp(
  config?: ConfigService,
  extraControllers: Parameters<typeof Test.createTestingModule>[0]['controllers'] = [],
  overrides: { token: unknown; value: unknown }[] = [],
): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule], controllers: extraControllers });

  if (!overrides.some(({ token }) => token === GITHUB_APP_LOOKUP_FETCH)) {
    builder.overrideProvider(GITHUB_APP_LOOKUP_FETCH).useValue(offlineFetch);
  }
  for (const { token, value } of overrides) builder.overrideProvider(token).useValue(value);
  if (config) builder.overrideProvider(ConfigService).useValue(config);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({
    rawBody: true,
  });
  configureApp(app);
  await app.init();
  installErrorHandler(app);
  await app.listen(0);
  return app;
}

export async function sessionCookieFor(
  tenantId: string,
  name: PrincipalName,
  provider = 'entra',
): Promise<string> {
  initModels();
  const person = PRINCIPALS[name];
  const token = mintToken();
  await Session.create({
    tenant_id: tenantId,
    token_hash: hashToken(token),
    provider,
    subject: person.oid,
    email: person.email,
    raw_group_ids: [...person.groups],
    groups_fetched_at: new Date(),
    expires_at: new Date(Date.now() + 3_600_000),
  });
  return `${SESSION_COOKIE}=${token}`;
}

/** An OAuth access token for a reader, as an MCP client holds one after connecting */
export async function accessTokenFor(tenantId: string, name: PrincipalName): Promise<string> {
  initModels();
  const person = PRINCIPALS[name];
  const access = mintPrefixed(ACCESS_TOKEN_PREFIX);
  await OauthGrant.create({
    tenant_id: tenantId,
    principal: subjectPrincipal('entra', person.oid),
    client_id: 'https://client.example.test/metadata.json',
    client_name: `${name} test client`,
    resource: mcpResourceIdentifier() ?? 'http://127.0.0.1/mcp',
    access_hash: access.hash,
    refresh_hash: null,
    scopes: ['read'],
    provider: 'entra',
    subject: person.oid,
    email: person.email,
    raw_group_ids: [...person.groups],
    access_expires_at: new Date(Date.now() + 3_600_000),
    refresh_expires_at: null,
  });
  return access.token;
}

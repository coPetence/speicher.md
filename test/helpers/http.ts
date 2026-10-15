import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { installErrorHandler } from '../../src/app-errors';
import { configureApp } from '../../src/app-setup';
import { ApiKeyService } from '../../src/auth/api-key.service';
import { SESSION_COOKIE } from '../../src/auth/session.service';
import { hashToken, mintToken } from '../../src/auth/tokens';
import { ConfigService } from '../../src/config/config.service';
import { Session, initModels } from '../../src/db/models';
import { GITHUB_APP_LOOKUP_FETCH } from '../../src/forge/github/app-links';
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

export async function apiKeyFor(tenantId: string, name: PrincipalName): Promise<string> {
  const person = PRINCIPALS[name];
  const service = new ApiKeyService();
  const key = await service.issue(
    tenantId,
    { provider: 'entra', subject: person.oid, email: person.email },
    `${name} test key`,
    new Date(Date.now() + 3_600_000),
    ['read'],
    [...person.groups],
  );
  return key.token;
}

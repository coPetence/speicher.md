/**
 * Sequelize model definitions and initialisation
 *
 * Every table is a typed class in a file of its own; `initModels` initialises all of
 * them once and sets up their associations. The schema itself is owned by the
 * migrations, not by these models.
 */
import { Sequelize } from 'sequelize';

import { getSequelize } from '../sequelize';
import { Asset, initAsset } from './asset';
import { Chunk, initChunk } from './chunk';
import { Document, initDocument } from './document';
import { Folder, initFolder } from './folder';
import { Forge, initForge } from './forge';
import { InstanceState, initInstanceState } from './instance-state';
import { Installation, initInstallation } from './installation';
import { Job, initJob } from './job';
import { LoginFlow, initLoginFlow } from './login-flow';
import { MagicLinkToken, initMagicLinkToken } from './magic-link-token';
import { NotificationState, initNotificationState } from './notification-state';
import { OauthCode, initOauthCode } from './oauth-code';
import { OauthGrant, initOauthGrant } from './oauth-grant';
import { Redirect, initRedirect } from './redirect';
import { Repo, initRepo } from './repo';
import { RepoSlugHistory, initRepoSlugHistory } from './repo-slug-history';
import { Session, initSession } from './session';
import { SyncRun, initSyncRun } from './sync-run';
import { Tenant, initTenant } from './tenant';
import { WebhookDelivery, initWebhookDelivery } from './webhook-delivery';

export {
  Asset,
  Chunk,
  Document,
  Folder,
  Forge,
  InstanceState,
  Installation,
  Job,
  LoginFlow,
  MagicLinkToken,
  NotificationState,
  OauthCode,
  OauthGrant,
  Redirect,
  Repo,
  RepoSlugHistory,
  Session,
  SyncRun,
  Tenant,
  WebhookDelivery,
};

let initialized = false;

/** initModels initialises every model on the given connection, once per process */
export function initModels(sequelize: Sequelize = getSequelize()): Sequelize {
  if (initialized) return sequelize;
  initialized = true;

  initTenant(sequelize);
  initForge(sequelize);
  initInstallation(sequelize);
  initRepo(sequelize);
  initRepoSlugHistory(sequelize);
  initDocument(sequelize);
  initFolder(sequelize);
  initAsset(sequelize);
  initRedirect(sequelize);
  initSyncRun(sequelize);
  initJob(sequelize);
  initWebhookDelivery(sequelize);
  initOauthCode(sequelize);
  initOauthGrant(sequelize);
  initSession(sequelize);
  initMagicLinkToken(sequelize);
  initLoginFlow(sequelize);
  initNotificationState(sequelize);
  initInstanceState(sequelize);
  initChunk(sequelize);

  Repo.belongsTo(Forge, { foreignKey: 'forge_id', as: 'forge' });
  Forge.hasMany(Repo, { foreignKey: 'forge_id', as: 'repos' });
  RepoSlugHistory.belongsTo(Repo, { foreignKey: 'repo_id', as: 'repo' });
  SyncRun.belongsTo(Repo, { foreignKey: 'repo_id', as: 'repo' });

  return sequelize;
}

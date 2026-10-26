import { ConfigInstanceController } from './config-instance.controller';
import { ConfigVersionsController } from './config-versions.controller';
import { ConfigController } from './config.controller';
import { GithubAppManifestController } from './github-app-manifest.controller';

export const CONFIG_CONTROLLERS = [
  ConfigVersionsController,
  ConfigInstanceController,
  GithubAppManifestController,
  ConfigController,
];

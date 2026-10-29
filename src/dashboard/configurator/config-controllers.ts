import { ConfigInstanceController } from './config-instance.controller';
import { ConfigVersionsController } from './config-versions.controller';
import { ConfigController } from './config.controller';
import { GithubAppManifestController } from './github-app-manifest.controller';
import { QuickSetupController } from './quick-setup.controller';

export const CONFIG_CONTROLLERS = [
  ConfigVersionsController,
  ConfigInstanceController,
  GithubAppManifestController,
  QuickSetupController,
  ConfigController,
];

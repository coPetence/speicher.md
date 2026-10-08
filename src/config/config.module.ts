import { Global, Module } from '@nestjs/common';

import { ConfigService } from './config.service';
import { loadActiveInstanceConfig } from './loader';
import { LoadedInstanceConfig } from './parser';
import { ConfigWatcher } from './watcher';

export {
  CONFIG_SOURCE_ENV,
  INSTANCE_CONFIG_PATH_ENV,
  resolveConfigPath,
  resolveConfigSource,
} from './loader';

export const LOADED_INSTANCE_CONFIG = 'LOADED_INSTANCE_CONFIG';

/**
 * NestJS global module providing config to the whole app
 *
 * Loads the active instance config once at module init via the registered source
 * Exposes ConfigService (read access), ConfigWatcher (live reload), and the raw
 * loaded config token for other modules that need the unprocessed object
 */
@Global()
@Module({
  providers: [
    {
      provide: LOADED_INSTANCE_CONFIG,
      useFactory: (): Promise<LoadedInstanceConfig> => loadActiveInstanceConfig(),
    },
    {
      provide: ConfigService,
      inject: [LOADED_INSTANCE_CONFIG],
      useFactory: (loaded: LoadedInstanceConfig) => new ConfigService(loaded),
    },

    ConfigWatcher,
  ],
  exports: [ConfigService, ConfigWatcher, LOADED_INSTANCE_CONFIG],
})
export class ConfigModule {}

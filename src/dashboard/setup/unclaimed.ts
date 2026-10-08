/**
 * Minimal config and factory for an unclaimed instance
 *
 * Used when there is no stored instance config and no file-based config,
 * so the app serves the claim page instead of a configured instance
 *
 * source is set to 'database' to keep the frontend on the database path;
 * version is null to indicate no configuration was ever saved
 */
import { LoadedInstanceConfig, loadInstanceConfig } from '../../config/parser';

export const UNCLAIMED_YAML = 'version: 1\n';

export function unclaimedInstanceConfig(): LoadedInstanceConfig {
  return {
    ...loadInstanceConfig(UNCLAIMED_YAML),
    source: 'database',

    version: null,
  };
}

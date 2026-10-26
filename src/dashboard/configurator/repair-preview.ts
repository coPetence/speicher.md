import { ConfigError } from '../../common/errors';
import { repairInstanceConfig } from '../../config/repair';
import { ConfigDiff, diffConfigVersions } from './config-form/diff';

/** What repairing a saved version changes, and what it cannot fix */
export interface RepairPreview {
  diff: ConfigDiff | null;
  remaining: string[];
}

/**
 * Repairs a saved version without saving it
 *
 * @param yaml the saved version that does not load
 */
export function previewRepair(yaml: string): RepairPreview {
  try {
    const repaired = repairInstanceConfig(yaml);
    return { diff: diffConfigVersions(yaml, repaired.yaml), remaining: repaired.remaining };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return { diff: null, remaining: [err.message] };
  }
}

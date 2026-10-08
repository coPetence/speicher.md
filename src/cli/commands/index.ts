import { Command } from '../command-types';
import { adminCommand } from './admin';
import { claimCommand } from './claim';
import { configCommand } from './config';
import { jobsCommand } from './jobs';
import { forgesCommand, reposCommand } from './list';
import { migrateCommand } from './migrate';
import { rebuildCommand } from './rebuild';
import { reembedCommand } from './reembed';
import { reopenClaimWindowCommand } from './reopen-claim-window';
import { syncRepoContentCommand } from './sync-repo-content';
import { syncRepoListCommand } from './sync-repo-list';

/** Every command, in the order the usage banner lists them */
export const COMMANDS: Record<string, Command> = {
  migrate: migrateCommand,
  rebuild: rebuildCommand,
  reembed: reembedCommand,
  claim: claimCommand,
  'reopen-claim-window': reopenClaimWindowCommand,
  jobs: jobsCommand,
  'sync-repo-list': syncRepoListCommand,
  'sync-repo-content': syncRepoContentCommand,
  repos: reposCommand,
  forges: forgesCommand,
  config: configCommand,
  admin: adminCommand,
};

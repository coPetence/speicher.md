/*
 * Run the worker with the same environment as `npm run dev`.
 *
 *   npm run worker:dev
 */
import { devEnv, runFromSource } from './dev-env';

runFromSource('src/worker.ts', devEnv());

/**
 * Public surface of the context-recall module.
 *
 * The chat-loop is the only consumer that runs the pipeline; the UI
 * layer reads cached payloads via the SupabaseService Thread shape.
 * The trigger evaluator is shared with intuition (see
 * src/lib/intuition/triggers.ts) - context-recall does not maintain
 * its own trigger logic by design.
 *
 * Anything not re-exported here is intentionally internal. Tests
 * reach into `./cache`, `./pipeline`, `./types`, `./ephemeral`
 * directly because the test-only hooks should never be a public
 * surface. The `_clearContextRecallInflightForTests` helper lives
 * in `./cache` and is imported directly by the suites that need
 * it; do not re-export it from this barrel.
 */
export {
  coerceContextRecallPayload,
  pickFresherContextRecallPayload,
  type ContextRecallPayload,
} from './types';

export { runContextRecallPipeline } from './pipeline';

export {
  readContextRecallCache,
  writeContextRecallCache,
  withContextRecallInflight,
} from './cache';

export { buildContextRecallThinkMessage } from './ephemeral';

/**
 * Public surface of the context-recall module.
 *
 * The chat-loop is the only consumer that runs the pipeline; the UI
 * layer reads cached payloads via the SupabaseService Thread shape.
 * The trigger evaluator is shared with intuition (see
 * src/lib/intuition/triggers.ts) - context-recall does not maintain
 * its own trigger logic by design.
 */
export {
  coerceContextRecallPayload,
  pickFresherContextRecallPayload,
  type ContextRecallPayload,
} from './types';

export {
  runContextRecallPipeline,
  stitchRecallNotes,
  type RunContextRecallInputs,
} from './pipeline';

export {
  readContextRecallCache,
  writeContextRecallCache,
  withContextRecallInflight,
  _clearContextRecallInflightForTests,
} from './cache';

export {
  buildContextRecallThinkMessage,
  CONTEXT_RECALL_THINK_MARKER,
} from './ephemeral';

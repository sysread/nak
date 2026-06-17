/**
 * Public surface of the intuition module.
 *
 * The chat-loop is the only consumer that runs the pipeline; the UI
 * layer reads cached payloads via the SupabaseService Thread shape
 * and renders the modal / inline card.
 *
 * Anything internal (prompts, ephemeral think-marker, the
 * test-only inflight reset, sub-module types like
 * `IntuitionTrigger` / `RunIntuitionInputs` / `RoundCacheSnapshot` /
 * `TriggerContext`) is intentionally not re-exported here. The two
 * sub-modules that need those (pipeline, triggers) import them
 * directly from `./types` so the barrel doesn't accumulate a wide
 * public surface no consumer reads.
 */
export {
  DRIVE_NAMES,
  type DriveName,
} from './prompts';

export {
  STALE_FUSE_ROUNDS,
  STALE_FUSE_MS,
  coerceIntuitionPayload,
  countUserRounds,
  pickFresherIntuitionPayload,
  type IntuitionPayload,
} from './types';

export { maybeRunIntuitionPipeline } from './pipeline';

export { readIntuitionCache, writeIntuitionCache } from './cache';

export { evaluatePreRoundTrigger, isPayloadFreshForInjection } from './triggers';

export { buildIntuitionThinkMessage } from './ephemeral';

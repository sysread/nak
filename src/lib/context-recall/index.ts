/**
 * Public surface of the context-recall module.
 *
 * Pre-turn priming runs server-side in the venice edge function; the
 * browser no longer runs the pipeline. The UI layer reads cached
 * payloads via the SupabaseService Thread shape, and the realtime
 * thread merge picks the fresher of two payloads.
 */
export {
  coerceContextRecallPayload,
  pickFresherContextRecallPayload,
  type ContextRecallPayload,
  type ContextRecallCitation,
} from './types';

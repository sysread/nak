/**
 * Public surface of the intuition module.
 *
 * Pre-turn priming runs server-side in the venice edge function; the
 * browser no longer runs the pipeline. The UI layer reads cached
 * payloads via the SupabaseService Thread shape and renders the modal
 * / inline card, and the injection-side freshness guard
 * (isPayloadFreshForInjection) is consumed by the UI staleness verdict
 * in src/lib/ui/payload-freshness.ts.
 *
 * DRIVE_NAMES / DriveName feed the Intuition modal's per-drive layout
 * and the payload's `drives` map; the staleness constants and payload
 * coercion/merge helpers are read by the UI and the realtime thread
 * merge.
 */
export {
  DRIVE_NAMES,
  type DriveName,
} from './prompts';

export {
  STALE_FUSE_MS,
  coerceIntuitionPayload,
  countUserRounds,
  pickFresherIntuitionPayload,
  type IntuitionPayload,
} from './types';

export { isPayloadFreshForInjection } from './triggers';

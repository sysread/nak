/**
 * Public surface of the intuition module.
 *
 * The chat-loop is the only consumer that runs the pipeline; the UI
 * layer reads cached payloads via the SupabaseService Thread shape
 * and renders the modal / inline card.
 */
export {
  PERCEPTION_PROMPT,
  SYNTHESIS_PROMPT,
  DRIVE_BASE_PROMPT,
  DRIVE_PROMPTS,
  DRIVE_NAMES,
  type DriveName,
} from './prompts';

export {
  STALE_FUSE_ROUNDS,
  coerceIntuitionPayload,
  countUserRounds,
  pickFresherIntuitionPayload,
  type IntuitionPayload,
  type IntuitionTrigger,
} from './types';

export { runIntuitionPipeline, type RunIntuitionInputs } from './pipeline';

export {
  readIntuitionCache,
  writeIntuitionCache,
  withIntuitionInflight,
  _clearInflightForTests,
} from './cache';

export {
  evaluatePreRoundTrigger,
  evaluateTitleTrigger,
  type TriggerContext,
} from './triggers';

export {
  buildIntuitionThinkMessage,
  INTUITION_THINK_MARKER,
} from './ephemeral';

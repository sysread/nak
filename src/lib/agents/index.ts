/**
 * Barrel for the agents subsystem. Right now it's interface-only —
 * concrete agent implementations (memory reflection, summarisation, …)
 * will land as siblings of this file alongside a worker harness
 * (`./worker.ts`) and a cross-tab-singleton `AgentManager`
 * (`./manager.ts`) modelled on the embeddings subsystem.
 *
 * Re-export everything from `./types` so the rest of the app imports
 * `'$lib/agents'` rather than `'$lib/agents/types'`. Keeps the public
 * surface in one place.
 */
export type {
  Agent,
  AgentRunRequest,
  AgentRunResult,
  AgentStoppedReason,
} from './types';

export { ReflectionAgent } from './reflection/agent';
export type {
  ReflectionInput,
  ReflectionOutput,
} from './reflection/agent';
export { REFLECTION_PROMPT } from './reflection/prompt';

export { RecallAgent, trimToLastUserTurn, parseRecallOutput } from './recall/agent';
export type {
  RecallInput,
  RecallOutput,
  RecallNote,
} from './recall/agent';
export { RECALL_PROMPT } from './recall/prompt';

export { SummaryAgent } from './summary/agent';
export type { SummaryInput, SummaryOutput } from './summary/agent';
export { SUMMARY_PROMPT } from './summary/prompt';

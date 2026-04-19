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

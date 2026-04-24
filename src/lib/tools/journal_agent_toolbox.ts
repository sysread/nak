/**
 * Toolbox for the background journaling agent (src/lib/agents/journal/).
 * Factored into its own leaf file for the same reason
 * `./memory_toolbox.ts` is: the journaling agent runs inside a Web
 * Worker, and Vite's default worker output format is IIFE, which is
 * incompatible with code-splitting. If the agent imported from
 * `./index.ts`, the worker bundle would transitively pull in
 * `research_docs` -> `src/lib/docs.ts`'s lazy doc glob -> code
 * splitting -> build crash.
 *
 * Shape: only the write tool the agent actually needs. List / read /
 * search / delete are user-facing and live in the main-chat toolbox
 * instead - the journaling agent has the full thread in context and
 * knows today's existing automatic entry was passed into its prompt,
 * so it has no use for read tools during its run.
 */
import type { Toolbox } from './types';
import { journalUpsert } from './journal_upsert';

export const journalAgentToolbox: Toolbox = {
  name: 'journal_agent',
  description:
    "Upsert-only toolbox for the journaling agent. Writes today's " +
    'automatic entry; no read / delete / search tools - the agent ' +
    "already has the full conversation and today's existing entry in " +
    'its prompt.',
  tools: [journalUpsert],
};

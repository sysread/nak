/**
 * Toolbox for the recall agent. Factored out of `./index.ts` to break
 * a circular import: `memory_recall` (the tool that triggers the
 * recall agent) lives in `./index.ts`'s TOOLS list, and the recall
 * agent needs its own toolbox — if the agent imported it from
 * `./index.ts` we'd have tools/index → memory_recall → recall/agent →
 * tools/index, which ES module circularity handles badly (the agent
 * would load before `memoryRecall` was defined, giving it an
 * undefined toolbox at class-init time).
 *
 * Keeping this file importable on its own — it reaches only for
 * `./memory_search` — lets both the agent and `./index.ts` read from
 * it without a cycle.
 *
 * The toolbox is intentionally read-only: `memory_search` is the
 * only tool the recall agent is allowed to call. No create / update /
 * invalidate / delete — a bug in the recall prompt shouldn't be able
 * to scribble over long-term memory, and `memory_recall` is excluded
 * so the agent can't recurse into another recall pass.
 */
import type { Toolbox } from './types';
import { memorySearch } from './memory_search';

export const recallToolbox: Toolbox = {
  name: 'recall',
  description:
    "Read-only view into the signed-in user's memories. Vector + " +
    'text search is available via memory_search. No write tools — the ' +
    "recall agent is a reader, not a curator.",
  tools: [memorySearch],
};

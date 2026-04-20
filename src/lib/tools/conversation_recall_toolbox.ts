/**
 * Toolbox for the conversation-recall agent. Mirror of `./recall_toolbox`
 * for the memory side — factored out of `./index.ts` for the same
 * circular-import reason: `conversation_recall` (the tool that
 * triggers the conversation-recall agent) lives in `./index.ts`'s
 * TOOLS list, and the agent needs its own toolbox. An import from
 * `./index.ts` here would be tools/index → conversation_recall →
 * agents/conversation_recall → tools/index, which ES module
 * circularity handles badly (the agent would load before
 * `conversationRecall` was defined, giving it an undefined toolbox at
 * class-init time).
 *
 * Read-only by design: `conversation_search` is the only tool the
 * recall agent is allowed to call. No way to mutate a thread from the
 * recall path — the agent's job is to read past conversations and
 * write a short first-person note, not to touch the threads table.
 */
import type { Toolbox } from './types';
import { conversationSearch } from './conversation_search';

export const conversationRecallToolbox: Toolbox = {
  name: 'conversation-recall',
  description:
    "Read-only view into the signed-in user's prior conversations. " +
    'Full exact + semantic search over every thread is available via ' +
    "conversation_search. No write tools — the recall agent doesn't " +
    'rename, archive, or otherwise touch threads.',
  tools: [conversationSearch],
};

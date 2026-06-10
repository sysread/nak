// Wiki-recall agent. Sibling of memory_recall and conversation_recall
// but the recall target is the user's wiki - flat encyclopedic
// articles ABOUT topics in their life. Mirror of
// src/lib/agents/wiki_recall/ (agent.ts + prompt.ts) and the
// wiki_recall tool wrapping it.
//
// Same run shape as the other recall agents: trim the thread to its
// last user turn, append a recall-instruction user turn, run the
// headless tool loop with a wiki_search-only toolbox, parse the
// model's JSON into a RecallNote. Read-only by design - the agent
// can search but never mutate articles.

import { createEdgeLogger } from '../../_shared/edge-log.ts';
import { registerTool, requireThreadId, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { wikiSearch } from '../tools/wiki_search.ts';
import {
  runHeadlessAgent,
  type AgentTool,
  type AgentToolContext,
  type Toolbox,
} from './_run.ts';
import {
  loadThreadSlice,
  logPreview,
  messageToVenice,
  parseRecallOutput,
  type RecallNote,
  type VeniceWireMessage,
} from './_recall_helpers.ts';

const WIKI_RECALL_MODEL = 'deepseek-v4-flash';

const WIKI_SEARCH_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'wiki_search',
    description:
      "Semantic search over the user's wiki - encyclopedic articles " +
      "about projects, people, places, and topics in their life. " +
      'Returns matching articles with their full body inlined.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language query. Embedding match (paraphrases work).',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Max results (default 5).',
        },
      },
      additionalProperties: false,
    },
  },
};

const BASE_PROMPT = `You've just read the conversation above. Step out of the role of the
main assistant - this time, you're not replying to the user. Your job
is to pull relevant context out of the user's wiki - flat encyclopedic
articles ABOUT the user (their projects, the people in their life,
places they live or visit, things they are learning, their work,
ongoing experiments).

First, decide which mode you are in by reading the latest user turn:

  EXPLICIT recall: the user asked the main model directly about an
  article in their wiki - "what does my wiki say about X?", "pull
  up the article on Y", "remind me what we have written about Z".
  The user wants the article surfaced. Bar is LOW: the relevance
  test IS the question, so do not also filter on "would it change
  how the main model frames the answer." Surface what you find with
  enough detail to answer the user.

  IMPLICIT recall: the user asked a regular question and the main
  model called recall hoping context from an article would help.
  Bar is MODERATE: emit when an article adds useful signal -
  subject-matter detail (people, places, plans, ongoing state) or
  calibration ("the user is deep in this", "the user has a stub on
  this"). Drop notes that exactly duplicate what is already in-
  thread, but do not over-filter. A partial-signal note is usually
  better than empty; the main model decides what to lean on. Reach
  for kind:none only when searches genuinely returned nothing OR
  every article duplicates the conversation word-for-word.

Two channels worth surfacing in either mode:

  (1) DETAILS from articles the main model would benefit from
      knowing - the actual subject matter (people involved, places,
      plans, ongoing state, decisions captured in the article).

  (2) CALIBRATION about how deeply the user has invested in this
      topic - a long, detailed article signals "the user is past
      the introduction here, do not over-explain"; a stub article
      signals "the user has been collecting notes, not synthesising
      yet."

Workflow:

1. Pick the mode (above), then use \`wiki_search\` - usually more than
   once, with different queries - to find candidate articles.
   IMPORTANT: do not stop after 2-3 near-synonym queries.
2. Cross-check against the conversation. EXPLICIT: do not filter.
   IMPLICIT: drop articles the conversation already restates
   word-for-word; keep articles that add detail or calibration.
3. Assimilate the remaining signal into a short first-person note
   in the main assistant's voice ("the wiki has a detailed entry on
   this - X, Y, Z", "we have a stub article on this - just notes
   that the user is starting to...").

Reply with JSON in one of exactly these two shapes:

- \`{"kind": "none", "reason": "<short diagnostic>"}\` only after
  broadening your queries.
- \`{"kind": "note", "note": "<short first-person paragraph>"}\` with
  the assimilated recall. Keep \`note\` under ~400 characters.

Do not emit any other keys. Do not wrap the JSON in prose or a code
fence.`;

function buildPrompt(topic: string): string {
  const clean = topic.trim();
  if (clean.length === 0) return BASE_PROMPT;
  return (
    BASE_PROMPT + '\n\n' + `The main assistant flagged this topic specifically: ${clean}`
  );
}

async function runWikiRecall(
  ctx: ToolContext,
  topic: string,
): Promise<RecallNote> {
  // Drawer logging. Runs mid-turn inside the chat tool dispatch, so
  // the run - and the finally-flush below - is bounded by the turn.
  const log = createEdgeLogger(ctx.userId, 'wiki-recall');
  try {
    const slice = await loadThreadSlice(ctx.adminClient, requireThreadId(ctx));
    if (slice.length === 0) {
      return { kind: 'none', reason: 'thread has no user turn yet' };
    }

    // The slice ends at the user turn the agent is recalling for
    // (trimToLastUserTurn), so its tail is the input worth previewing.
    log.debug(
      `wiki recall start: ` +
        `${topic.trim().length > 0 ? `topic "${logPreview(topic)}"` : 'no topic flagged'}, ` +
        `latest user turn "${logPreview(slice[slice.length - 1].content ?? '')}"`,
    );

    const convo: VeniceWireMessage[] = slice.map(messageToVenice);
    convo.push({ role: 'user', content: buildPrompt(topic) });

    const recallSearch: AgentTool = {
      name: 'wiki_search',
      wire: WIKI_SEARCH_WIRE_SCHEMA,
      async execute(args, agentCtx) {
        return await wikiSearch.execute(args, {
          adminClient: agentCtx.adminClient,
          userId: agentCtx.userId,
          threadId: agentCtx.threadId,
          signal: agentCtx.signal,
          depth: agentCtx.depth,
        });
      },
    };

    const toolbox: Toolbox = {
      name: 'wikiRecall',
      tools: [recallSearch],
    };

    const apiKey = await readVeniceKey(ctx.adminClient);
    if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

    const baseCtx: Omit<AgentToolContext, 'signal' | 'depth'> = {
      adminClient: ctx.adminClient,
      userId: ctx.userId,
      threadId: ctx.threadId,
    };

    const result = await runHeadlessAgent(
      {
        model: WIKI_RECALL_MODEL,
        messages: convo,
        toolbox,
        baseCtx,
        apiKey,
        signal: ctx.signal,
      },
      ctx.depth ?? 0,
    );

    const note = parseRecallOutput(result.finalText);
    log.info(
      `wiki recall finished (${result.toolCalls} tool call(s), outcome=${note.kind})`,
    );
    return note;
  } catch (err) {
    // Logging only - the failure still propagates to the tool
    // dispatcher unchanged; this line is the drawer-visible reason.
    log.error(
      'wiki recall failed',
      err instanceof Error ? err : new Error(String(err)),
    );
    throw err;
  } finally {
    await log.flush();
  }
}

export const wikiRecall: ToolDef = {
  name: 'wiki_recall',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const topic = typeof args.topic === 'string' ? args.topic : '';
    return await runWikiRecall(ctx, topic);
  },
};

registerTool(wikiRecall);

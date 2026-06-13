// Conversation-recall agent. Sibling of memory_recall but the recall
// target is prior CONVERSATIONS rather than saved memories. Mirror of
// src/lib/agents/conversation_recall/ (agent.ts + prompt.ts) and the
// conversation_recall tool wrapping it.
//
// Same run shape as memory_recall: trim the thread to its last user
// turn, append a recall-instruction user turn, run the headless tool
// loop with a conversation_search-only toolbox, parse the model's
// JSON into a RecallNote. The function-side conversation_search tool
// unconditionally excludes the current thread, so the agent never
// gets the live conversation echoed back as "recall context."

import { createEdgeLogger } from '../../_shared/edge-log.ts';
import { registerTool, requireThreadId, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { conversationSearch } from '../tools/conversation_search.ts';
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

const CONVERSATION_RECALL_MODEL = 'deepseek-v4-flash';

const CONVERSATION_SEARCH_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'conversation_search',
    description:
      "Cosine-similarity search over the user's prior threads, " +
      'hydrated with summaries so you can judge each hit without ' +
      'opening it.',
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
          description: 'Max results (default 10, max 50).',
        },
      },
      additionalProperties: false,
    },
  },
};

const BASE_PROMPT = `You've just read the conversation above. Step out of the role of the
main assistant - this time, you're not replying to the user. Your job
is to pull relevant context from prior conversations the user has had
with you.

First, decide which mode you are in by reading the latest user turn:

  EXPLICIT recall: the user asked the main model directly about a
  past conversation - "what was that thread we had on X?", "remind
  me what we landed on with Y", "did we talk about Z before?". The
  user wants prior threads surfaced. Bar is LOW: the relevance test
  IS the question, so do not also filter on "would it change how
  the main model frames the answer." Surface what you find with
  enough detail to answer the user.

  IMPLICIT recall: the user asked a regular question and the main
  model called recall hoping context from a prior thread would
  help. Bar is MODERATE: emit when a prior thread adds useful
  signal - the actual decision, conclusion, working-through, or
  the calibration of "we have worked on this before, here's the
  shape." Drop threads that exactly duplicate what is already
  in-thread, but do not over-filter. A partial-signal note is
  usually better than empty; the main model decides what to lean
  on. Reach for kind:none only when searches genuinely returned
  nothing OR every thread is word-for-word what the conversation
  already establishes.

Two channels worth surfacing in either mode:

  (1) DETAILS from prior threads the main model would benefit from
      knowing - the actual decision, the actual conclusion, the
      thing the user worked through that informs the current turn.
      In EXPLICIT mode, surface what answers the user. In IMPLICIT
      mode, surface details that add to the current conversation -
      either filling a gap or shaping the answer.

  (2) CALIBRATION about how deeply the user has worked through this
      topic across past threads. If they have iterated across
      several threads, the main model should not retread the basics;
      if fresh direction, it should not assume context. Surface
      calibration that helps the main model frame the answer - even
      a soft "we have circled this a few times before" beats no
      calibration at all.

Workflow:

1. Pick the mode (above), then use \`conversation_search\` - usually
   more than once, with different queries - to find candidate
   threads. IMPORTANT: do not stop after 2-3 near-synonym queries.
   If your first round comes back empty or thin, broaden the angles
   before concluding nothing is there. Productive angles to try
   when the literal topic comes back empty:
     - an adjacent topic or generalisation (asked about a specific
       gardening choice -> try the garden project, the season, the
       location)
     - a person or place that anchors the topic
     - a constraint or recurring concern the user has voiced
     - the most active recent project / thread theme
   Three to five attempts across different angles is usually right.
   In EXPLICIT mode, paraphrase what the user asked. Each search
   result carries a 2-3 sentence summary; read those to judge.
2. Cross-check against the conversation. EXPLICIT: do not filter
   (the user asked, surface it). IMPLICIT: drop threads that the
   conversation already restates word-for-word; keep threads that
   add detail, decision, or calibration even if loosely connected.
3. Assimilate the remaining signal into a short first-person note
   in the main assistant's voice ("I remember we decided...",
   "last time this came up, we...", "we have already worked
   through..."). Blend DETAILS and CALIBRATION when both have
   signal: one short sentence each. When the signal is light but
   real, emit it - a one-line calibration is a useful note.

Reply with JSON in one of exactly these two shapes:

- \`{"kind": "none", "reason": "<short diagnostic>"}\` only after you
  have broadened your queries past the literal topic and still come
  up empty - or every thread is exactly what the conversation
  already states. The \`reason\` is REQUIRED and is for diagnostics -
  keep it short and concrete and name the angles you tried.

- \`{"kind": "note", "note": "<short first-person paragraph>"}\` with
  the assimilated recall. Keep \`note\` under ~400 characters - one
  tight paragraph, not a bulleted list.

Do not emit any other keys. Do not wrap the JSON in prose or a code
fence.`;

function buildPrompt(topic: string): string {
  const clean = topic.trim();
  if (clean.length === 0) return BASE_PROMPT;
  return (
    BASE_PROMPT + '\n\n' + `The main assistant flagged this topic specifically: ${clean}`
  );
}

async function runConversationRecall(
  ctx: ToolContext,
  topic: string,
): Promise<RecallNote> {
  // Drawer logging. Runs mid-turn inside the chat tool dispatch, so
  // the run - and the finally-flush below - is bounded by the turn.
  const log = createEdgeLogger(ctx.userId, 'conversation-recall');
  try {
    const slice = await loadThreadSlice(ctx.adminClient, requireThreadId(ctx));
    if (slice.length === 0) {
      return { kind: 'none', reason: 'thread has no user turn yet' };
    }

    // The slice ends at the user turn the agent is recalling for
    // (trimToLastUserTurn), so its tail is the input worth previewing.
    log.debug(
      `conversation recall start: ` +
        `${topic.trim().length > 0 ? `topic "${logPreview(topic)}"` : 'no topic flagged'}, ` +
        `latest user turn "${logPreview(slice[slice.length - 1].content ?? '')}"`,
    );

    const convo: VeniceWireMessage[] = slice.map(messageToVenice);
    convo.push({ role: 'user', content: buildPrompt(topic) });

    // Wrap the registered conversation_search ToolDef as an AgentTool.
    // The function-side conversation_search already excludes the
    // current thread unconditionally, so we don't need to pass a flag.
    const recallSearch: AgentTool = {
      name: 'conversation_search',
      wire: CONVERSATION_SEARCH_WIRE_SCHEMA,
      async execute(args, agentCtx) {
        return await conversationSearch.execute(args, {
          adminClient: agentCtx.adminClient,
          userId: agentCtx.userId,
          threadId: agentCtx.threadId,
          signal: agentCtx.signal,
          depth: agentCtx.depth,
        });
      },
    };

    const toolbox: Toolbox = {
      name: 'conversationRecall',
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
        model: CONVERSATION_RECALL_MODEL,
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
      `conversation recall finished (${result.toolCalls} tool call(s), outcome=${note.kind})`,
    );
    return note;
  } catch (err) {
    // Logging only - the failure still propagates to the tool
    // dispatcher unchanged; this line is the drawer-visible reason.
    log.error(
      'conversation recall failed',
      err instanceof Error ? err : new Error(String(err)),
    );
    throw err;
  } finally {
    await log.flush();
  }
}

export const conversationRecall: ToolDef = {
  name: 'conversation_recall',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const topic = typeof args.topic === 'string' ? args.topic : '';
    return await runConversationRecall(ctx, topic);
  },
};

registerTool(conversationRecall);

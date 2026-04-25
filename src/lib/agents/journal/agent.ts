/**
 * Journaling agent for the Journal feature. One run = one pass over
 * a completed conversation: fetch the thread's messages up to the
 * claimed terminal assistant message, read today's existing automatic
 * entry (so the prompt can tell the agent to extend rather than
 * duplicate), call Venice with `response_format: {type:'json_object'}`,
 * parse the model's structured decision, and - when `worthy=true` -
 * write the entry AND advance the thread's `last_journaled_msg_id`
 * pointer in a single atomic Postgres transaction via
 * `supabase.upsertJournalEntryAndMarkThread`. The atomicity matters:
 * a successful entry write that fails to advance the pointer would
 * loop the worker on the same conversation; a pointer advance
 * without a successful entry write would orphan it.
 *
 * Mirrors `../reflection/agent.ts` in the thread-fetch / slice / model
 * pinning pieces but diverges in three ways:
 *
 *   - Model + reasoning: runs on `nvidia-nemotron-cascade-2-30b-a3b`
 *     with reasoning_effort='medium'. Cheap, fast, 256k context, and
 *     it supports function calling + reasoning, which is the slot
 *     this background agent actually needs (no vision, no streaming
 *     UX). Pinned to a literal id rather than tracking a tier so a
 *     swap of the user-facing `balanced` profile doesn't perturb the
 *     journaler. Earlier the task was on the balanced profile (GLM-5)
 *     and overload errors started showing up in the journal logs,
 *     and a low-traffic-tier model is a better fit for "every settled
 *     thread, in order, in the background" anyway.
 *
 *   - Output: structured JSON via response_format, not a tool call.
 *     The earlier tool-call shape ran the entry's Markdown body
 *     through two layers of JSON escaping (the outer streamed
 *     `arguments` string, then the inner content field) and lost
 *     escaping on roughly any conversation longer than a paragraph.
 *     `wrote=true, 0 successful tool calls` runs were the visible
 *     symptom; the silent failure was that the local JSON.parse on
 *     the assembled arguments string would throw, the worker would
 *     log "wrote=false" anyway because successfulToolCalls stayed at
 *     zero, and the user got an empty journal. response_format only
 *     produces one layer of JSON, which is the failure mode the
 *     model is actually trained on.
 *
 *   - No tool calls means no toolbox. The agent talks to Venice
 *     directly via `streamChat` and writes through the supabase
 *     service from inside this file. Reasoning the model wrote about
 *     its decision is plumbed up to the worker so the log line can
 *     show the why alongside the what.
 *
 * Does NOT touch leases, claims, or the thread-marking RPC - those
 * live in `./loop.ts` and `./worker.ts`. This class is pure logic.
 */
import type { Agent, AgentRunRequest, AgentRunResult } from '../types';
import type { SupabaseService, Message } from '../../supabase';
import type { VeniceClient, VeniceMessage, ResponseFormat } from '../../venice';
import { createLogger } from '../../logger.svelte';
import { sanitizeToolCallsForWire } from '../../tools/wire';
import type { ReasoningEffort } from '../../models';
import { buildJournalPrompt } from './prompt';
import {
  renderSpamHint,
  scoreSpamFilter,
  tokenizeConversation,
} from './spam_filter';
import {
  MAX_JOURNAL_CONTENT_CHARS,
  type JournalInput,
  type JournalOutput,
} from './types';

// Log under the same source as `loop.ts` so a Logs-drawer filter for
// "journal-worker" picks up everything from this pipeline - the
// loop's lifecycle lines and the agent's mid-cycle progress notes.
const log = createLogger('journal-worker');

/**
 * Model the journaling agent runs against. Literal id rather than a
 * tier reference: the journal worker is a "every settled thread, in
 * order, in the background" load and wants its own low-traffic slot
 * so foreground turns on the user-facing `balanced` profile don't
 * compete with the background queue for capacity. Nemotron Cascade
 * 2 30b-a3b is cheap, has a 256k context (comfortable headroom for
 * long threads + the existing-entry priming block), and supports
 * function calling + reasoning - everything the journaler exercises.
 * No vision, which is fine; threads are text-only at this layer.
 *
 * Pin to a string. If a future swap is wanted, change it here; the
 * worker reads the value through the start-message plumbing in
 * `manager.ts`.
 */
export const VENICE_JOURNAL_MODEL = 'nvidia-nemotron-cascade-2-30b-a3b';

/**
 * Reasoning effort sent alongside the balanced-tier model. `medium` is
 * the intended band for this task - `low` produced flattened entries
 * that missed the user's reframings mid-conversation; `high` added
 * latency without a visible quality gain.
 */
export const JOURNAL_REASONING_EFFORT: ReasoningEffort = 'medium';

/**
 * Pin response_format=json_object on every run. The prompt also re-
 * asserts the schema in prose; both layers earn their place because
 * the wire-level pin removes "model returned a paragraph of prose
 * instead of JSON" as a failure mode, while the prose schema removes
 * "model returned valid JSON of the wrong shape" as a failure mode.
 */
const JOURNAL_RESPONSE_FORMAT: ResponseFormat = { type: 'json_object' };

function messageToVenice(m: Message): VeniceMessage {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      content: m.content,
      tool_call_id: m.tool_call_id ?? undefined,
      name: m.name ?? undefined,
    };
  }
  const out: VeniceMessage = { role: m.role, content: m.content };
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
    // Sanitise the arguments JSON before it goes back on the wire. A
    // malformed arguments string from a previous round (e.g. unescaped
    // quotes inside the model-written `activity` sentence) is what
    // surfaces as the Venice 400 "Expecting ',' delimiter" error - and
    // it rides every replay until the row drops out of history. See
    // src/lib/tools/wire.ts for the full rationale.
    out.tool_calls = sanitizeToolCallsForWire(m.tool_calls);
  }
  return out;
}

/**
 * Parsed shape the agent expects out of the model. `worthy=false`
 * runs omit `entry`; `worthy=true` runs must include at least
 * `entry.content`. All optional fields default to empty / null in
 * the writer below.
 */
interface JournalDecision {
  worthy: boolean;
  reasoning: string;
  entry: {
    content: string;
    topics: string[];
    mood: string | null;
    people: string[];
  } | null;
}

/**
 * Parse the model's final-text JSON into a structured decision, or
 * null when the payload is unrecoverable. Tolerant of a markdown
 * `json fence wrapping the body - a lot of training data has the
 * fence even when response_format=json_object is set, and stripping
 * it is cheaper than re-prompting.
 *
 * Validates `worthy` and `reasoning` strictly because they're always
 * required. `entry` is validated only when worthy is true; an entry
 * payload on a worthy=false run is dropped silently rather than
 * raised - the caller's contract is "skip when worthy=false", and a
 * stray entry field would otherwise turn a clean skip into an
 * unintended write.
 *
 * Empty or stray content (whitespace-only) on a worthy=true run
 * downgrades to worthy=false with a synthesized reasoning. The
 * upsert RPC would otherwise fail on the empty-body check and the
 * worker would re-run the same thread next cycle.
 */
export function parseJournalDecision(text: string): JournalDecision | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  // Strip a ```json … ``` or ``` … ``` wrapper if the model added one.
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const payload = fence ? fence[1] : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.worthy !== 'boolean') return null;
  const reasoning =
    typeof obj.reasoning === 'string' ? obj.reasoning.trim() : '';
  if (reasoning.length === 0) return null;
  if (!obj.worthy) {
    return { worthy: false, reasoning, entry: null };
  }
  // worthy=true path - extract entry, fall back to worthy=false when
  // the entry is missing or empty rather than failing the whole run.
  const entryRaw = obj.entry;
  if (!entryRaw || typeof entryRaw !== 'object') {
    return {
      worthy: false,
      reasoning: `${reasoning} (worthy=true but entry missing - downgraded to skip)`,
      entry: null,
    };
  }
  const entryObj = entryRaw as Record<string, unknown>;
  const content =
    typeof entryObj.content === 'string' ? entryObj.content.trim() : '';
  if (content.length === 0) {
    return {
      worthy: false,
      reasoning: `${reasoning} (worthy=true but entry.content empty - downgraded to skip)`,
      entry: null,
    };
  }
  const topics = Array.isArray(entryObj.topics)
    ? (entryObj.topics as unknown[]).filter(
        (t): t is string => typeof t === 'string' && t.length > 0
      )
    : [];
  const people = Array.isArray(entryObj.people)
    ? (entryObj.people as unknown[]).filter(
        (p): p is string => typeof p === 'string' && p.length > 0
      )
    : [];
  const mood =
    typeof entryObj.mood === 'string' && entryObj.mood.trim().length > 0
      ? entryObj.mood.trim()
      : null;
  // Cap content length defensively. The schema's MAX_JOURNAL_CONTENT_CHARS
  // matches the embeddings worker's clamp, so a body that fits here also
  // fits the vector pass.
  const trimmedContent =
    content.length > MAX_JOURNAL_CONTENT_CHARS
      ? content.slice(0, MAX_JOURNAL_CONTENT_CHARS)
      : content;
  return {
    worthy: true,
    reasoning,
    entry: {
      content: trimmedContent,
      topics,
      mood,
      people,
    },
  };
}

export class JournalAgent implements Agent<JournalInput, JournalOutput> {
  readonly name = 'journal';
  readonly model: string;
  // No tools - the agent decides + writes through structured output
  // and a direct supabase call. Empty toolbox satisfies the
  // `Agent<I,O>` contract; consumers that walk an agent's toolbox
  // treat an empty `tools` array as "nothing to register".
  readonly toolbox = {
    name: 'journal-agent',
    description:
      'Empty toolbox - the journaling agent uses response_format=json_object instead of tool calls.',
    tools: [],
  };

  constructor(
    private venice: VeniceClient,
    private supabase: SupabaseService,
    /**
     * Optional override. Defaults to `VENICE_JOURNAL_MODEL`
     * (nvidia-nemotron-cascade-2-30b-a3b). Useful for tests and for a
     * future A/B where two journaling models run against historical
     * threads.
     */
    modelId?: string
  ) {
    this.model = modelId ?? VENICE_JOURNAL_MODEL;
  }

  async run(
    req: AgentRunRequest<JournalInput>
  ): Promise<AgentRunResult<JournalOutput>> {
    const signal = req.signal ?? new AbortController().signal;

    if (signal.aborted) {
      return {
        output: {
          finalText: '',
          inputMessageCount: 0,
          entryWritten: false,
          reasoning: null,
        },
        toolCalls: 0,
        stoppedReason: 'aborted',
      };
    }

    try {
      // Fetch the full thread and slice at the terminal message we
      // claimed against.
      const allMessages = await this.supabase.listMessages(req.input.threadId);
      const terminalIdx = allMessages.findIndex(
        (m) => m.id === req.input.terminalMsgId
      );
      const slice =
        terminalIdx >= 0 ? allMessages.slice(0, terminalIdx + 1) : allMessages;

      if (slice.length === 0) {
        return {
          output: {
            finalText: '',
            inputMessageCount: 0,
            entryWritten: false,
            reasoning: null,
          },
          toolCalls: 0,
          stoppedReason: 'done',
        };
      }

      // The automatic entry the worker has previously written for THIS
      // thread, if any. Looked up by thread_id (not date) so a worker
      // re-run on the same thread - because the user added more turns
      // - extends the same entry rather than competing with another
      // thread's entry that happens to share a date. A Supabase
      // failure here degrades to "no existing entry"; the on-conflict
      // path of the upsert RPC will still merge the agent's output
      // into whatever's stored.
      let existingEntry = null as
        | {
            content: string;
            topics: readonly string[];
            mood: string | null;
            people: readonly string[];
          }
        | null;
      try {
        const automatic = await this.supabase.getJournalEntryForThread(
          req.input.threadId
        );
        if (automatic) {
          existingEntry = {
            content: automatic.content,
            topics: automatic.topics,
            mood: automatic.mood,
            people: automatic.people,
          };
        }
      } catch {
        existingEntry = null;
      }

      // Spam-filter prior. Score the conversation against the user's
      // ham/spam history; render as a natural-language hint when out
      // of cold-start, otherwise null. Best-effort: a scoring failure
      // (network blip, RPC error, missing stats row) just suppresses
      // the hint - the LLM falls back to its built-in worthy/not-worthy
      // judgment without the prior nudging it. We don't log the
      // failure on every cycle because a transient error should not
      // generate sustained log noise.
      let spamHint: string | null = null;
      try {
        const tokens = tokenizeConversation(slice);
        const score = await scoreSpamFilter(this.supabase, tokens);
        spamHint = renderSpamHint(score);
      } catch {
        spamHint = null;
      }

      const convo: VeniceMessage[] = slice.map(messageToVenice);
      convo.push({
        role: 'user',
        content: buildJournalPrompt({
          entryDate: req.input.entryDate,
          existingEntry,
          threadId: req.input.threadId,
          spamHint,
        }),
      });

      // Mid-cycle progress note. The Venice call below can take tens
      // of seconds on a long thread + medium reasoning effort, and
      // without a log line between "picked up thread X" and "finished
      // thread X" the worker looks frozen to anyone scanning the
      // logs. The note also surfaces "Venice itself is unreachable"
      // separately from "agent reasoned through a skip" - if the
      // reachable-Venice line lands but the finished-thread line
      // never does, the streamChat call hung.
      log.info(
        `asking model about thread ${req.input.threadId} ` +
          `(${slice.length} messages, ${existingEntry ? 'extending prior entry' : 'first pass'})`
      );

      // Single streaming call. No tool loop - structured output makes
      // the round-trip a one-shot. Drain text events into finalText;
      // ignore reasoning / usage / citations.
      let finalText = '';
      const stream = this.venice.streamChat({
        model: this.model,
        messages: convo,
        responseFormat: JOURNAL_RESPONSE_FORMAT,
        reasoningEffort: JOURNAL_REASONING_EFFORT,
        signal,
      });
      for await (const ev of stream) {
        if (ev.type === 'text') finalText += ev.delta;
      }

      if (signal.aborted) {
        return {
          output: {
            finalText,
            inputMessageCount: slice.length,
            entryWritten: false,
            reasoning: null,
          },
          toolCalls: 0,
          stoppedReason: 'aborted',
        };
      }

      const decision = parseJournalDecision(finalText);
      if (decision === null) {
        // Parse failure - log the raw final text via the loop's error
        // path (it falls back to finalText when reasoning is null).
        // Pointer still advances; a re-prompt would just re-fail.
        return {
          output: {
            finalText,
            inputMessageCount: slice.length,
            entryWritten: false,
            reasoning: null,
          },
          toolCalls: 0,
          stoppedReason: 'done',
        };
      }

      if (!decision.worthy || decision.entry === null) {
        return {
          output: {
            finalText,
            inputMessageCount: slice.length,
            entryWritten: false,
            reasoning: decision.reasoning,
          },
          toolCalls: 0,
          stoppedReason: 'done',
        };
      }

      // Mid-cycle progress note for the write path. Same rationale
      // as the "asking model" line above - if the atomic upsert hangs
      // or fails, the user can see the write was attempted and which
      // thread it was for without having to stare at a silent gap.
      log.info(
        `writing entry for thread ${req.input.threadId} ` +
          `(${decision.entry.content.length} chars)`
      );

      // Worthy + entry present: write through the atomic upsert+mark
      // RPC. The schema function does both the entry upsert and the
      // thread's pointer-advance in one Postgres transaction - so an
      // entry only exists when the pointer also advanced, and a
      // claim-lost during the mark step rolls the upsert back. The
      // worker won't end up with an orphan row whose claim has
      // expired and which a re-run would just overwrite.
      try {
        await this.supabase.upsertJournalEntryAndMarkThread({
          threadId: req.input.threadId,
          holderId: req.input.holderId,
          msgId: req.input.terminalMsgId,
          entryDate: req.input.entryDate,
          content: decision.entry.content,
          topics: decision.entry.topics,
          mood: decision.entry.mood,
          people: decision.entry.people,
        });
      } catch (err) {
        // Surface the failure as the run error so the loop logs it
        // and DOES NOT call its own mark step. Whether the failure
        // came from the upsert (predicate mismatch, RLS) or the
        // mark (claim lost, raised inside the function), the schema
        // transaction has rolled BOTH halves back - there's nothing
        // for the loop to compensate for.
        return {
          output: {
            finalText,
            inputMessageCount: slice.length,
            entryWritten: false,
            reasoning: decision.reasoning,
          },
          toolCalls: 0,
          stoppedReason: 'error',
          error: err instanceof Error ? err.message : String(err),
        };
      }

      return {
        output: {
          finalText,
          inputMessageCount: slice.length,
          entryWritten: true,
          reasoning: decision.reasoning,
        },
        toolCalls: 0,
        stoppedReason: 'done',
      };
    } catch (err) {
      return {
        output: {
          finalText: '',
          inputMessageCount: 0,
          entryWritten: false,
          reasoning: null,
        },
        toolCalls: 0,
        stoppedReason: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

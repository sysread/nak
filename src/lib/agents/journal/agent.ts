/**
 * Journaling agent for the Journal feature. One run = one pass over
 * a completed conversation: fetch the thread's messages up to the
 * claimed terminal assistant message, read today's existing automatic
 * entry (so the prompt can tell the agent to extend rather than
 * duplicate), drive a tool-call loop with read-only memory and
 * conversation searches, parse the model's structured decision, and -
 * when `worthy=true` - write the entry AND advance the thread's
 * `last_journaled_msg_id` pointer in a single atomic Postgres
 * transaction via `supabase.upsertJournalEntryAndMarkThread`. The
 * atomicity matters: a successful entry write that fails to advance
 * the pointer would loop the worker on the same conversation; a
 * pointer advance without a successful entry write would orphan it.
 *
 * Mirrors `../reflection/agent.ts` in the thread-fetch / slice / model
 * pinning pieces but diverges in three ways:
 *
 *   - Model + reasoning: runs on `zai-org-glm-4.7-flash` with
 *     `disable_thinking=true` and no `reasoning_effort`. Supports
 *     function calling, which is the slot this background agent
 *     actually needs (no vision, no streaming UX). Pinned to a
 *     literal id rather than tracking a tier so a swap of the user-
 *     facing tiers doesn't perturb the journaler. History: the task
 *     started on the balanced profile (GLM-5) and hit overload
 *     errors, then moved to `nvidia-nemotron-cascade-2-30b-a3b` for
 *     the low-traffic-slot property, which produced visibly weak
 *     entries. The `-flash` variant of GLM-4.7 is roughly a third
 *     the price of the plain `zai-org-glm-4.7` that fronts the
 *     user-facing Fast tier, so it's plausibly a separate slot.
 *     Thinking is disabled outright via Venice's
 *     `venice_parameters.disable_thinking` kill switch: the task is
 *     "read the conversation, emit a structured JSON entry," and
 *     CoT preambles on a reasoning-capable model just burned the
 *     output budget without changing the entry quality. If overload
 *     errors return, the next move is back to a non-user-fronted
 *     id, not back to the Fast tier proper.
 *
 *   - Output: structured JSON via response_format, not a tool call.
 *     The earlier "write the entry through tool_call.arguments" shape
 *     ran the Markdown body through two layers of JSON escaping (the
 *     outer streamed `arguments` string, then the inner content
 *     field) and lost escaping on roughly any conversation longer
 *     than a paragraph. `wrote=true, 0 successful tool calls` runs
 *     were the visible symptom; the silent failure was that the local
 *     JSON.parse on the assembled arguments string would throw, the
 *     worker would log "wrote=false" anyway because
 *     successfulToolCalls stayed at zero, and the user got an empty
 *     journal. response_format only produces one layer of JSON, which
 *     is the failure mode the model is actually trained on. The
 *     tool-call rounds the agent now uses for INPUT (memory_search /
 *     conversation_search) don't suffer from this - their arguments
 *     are short query strings, not multi-paragraph Markdown.
 *
 *   - Read-only toolbox (`journalAgentToolbox`): `memory_search` and
 *     `conversation_search` only. Lets the agent pull in adjacent
 *     context (saved memories about a recurring theme, prior threads
 *     the user is implicitly referring back to) without giving it any
 *     ability to mutate user state. The toolCtx's `threadId` is set
 *     to `req.input.threadId` - the conversation BEING JOURNALED, not
 *     whatever thread the user has open in the UI - so
 *     `conversation_search`'s default current-thread exclusion keeps
 *     the agent from pulling its own source conversation back in.
 *     Reasoning the model wrote about its decision is plumbed up to
 *     the worker so the log line can show the why alongside the what.
 *
 * Does NOT touch leases, claims, or the thread-marking RPC - those
 * live in `./loop.ts` and `./worker.ts`. This class is pure logic.
 */
import type { Agent, AgentRunRequest, AgentRunResult } from '../types';
import type { SupabaseService, Message } from '../../supabase';
import type { VeniceClient, VeniceMessage, ResponseFormat } from '../../venice';
import { createLogger } from '../../logger.svelte';
import { sanitizeToolCallIdForWire, sanitizeToolCallsForWire } from '../../tools/wire';
import { runHeadlessToolLoop } from '../../tools/run';
import { journalAgentToolbox } from '../../tools/journal_agent_toolbox';
import {
  buildJournalPrompt,
  buildJournalRegeneratePrompt,
  type JournalUserProfile,
} from './prompt';
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
 * order, in the background" load and wants insulation from user-facing
 * tier swaps. `zai-org-glm-4.7-flash` is the current pick - supports
 * function calling + reasoning, and at roughly a third the price of
 * the plain `zai-org-glm-4.7` (which fronts the Fast tier) it's
 * plausibly served from a different capacity pool, which matters
 * because the journaler walks every settled thread in order in the
 * background and shouldn't fight foreground turns for capacity. No
 * vision, which is fine; threads are text-only at this layer.
 *
 * Predecessors and why they were dropped: the balanced profile (GLM-5)
 * hit overload errors under the background load; `nvidia-nemotron-
 * cascade-2-30b-a3b` had the low-traffic property but produced visibly
 * weak entries. If `-flash` also overloads, the next move is to find
 * another non-user-fronted id rather than retarget to the Fast tier
 * proper - that would put the journaler in direct contention with
 * foreground Fast-tier traffic.
 *
 * Pin to a string. If a future swap is wanted, change it here; the
 * worker reads the value through the start-message plumbing in
 * `manager.ts`.
 */
export const VENICE_JOURNAL_MODEL = 'zai-org-glm-4.7-flash';

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
      tool_call_id:
        m.tool_call_id != null
          ? sanitizeToolCallIdForWire(m.tool_call_id)
          : undefined,
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
  // Read-only memory + conversation search. The entry itself is still
  // emitted through `response_format=json_object` in the model's final
  // text - tool calls happen only during input-gathering rounds, so
  // the multi-layer JSON-escaping problem the original tool-call write
  // shape suffered from doesn't apply here.
  readonly toolbox = journalAgentToolbox;
  /**
   * Mutable user profile (Settings -> AI -> About you). Read on every
   * `run()` / `regenerate()` so the worker can live-update it via
   * `setUserProfile` without a restart - mirrors the worker's tzHolder
   * pattern. Both fields default to null and are updated by the worker
   * from its StartMessage and any subsequent profile postMessages.
   */
  private userProfile: JournalUserProfile | null = null;

  constructor(
    private venice: VeniceClient,
    private supabase: SupabaseService,
    /**
     * Optional override. Defaults to `VENICE_JOURNAL_MODEL`
     * (`zai-org-glm-4.7-flash`). Useful for tests and for a future
     * A/B where two journaling models run against historical threads.
     */
    modelId?: string,
    /**
     * Initial user profile. The worker passes this from its
     * StartMessage; the regenerate caller passes the values it just
     * read off `app.userName` / `app.userLocation`. Null (or both
     * fields empty) keeps the prompt's "About the user" block off.
     */
    userProfile?: JournalUserProfile | null
  ) {
    this.model = modelId ?? VENICE_JOURNAL_MODEL;
    this.userProfile = userProfile ?? null;
  }

  /**
   * Live-update the profile fields. Called by the worker on a
   * `{type:'profile'}` postMessage so the user editing their name or
   * location in Settings reaches the next cycle without a restart.
   */
  setUserProfile(profile: JournalUserProfile | null): void {
    this.userProfile = profile;
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
          userProfile: this.userProfile,
        }),
      });

      // Mid-cycle progress note. The Venice call below can take tens
      // of seconds on a long thread + medium reasoning effort, and
      // without a log line between "picked up thread X" and "finished
      // thread X" the worker looks frozen to anyone scanning the
      // logs. The note also surfaces "Venice itself is unreachable"
      // separately from "agent reasoned through a skip" - if the
      // reachable-Venice line lands but the finished-thread line
      // never does, the tool-loop hung.
      log.info(
        `asking model about thread ${req.input.threadId} ` +
          `(${slice.length} messages, ${existingEntry ? 'extending prior entry' : 'first pass'})`
      );

      // Tool loop with the read-only journalAgentToolbox. The model
      // can call memory_search and conversation_search across rounds
      // to gather context, then settles on a JSON-formatted final
      // text (response_format pinned on every round). toolCtx.threadId
      // is the thread BEING JOURNALED so conversation_search's default
      // current-thread filter excludes the agent's own source convo.
      const loopResult = await runHeadlessToolLoop({
        venice: this.venice,
        model: this.model,
        messages: convo,
        toolbox: this.toolbox,
        toolCtx: {
          supabase: this.supabase,
          venice: this.venice,
          userId: req.userId,
          threadId: req.input.threadId,
        },
        signal,
        responseFormat: JOURNAL_RESPONSE_FORMAT,
        disableThinking: true,
      });
      const finalText = loopResult.finalText;

      if (signal.aborted) {
        return {
          output: {
            finalText,
            inputMessageCount: slice.length,
            entryWritten: false,
            reasoning: null,
          },
          toolCalls: loopResult.toolCalls,
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
          toolCalls: loopResult.toolCalls,
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
          toolCalls: loopResult.toolCalls,
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
          toolCalls: loopResult.toolCalls,
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
        toolCalls: loopResult.toolCalls,
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

  /**
   * User-initiated regenerate of an existing automatic entry. Runs
   * outside the worker queue: no claim, no lease, no pointer
   * advance. Bypasses the worthy/not-worthy gate and the spam-filter
   * prior because the user has explicitly asked for an entry. Does
   * NOT write to the database - the caller previews the result and
   * either accepts (and persists via updateJournalEntry) or
   * discards.
   *
   * Uses the full thread history rather than the slice up to the
   * original entry's terminal message - the user might be
   * regenerating because newer turns added context worth covering,
   * and the entry's existing entry_date is already pinned to the
   * conversation-start day so the entry won't drift onto the wrong
   * calendar bucket.
   *
   * Throws on any failure (parse error, model returning worthy=false
   * despite the regenerate prompt, abort, network error). The caller
   * surfaces the error inline so the user can retry or cancel.
   */
  async regenerate(args: {
    threadId: string;
    entryDate: string;
    existingEntry: {
      content: string;
      topics: readonly string[];
      mood: string | null;
      people: readonly string[];
    };
    signal?: AbortSignal;
  }): Promise<{
    content: string;
    topics: string[];
    mood: string | null;
    people: string[];
  }> {
    const signal = args.signal ?? new AbortController().signal;
    if (signal.aborted) throw new Error('Regenerate aborted before start.');

    const allMessages = await this.supabase.listMessages(args.threadId);
    if (allMessages.length === 0) {
      throw new Error('Source conversation has no messages to journal.');
    }

    const convo: VeniceMessage[] = allMessages.map(messageToVenice);
    convo.push({
      role: 'user',
      content: buildJournalRegeneratePrompt({
        entryDate: args.entryDate,
        existingEntry: args.existingEntry,
        userProfile: this.userProfile,
      }),
    });

    log.info(
      `regenerating entry for thread ${args.threadId} ` +
        `(${allMessages.length} messages)`
    );

    // Resolve the signed-in user's id from the supabase client. The
    // tools we hand the loop (memory_search, conversation_search) get
    // user-scoping via the JWT on `ctx.supabase` and don't read
    // `ctx.userId`, but the ToolContext contract requires it; surfacing
    // the session error here is preferable to handing the loop an empty
    // string and discovering it later through an RLS failure deeper in.
    const session = await this.supabase.getSession();
    if (!session) {
      throw new Error('Not signed in - cannot regenerate.');
    }

    // Same tool loop as the worker run() path - read-only memory and
    // conversation search, structured JSON output. ctx.threadId is the
    // thread the entry is FOR, so conversation_search excludes the
    // source conversation by default.
    const loopResult = await runHeadlessToolLoop({
      venice: this.venice,
      model: this.model,
      messages: convo,
      toolbox: this.toolbox,
      toolCtx: {
        supabase: this.supabase,
        venice: this.venice,
        userId: session.user.id,
        threadId: args.threadId,
      },
      signal,
      responseFormat: JOURNAL_RESPONSE_FORMAT,
      disableThinking: true,
    });
    const finalText = loopResult.finalText;

    if (signal.aborted) throw new Error('Regenerate aborted mid-stream.');

    const decision = parseJournalDecision(finalText);
    if (decision === null) {
      throw new Error(
        'The model returned a response we couldn\'t parse. Try again.'
      );
    }
    // The regenerate prompt forces worthy=true; if the model still
    // returned worthy=false (or downgraded for an empty entry) the
    // payload is unusable. Surface the model's reasoning so the user
    // sees why and can decide whether to retry.
    if (!decision.worthy || decision.entry === null) {
      throw new Error(
        `The model declined to regenerate: ${decision.reasoning}`
      );
    }
    return {
      content: decision.entry.content,
      topics: [...decision.entry.topics],
      mood: decision.entry.mood,
      people: [...decision.entry.people],
    };
  }
}

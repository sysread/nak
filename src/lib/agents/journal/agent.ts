/**
 * Journaling agent for the Journal feature. One run = one pass over
 * a completed conversation: fetch the thread's messages up to the
 * claimed terminal assistant message, read today's existing automatic
 * entry (so the prompt can tell the agent to extend rather than
 * duplicate), prepend the cached context-recall note (or run the
 * recall pipeline fresh on a cold cache), make a single completion
 * call, parse the model's structured decision, and - when
 * `worthy=true` - write the entry AND advance the thread's
 * `last_journaled_msg_id` pointer in a single atomic Postgres
 * transaction via `supabase.upsertJournalEntryAndMarkThread`. The
 * atomicity matters: a successful entry write that fails to advance
 * the pointer would loop the worker on the same conversation; a
 * pointer advance without a successful entry write would orphan it.
 *
 * Mirrors `../reflection/agent.ts` in the thread-fetch / slice / model
 * pinning pieces but diverges in three ways:
 *
 *   - Model + thinking: runs on `minimax-m25` with
 *     `disable_thinking=true` and no `reasoning_effort`. The agent
 *     does NOT call function tools (see "Context" below), so a
 *     non-function-calling model is fine. Pinned to a literal id
 *     rather than tracking a tier so a swap of the user-facing
 *     tiers doesn't perturb the journaler. History:
 *       (1) Started on the balanced profile (GLM-5) and hit
 *           overload errors - foreground tier sharing capacity.
 *       (2) Moved to `nvidia-nemotron-cascade-2-30b-a3b` for the
 *           low-traffic-slot property; entries came out weak, but
 *           the agent at the time was running a tool loop with
 *           `reasoning_effort: 'medium'` so the failure mode could
 *           plausibly have been small-model tool fumbling rather
 *           than baseline writing quality.
 *       (3) Moved to `zai-org-glm-4.7-flash` (a presumed-separate
 *           capacity-pool variant of the Fast tier id at ~1/3 the
 *           price); also overloaded, suggesting it shares capacity
 *           with the Fast tier in practice.
 *       (4) Briefly re-pinned nemotron under the no-tools,
 *           no-thinking shape, then jumped to minimax without
 *           letting the second nemotron run gather data - the
 *           upside of "maybe weak entries were a tool-loop
 *           artifact" wasn't worth the downside if the model is
 *           just baseline weak.
 *       (5) Trying `minimax-m25`. Same family as `minimax-m27`
 *           that previously fronted the Balanced tier, but a
 *           different id - plausibly a different capacity pool.
 *     Thinking is disabled outright via Venice's
 *     `venice_parameters.disable_thinking` kill switch: the task
 *     is "read the conversation, emit a structured JSON entry,"
 *     and CoT preambles on a reasoning-capable model just burned
 *     the output budget without changing the entry quality.
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
 *     is the failure mode the model is actually trained on.
 *
 *   - Context: the journal agent does NOT expose memory_search /
 *     conversation_search as function tools. Instead it consumes the
 *     context-recall pipeline's stitched first-person note - the same
 *     pipeline the chat-loop uses (`src/lib/context-recall/`) - and
 *     prepends it as a synthetic <think> assistant turn between the
 *     conversation slice and the journal prompt. The cache lives on
 *     the threads row's `context_recall_payload` jsonb column and is
 *     populated by the chat-loop during the user's session; the claim
 *     RPC projects it on the claim row so we don't pay an extra round
 *     trip. On a cold cache (a thread the user opened briefly without
 *     triggering a recall refresh, or one that pre-dates the
 *     pipeline) the agent fans out the recall pipeline fresh and
 *     writes the result back so the next chat turn benefits. Two
 *     consequences worth noting: the journal agent's model can be
 *     non-function-calling, but the recall sub-agents themselves
 *     still call tools - we've moved function calling down a layer,
 *     not eliminated it from the system. And there's no
 *     `conversation_search`-style "exclude the current thread"
 *     filter on the recall path, since the pipeline reads the live
 *     thread already; the stitched note is about adjacent context,
 *     not the source conversation.
 *
 * Does NOT touch leases, claims, or the thread-marking RPC - those
 * live in `./loop.ts` and `./worker.ts`. This class is pure logic.
 */
import type { Agent, AgentRunRequest, AgentRunResult } from '../types';
import type { SupabaseService, Message } from '../../supabase';
import type { VeniceClient, VeniceMessage, ResponseFormat } from '../../venice';
import type { Toolbox } from '../../tools/types';
import { createLogger } from '../../logger.svelte';
import { sanitizeToolCallIdForWire, sanitizeToolCallsForWire } from '../../tools/wire';
import {
  buildContextRecallThinkMessage,
  coerceContextRecallPayload,
  runContextRecallPipeline,
  withContextRecallInflight,
  writeContextRecallCache,
  type ContextRecallPayload,
} from '../../context-recall';
import { countUserRounds } from '../../intuition/types';
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
 * tier swaps. `minimax-m25` is the current pick - a non-Z.ai, non-
 * NVIDIA family the journaler hasn't tried yet, sized for prose +
 * structured-JSON output without function-calling. minimax-m27
 * fronted the Balanced tier earlier (now in
 * RETIRED_MODEL_CONTEXT_WINDOWS in src/lib/models.ts), so the family
 * is on Venice; m25 is an older / cheaper variant from the same
 * lineage and it's plausibly served from yet another capacity pool
 * given how aggressively Venice rotates the foreground tier ids.
 *
 * Predecessors and why they were dropped:
 *   - The balanced profile (GLM-5) hit overload errors - foreground
 *     tier sharing capacity.
 *   - `nvidia-nemotron-cascade-2-30b-a3b` was tried twice. First
 *     pass produced visibly weak entries, but the agent at the time
 *     was carrying a tool loop with `reasoning_effort: 'medium'`,
 *     so the failure mode could plausibly have been the small model
 *     fumbling tool dispatch. We pinned it again under the
 *     no-tools, no-thinking shape and didn't get to test it -
 *     putting back a model whose only known data point is "weak"
 *     wasn't worth the cycle.
 *   - `zai-org-glm-4.7-flash` overloaded under the background load,
 *     suggesting it shares capacity with the Fast tier in practice
 *     despite the lower price.
 *
 * If overload returns on minimax, the next move is yet another
 * non-user-fronted id - the journaler walking every settled thread
 * in order in the background should never fight foreground turns for
 * capacity. Don't fall back to Smart / Balanced / Fast tier ids.
 *
 * Pin to a string. If a future swap is wanted, change it here; the
 * worker reads the value through the start-message plumbing in
 * `manager.ts`.
 */
export const VENICE_JOURNAL_MODEL = 'minimax-m25';

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
  // No-op toolbox. The Agent interface requires a `toolbox` field, but
  // the journal agent doesn't expose memory_search / conversation_search
  // any more - cross-conversation context arrives via a context-recall
  // <think> message synthesized from the same pipeline the chat-loop
  // uses, prepended at the start of the run rather than fetched through
  // mid-call tool rounds. Kept inline rather than as a separate file
  // since there's nothing to share.
  readonly toolbox: Toolbox = {
    name: 'journal',
    description:
      'No tools. The journal agent consumes a pre-computed context-' +
      'recall note rather than calling memory_search / conversation_' +
      'search itself.',
    tools: [],
  };
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
     * (`minimax-m25`). Useful for tests and for a future A/B where
     * two journaling models run against historical threads.
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

      // Resolve the context-recall <think> message: prefer the cache
      // projected on the claim row, fall back to a fresh pipeline run
      // when the cache is missing or coerces to null. A best-effort
      // write-back on a fresh run feeds the next chat-loop turn the
      // pre-warmed note. Failures are swallowed - the journal entry
      // itself doesn't need the recall to land.
      const recallMessage = await this.resolveContextRecallMessage({
        cachedPayload: req.input.contextRecallPayload,
        threadId: req.input.threadId,
        userId: req.userId,
        round: countUserRounds(slice),
        signal,
        persist: true,
      });

      const convo: VeniceMessage[] = slice.map(messageToVenice);
      if (recallMessage) convo.push(recallMessage);
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
      // of seconds on a long thread, and without a log line between
      // "picked up thread X" and "finished thread X" the worker looks
      // frozen to anyone scanning the logs. The note also surfaces
      // "Venice itself is unreachable" separately from "agent reasoned
      // through a skip" - if the reachable-Venice line lands but the
      // finished-thread line never does, the call hung.
      log.info(
        `asking model about thread ${req.input.threadId} ` +
          `(${slice.length} messages, ${existingEntry ? 'extending prior entry' : 'first pass'}, ` +
          `${recallMessage ? 'with recall note' : 'no recall'})`
      );

      // Single non-streaming completion. The agent has no tools, so
      // there's no headless tool loop - the JSON entry is the model's
      // first and only response, gated by response_format and the
      // disable_thinking kill switch.
      const completion = await this.venice.completeChat({
        model: this.model,
        messages: convo,
        signal,
        responseFormat: JOURNAL_RESPONSE_FORMAT,
        disableThinking: true,
      });
      const finalText = completion.text;

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
        // Parse failure - the loop falls back to finalText when
        // reasoning is null. Pointer still advances; a re-prompt
        // would just re-fail.
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

    // Resolve the signed-in user's id up front. The recall pipeline
    // needs userId for its tool contexts, and surfacing a missing
    // session here is preferable to discovering it deeper in via an
    // RLS failure.
    const session = await this.supabase.getSession();
    if (!session) {
      throw new Error('Not signed in - cannot regenerate.');
    }

    // Regenerate has no claim to ride, so we don't have a cached
    // payload in hand. Fan out the recall pipeline fresh - cost is
    // ~one recall round-trip per Regenerate click, which is fine for
    // a user-initiated action. The result is cached back so the next
    // chat-loop turn benefits.
    const recallMessage = await this.resolveContextRecallMessage({
      cachedPayload: null,
      threadId: args.threadId,
      userId: session.user.id,
      round: countUserRounds(allMessages),
      signal,
      persist: true,
    });

    const convo: VeniceMessage[] = allMessages.map(messageToVenice);
    if (recallMessage) convo.push(recallMessage);
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
        `(${allMessages.length} messages, ` +
        `${recallMessage ? 'with recall note' : 'no recall'})`
    );

    // Single non-streaming completion. Same shape as run() - no tools,
    // structured JSON output, thinking disabled.
    const completion = await this.venice.completeChat({
      model: this.model,
      messages: convo,
      signal,
      responseFormat: JOURNAL_RESPONSE_FORMAT,
      disableThinking: true,
    });
    const finalText = completion.text;

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

  /**
   * Resolve the context-recall <think> message to prepend to the
   * conversation, or null when neither cache nor pipeline yields a
   * non-empty note.
   *
   * Cache-first when a cached payload was passed in (the worker path
   * gets it for free off the claim row). Falls back to running the
   * pipeline fresh when the cache coerces to null OR carries an empty
   * note - an empty-note cache is a legitimate "both children returned
   * the empty signal" state, but for the journal use case we'd rather
   * pay one fresh recall than journal blind. The chat-loop's pure
   * trigger-driven debounce doesn't apply here - we're already running
   * a backgrounded once-per-thread pass, not a per-turn refresh.
   *
   * `persist: true` writes the fresh payload back via
   * `withContextRecallInflight`, so the next chat-loop turn on the
   * same thread sees the pre-warmed note. Best-effort: the journal
   * entry doesn't need the recall write to land, so we swallow the
   * write error and log it.
   *
   * Pipeline failure (network, abort, both children faulting at once)
   * collapses to "no recall note" - the journal proceeds without it
   * rather than failing the whole entry.
   */
  private async resolveContextRecallMessage(args: {
    cachedPayload: unknown;
    threadId: string;
    userId: string;
    round: number;
    signal: AbortSignal;
    persist: boolean;
  }): Promise<VeniceMessage | null> {
    const cached = coerceContextRecallPayload(args.cachedPayload);
    if (cached && cached.note.length > 0) {
      return buildContextRecallThinkMessage(cached);
    }

    let fresh: ContextRecallPayload | null = null;
    try {
      fresh = await withContextRecallInflight(args.threadId, () =>
        runContextRecallPipeline({
          venice: this.venice,
          supabase: this.supabase,
          threadId: args.threadId,
          userId: args.userId,
          signal: args.signal,
          round: args.round,
          // Mood is a chat-loop runtime artifact (intuition's mood-band
          // snapshot for the live conversation). Background journaling
          // doesn't have a live mood; null is the documented "no mood
          // available" path on `RunContextRecallInputs`.
          mood: null,
          // 'cold' is the most honest IntuitionTrigger value here -
          // there's no cache to debounce against. The trigger field
          // rides into the persisted payload for observability only.
          trigger: 'cold',
        })
      );
    } catch (err) {
      log.warn(
        `context-recall pipeline failed for thread ${args.threadId}; ` +
          'journaling without recall note',
        err
      );
      return null;
    }

    if (!fresh) return null;

    if (args.persist) {
      // Best-effort write-back. The chat-loop merges fresher payloads
      // on realtime echo, so a clobber risk against a concurrent chat
      // turn is bounded - the chat-loop's next trigger will refresh
      // again if our write was a step backwards.
      writeContextRecallCache(this.supabase, args.threadId, fresh).catch(
        () => {
          /* logged inside writeContextRecallCache */
        }
      );
    }

    return buildContextRecallThinkMessage(fresh);
  }
}

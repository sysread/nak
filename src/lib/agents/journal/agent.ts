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
 *   - Model + thinking: runs on whichever id `agentModel('journal')`
 *     resolves to (currently deepseek-v4-flash, see AGENT_MODELS in
 *     src/lib/models for the swap point and the full predecessor
 *     list). The wire call pins `reasoning_effort: 'low'` and
 *     `response_format: {type: 'json_object'}`. The agent does NOT
 *     call function tools (see "Context" below), so a non-function-
 *     calling model is fine - but the id MUST accept response_format
 *     because the prose schema in the prompt only covers "right
 *     intent, wrong shape," not "ignored the JSON instruction
 *     entirely."
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
import { agentModel } from '../../models';
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
 * Result shape for `JournalAgent.regenerate`. Discriminated union so
 * the caller (and the UI) can tell "model produced an entry to
 * preview" apart from "model decided the conversation isn't journal
 * material" without sniffing error messages. Genuine errors (parse
 * failure, abort, network) still throw - those are the unrecoverable
 * cases. The decline path returns structured because the user is
 * meant to see the reasoning and choose: try again, or accept the
 * decline and mark the conversation processed.
 */
export type RegenerateResult =
  | {
      kind: 'preview';
      content: string;
      topics: string[];
      mood: string | null;
      people: string[];
    }
  | {
      kind: 'declined';
      reasoning: string;
    };

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
function parseJournalDecision(text: string): JournalDecision | null {
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
     * Optional override. Defaults to the registry's `journal` slot
     * (`agentModel('journal').id`; see AGENT_MODELS in src/lib/models
     * for the swap point and the predecessor list). Useful for tests
     * and for a future A/B where two journaling models run against
     * historical threads.
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
    this.model = modelId ?? agentModel('journal').id;
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
      // first and only response, gated by response_format and a
      // bounded reasoning budget at effort='low'.
      const completion = await this.venice.completeChat({
        model: this.model,
        messages: convo,
        signal,
        responseFormat: JOURNAL_RESPONSE_FORMAT,
        reasoningEffort: 'low',
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
   * advance. The spam-filter prior is suppressed (the user has
   * explicitly asked for an entry). Does NOT write to the database -
   * the caller previews the result and either accepts (and persists
   * via updateJournalEntry) or discards.
   *
   * Prompt shape: regenerate uses the SAME prompt builder as the
   * worker path (`buildJournalPrompt`), called with `existingEntry:
   * null` and `spamHint: null`. There is no separate "you are
   * regenerating, the user wasn't satisfied" framing. Earlier the
   * regenerate path had its own prompt that fed the previous entry
   * back to the model and asked for a different angle; the model
   * grabbed onto the framing and produced fourth-wall meta-lines
   * ("the previous entry treated this as X") that broke the diary
   * voice. The right shape is "two functions, not one function in
   * two states": regenerate is just generation re-run, and
   * variation comes from stochasticity, not from a coupled-state
   * prompt that tries to differ.
   *
   * Uses the full thread history rather than the slice up to the
   * original entry's terminal message - the user might be
   * regenerating because newer turns added context worth covering,
   * and the entry's existing entry_date is already pinned to the
   * conversation-start day so the entry won't drift onto the wrong
   * calendar bucket.
   *
   * Throws on any failure (parse error, model returning worthy=false,
   * abort, network error). The caller surfaces the error inline so
   * the user can retry or cancel.
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
  }): Promise<RegenerateResult> {
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
      // Use the same prompt builder as the worker path. Regenerate
      // isn't a different generation task - it's the same task run
      // again with worthy forced true (the user opted in by clicking
      // the button) and the existing-entry merge branch suppressed
      // (the regenerate write replaces, doesn't extend). Pass
      // existingEntry: null so buildJournalPrompt takes the "no
      // automatic entry exists" branch, and spamHint: null because
      // the spam-filter prior is irrelevant on a path the user has
      // explicitly opted into. The prompt the model sees is
      // structurally identical to the one it sees during a worker
      // run on a fresh thread - no "you previously wrote one" /
      // "the user wasn't satisfied" framing for it to grab onto and
      // produce meta-commentary like "the previous entry framed
      // this as X".
      content: buildJournalPrompt({
        entryDate: args.entryDate,
        existingEntry: null,
        threadId: args.threadId,
        spamHint: null,
        userProfile: this.userProfile,
      }),
    });

    log.info(
      `regenerating entry for thread ${args.threadId} ` +
        `(${allMessages.length} messages, ` +
        `${recallMessage ? 'with recall note' : 'no recall'})`
    );

    // Single non-streaming completion. Same shape as run() - no tools,
    // structured JSON output, reasoning budget at effort='low'.
    const completion = await this.venice.completeChat({
      model: this.model,
      messages: convo,
      signal,
      responseFormat: JOURNAL_RESPONSE_FORMAT,
      reasoningEffort: 'low',
    });
    const finalText = completion.text;

    if (signal.aborted) throw new Error('Regenerate aborted mid-stream.');

    const decision = parseJournalDecision(finalText);
    if (decision === null) {
      throw new Error(
        'The model returned a response we couldn\'t parse. Try again.'
      );
    }
    // Regenerate uses the same prompt as a worker run, so the worthy
    // gate runs normally on this path. worthy=true => the model has
    // produced an entry the caller can preview. worthy=false => the
    // model decided the conversation isn't journal material; this is
    // a legitimate outcome (sometimes the user re-clicks Regenerate
    // on a thread that's purely technical or a quick lookup) and is
    // returned as a structured `kind: 'declined'` result, NOT as a
    // throw. The UI uses the kind to show a friendly "nothing
    // noteworthy" message with the model's reasoning, and offers
    // both Try Again and Save (= advance the thread's pointer
    // without training the spam filter).
    if (!decision.worthy || decision.entry === null) {
      return { kind: 'declined', reasoning: decision.reasoning };
    }
    return {
      kind: 'preview',
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

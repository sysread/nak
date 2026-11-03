// Wiki-record extraction agent (function-side).
//
// Scans a settled conversation for discrete, dated events - a bake, a
// doctor visit, a milestone, an experiment, an observation - and logs
// each as a record on the matching wiki article via the records tool
// (op=create). Records document the topic's JOURNEY; the article body
// (maintained by the separate wiki agent + librarian) owns its CURRENT
// STATE. This agent never touches article bodies: it finds the right
// article with the wiki tool (op=search / op=list) and hangs dated
// records off it.
//
// Drive shape mirrors the wiki agent's cron path: pg_cron fires
// nak_trigger_wiki_records_sweep() (supabase/schema.sql), which POSTs
// the venice function's /wiki-records-sweep route with the service-role
// bearer; the route calls runWikiRecordsSweepTick. Each tick claims up
// to a bounded number of eligible threads across all users
// (claim_next_thread_for_wiki_records is a global SECURITY DEFINER sweep
// that gates on the user's wikiRecordExtractionEnabled toggle and the
// existence of at least one article) and runs the agent on each.
//
// Simpler than the article agent: one model attempt (no uncensored
// fallback), and the per-thread failure RPC has no content-filter flag.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger, type EdgeLogger } from '../../_shared/edge-log.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { appendWikiAgentLog } from './_wiki_agent_log.ts';
import {
  asAgentTool,
  loadThreadSliceUpTo,
  loadThreadAttachmentsNote,
  ANALYZE_IMAGE_WIRE_SCHEMA,
  MEMORY_SEARCH_WIRE_SCHEMA,
} from './_agent_tools.ts';
import { memorySearch } from '../tools/memory_search.ts';
import { wiki } from '../tools/wiki.ts';
import { records } from '../tools/records.ts';
import { recordLinkCreate } from '../tools/record_link_create.ts';
import { recordFileAttach } from '../tools/record_file_attach.ts';
import { analyzeImage } from '../tools/analyze_image.ts';
import {
  runHeadlessAgent,
  type AgentTool,
  type AgentToolContext,
  type AgentCompleteFn,
  type Toolbox,
} from './_run.ts';
import { messageToVenice, type VeniceWireMessage } from './_recall_helpers.ts';
import {
  distillTranscript,
  isContextLengthError,
  renderDistilledNotesBlock,
  transcriptFitsDirect,
} from './_accumulator.ts';
import { MAX_WIKI_RECORD_CONTENT_CHARS } from '../../_shared/wiki-limits.ts';
import { WIKI_RECORDS_MODEL } from '../../_shared/agent-models.ts';

// Balanced model with medium reasoning per the feature spec: parsing
// whether a turn describes a discrete loggable event (vs general Q&A)
// needs nuance, same as the article agent.

const WIKI_RECORD_CLAIM_TTL_SECONDS = 600;
const MAX_FAILURES_PER_THREAD = 3;
const DEFAULT_SWEEP_MAX_THREADS = 3;

// Per-round output cap for the tool loop. Same rationale as the wiki
// agent's WIKI_MAX_COMPLETION_TOKENS: an absent max_completion_tokens
// makes the backend reserve its own default output budget (observed
// 65536 tokens) out of the context window, starving long transcripts
// of input room. Tool calls plus a short summary fit comfortably in
// 8192 including the reasoning pass.
const WIKI_RECORDS_MAX_COMPLETION_TOKENS = 8_192;

// What the distill pass must capture when a transcript exceeds the
// working context window (see _accumulator.ts). Framed around this
// agent's job: discrete dated events, not general facts.
const WIKI_RECORDS_DISTILL_FOCUS =
  'You are preparing notes for an agent that logs discrete dated events ' +
  "from the user's life. Capture every concrete event with its date (or " +
  'the best available date anchor, e.g. "yesterday" relative to a dated ' +
  'message), what happened, outcomes and quantities, and any files or ' +
  'images the user shared as evidence (by filename). Ignore abstract ' +
  'discussion, opinions, and Q&A that do not describe an event.';

const MAX_RECORD_LINK_LABEL_CHARS = 120;

const WIKI_SEARCH_DEFAULT_LIMIT = 5;
const WIKI_SEARCH_MAX_LIMIT = 20;

// ---------------------------------------------------------------------------
// Self-report verification. The prompt's final-reply contract ("naming
// the records you logged ... or the reason you logged none") is stored
// verbatim as the durable audit row; a run that skips the record write
// and then claims success is otherwise invisible. The done branch
// counts this thread's records before and after the run and annotates
// the reasoning when a claim is not backed by a count move. Warn-and-
// annotate only: the pointer-advance contract (zero-event threads must
// not pin the queue) and the run's outcome are untouched, and a count
// failure skips verification rather than failing the run.
// ---------------------------------------------------------------------------

// An affirmative record claim: a logging/creation verb BEFORE a record
// noun within a short same-sentence window ("Logged one record on
// Sourdough."). The verb-before-noun window deliberately excludes
// reference-style past tense ("One record on Sourdough was logged last
// week") that an honest no-op can produce when summarizing existing
// records. The matcher errs toward the MISS direction - it can miss a
// false claim, and some honest no-op phrasings may still be annotated
// (contracted negations, passive voice without a negation token) - but
// the annotation is warn-only and carries both counts, so the audit
// row stays truthful either way. Paired with the negation guard below
// ("no records", "logged none", and contractions like "haven't" - the
// n't alternative has NO leading word boundary because none exists
// inside a contraction).
const RECORD_CLAIM_RE =
  /\b(logged|created|recorded|added)\b\s+(?:\w+\s+){0,3}?\b(records?|events?)\b/i;
const NEGATION_RE = /\b(no|none|zero|not|never)\b|n't\b/i;

function claimsRecordCreation(reasoning: string): boolean {
  return RECORD_CLAIM_RE.test(reasoning) && !NEGATION_RE.test(reasoning);
}

// Count the thread's extraction-created records. Returns null on any
// failure - the caller skips verification (the tripwireArmed precedent
// in samskara.ts: the count is a best-effort read, never a gate).
async function countRecordsForThread(
  adminClient: SupabaseClient,
  threadId: string,
): Promise<number | null> {
  try {
    const { count, error } = await adminClient
      .from('wiki_records')
      .select('id', { count: 'exact', head: true })
      .eq('source_conversation_id', threadId);
    if (error) return null;
    return typeof count === 'number' ? count : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Wire schemas for the extraction toolbox. the wiki tool (op=search /
// op=list) finds the article a record attaches to; the records tool
// (op=list) is the dedupe check; the records tool (op=create) is the
// only write. memory_search rides read-only for grounding (its schema
// lives in _agent_tools.ts).
// ---------------------------------------------------------------------------

// The extraction agent's wiki combo wire: search (grounding lookups)
// + list (the alphabetical survey for dedup), narrowed to this
// agent's read-only authority.
const WIKI_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'wiki',
    description:
      "Read the user's wiki - encyclopedic articles about topics, " +
      'people, places, and projects in their life. One tool, one op. ' +
      'op=search: semantic lookup (ranked hits). op=list: the ' +
      'alphabetical survey with short excerpts - use it to see what ' +
      'articles already exist before creating one for an event. ' +
      'Articles are NEVER auto-injected; this tool is how you see them.',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['search', 'list'],
          description: "REQUIRED. The operation to run.",
        },
        query: {
          type: 'string',
          description: 'op=search only. Natural-language query, topic, or article title.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'Max results (search default 5 / max 20; list default 100 / max 500).',
        },
      },
      required: ['op'],
      // The wiki combo's read-only mirror (search/list) has no
      // unconditional per-op requireds - search's query is enforced by
      // the handler - so no x-per-op-required here.
      additionalProperties: false,
    },
  },
};

// The extraction agent's records combo wire: list (the log's shape)
// + create (log the event), narrowed to this agent's authority - it
// must NOT update or delete records (append-only extraction).
const RECORDS_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'records',
    description:
      "Maintain a wiki article's dated records (the topic's journey). " +
      'One tool, one op. op=list: one article\'s records, newest first. ' +
      'op=create: log a dated event on an article (article_id + date + ' +
      'content required; the date from the conversation, not today, ' +
      'when the event is in the past). You NEVER update or delete ' +
      'records - extraction is append-only.',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['list', 'create'],
          description: "REQUIRED. The operation to run.",
        },
        article_id: {
          type: 'string',
          description: 'UUID of the article this record belongs to.',
        },
        date: {
          type: 'string',
          description: 'ISO 8601 date of the event ("YYYY-MM-DD").',
        },
        content: {
          type: 'string',
          minLength: 1,
          description: 'The event text, as Markdown.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional keyword tags for filtering.',
        },
      },
      required: ['op'],
      // Per-op requireds for the narrowed (append-only) records combo
      // (list + create only - no update/delete authority).
      'x-per-op-required': {
        list: ['article_id'],
        create: ['article_id', 'date', 'content'],
      },
      additionalProperties: false,
    },
  },
};

const RECORD_LINK_CREATE_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'record_link_create',
    description:
      'Link one record to another with a short relationship label. ' +
      'DIRECTED (from -> to): create it from the NEW record you just ' +
      'logged to the PRIOR record it continues. Use ONLY when the ' +
      'conversation explicitly frames the new event as a follow-up to a ' +
      'specific earlier one ("same as last time but...", "attempt 3"). ' +
      'Get the prior record id from the records tool (op=list) and the ' +
      'new id from the records tool (op=create). Never invent a ' +
      'relationship the user did not state.',
    parameters: {
      type: 'object',
      properties: {
        from_record_id: {
          type: 'string',
          description: 'UUID of the new/derived record (from records op=create).',
        },
        to_record_id: {
          type: 'string',
          description: 'UUID of the prior record it builds on (from records op=list).',
        },
        label: {
          type: 'string',
          maxLength: MAX_RECORD_LINK_LABEL_CHARS,
          description: 'Short relationship label ("based on", "supersedes").',
        },
      },
      required: ['from_record_id', 'to_record_id'],
      additionalProperties: false,
    },
  },
};

// record_file_attach hangs a file the user posted in THIS conversation
// (an upload, or an image generated earlier in the thread) onto the record
// being logged, copying the bytes into permanent record storage. This is
// the moment a record is created from a live event, so the crumb photo or
// scan the user just shared can live with it.
const RECORD_FILE_ATTACH_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'record_file_attach',
    description:
      'Attach a file the user posted in THIS conversation (by its exact ' +
      'filename) to a record - one you just logged, or the existing record ' +
      'that already documents this event (from records op=list) - copying it ' +
      'into permanent record storage so it outlives the chat attachment. ' +
      'Use for a photo ' +
      'or scan the user shared that documents the event - a crumb shot, a ' +
      'finished dish, a scanned card. ONLY use a filename actually present ' +
      "in this conversation; never invent one, and don't attach an image " +
      'that does not clearly belong to the record.',
    parameters: {
      type: 'object',
      properties: {
        record_id: {
          type: 'string',
          description:
            'UUID of the record to attach to (from records op=create, or from ' +
            'records op=list when the event was already recorded).',
        },
        filename: {
          type: 'string',
          description: 'Exact filename of a file the user posted in this conversation.',
        },
      },
      required: ['record_id', 'filename'],
      additionalProperties: false,
    },
  },
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const WIKI_RECORDS_PROMPT = `You've just finished the conversation above. Now step out of that role - nobody will read this reply. Your job is to scan the conversation for discrete, dated EVENTS in the user's life and log them as records on the user's existing wiki articles, using the tools below.

The wiki has two layers, and you only touch one of them. Each article's BODY is its current state - the consolidated, durable account of a topic. RECORDS are the topic's journey: dated entries for specific things that happened. You do NOT edit article bodies (a separate agent owns those); you add records.

**What counts as a record-worthy event.** A specific thing that happened on a specific (knowable) day:
- An experiment or iteration ("baked a loaf with 80% hydration", "tried the colder retard", "switched to the new flour blend").
- A milestone or outcome ("hit a 5K PR", "shipped the auth flow", "got the promotion", "starter finally lively").
- An observation or measurement ("blood pressure 120/80 at the checkup", "garden's first tomato", "down to one coffee a day").
- A discrete interaction or appointment ("doctor visit", "conversation with Maya about the move", "tournament result").

**What is NOT a record.** Do not log:
- General discussion, Q&A, or explanation ("we talked about hydration ratios").
- Technical troubleshooting or debugging, UNLESS it revealed a durable pattern worth recording.
- Standing facts about the user (those are article-body or memory material, not dated events).
- Anything the assistant asserted that the user did not do, take up, or observe.

**Workflow:**

1. Read the conversation and ask: did the USER do, try, observe, or experience a specific dated event? Most conversations contain zero. That is a correct outcome - produce no records and stop.

2. For each genuine event, find the article it belongs to. Call the wiki tool with op=search and the topic (the recipe, the hobby, the person, the project). If search is thin, call it with op=list to survey what exists. Records attach to an EXISTING article only - if no article fits, skip the event (the article agent will create the article later, and a future extraction pass can log the record then).

3. Before logging, call the records tool with op=list on that article and check whether the event is already recorded. **One event, one record.** An event that already has a record - same date, same happening - gets NO second record, no matter which conversation produced the first one: the same event routinely comes back around (a second conversation covers it, or this conversation keeps discussing it and you meet it again in tomorrow's pass), and it is ALREADY CAPTURED. When the conversation adds material to an already-recorded event (an outcome, a reaction, a photo), do not re-narrate it as a new record - attach the photo to the EXISTING record (step 6 takes any record id from a records op=list result) and leave prose amendments to the maintenance agents. The same rule applies within a single pass: several aspects of one event (started it, how it went, who reacted) are ONE record, not one record per aspect. A new record is warranted only for a genuinely distinct happening - a new attempt, a new day's event, a different subject.

4. Call the records tool with op=create, passing the article_id, the event's date (ISO "YYYY-MM-DD" - read it from the conversation; use the message timestamps when the user doesn't state a date), a short Markdown description of what happened and what was learned, and a few filtering tags.

5. **Cross-link a continuation (only when explicit).** If the conversation frames the new event as a direct follow-up to a SPECIFIC earlier record you can see in a records op=list result ("attempt 3", "same dough as last week but wetter", "the rematch"), call record_link_create from the new record's id to that prior record's id, with a short label ("based on", "supersedes"). This is the exception, not the rule: most records stand alone. Never link on a vague thematic resemblance, never invent a relationship the user did not state, and never link to a record you did not actually find via the records tool (op=list). When unsure, skip the link.

6. **Attach a photo the user posted (when one documents the event).** The live files the user shared in this conversation are listed in a <thread_attachments> note above (if any). You CANNOT see images yourself. If a listed image plausibly documents this exact record - a crumb shot of the loaf they just baked, a photo of the finished dish, a scanned card - first call analyze_image(filename, query) to confirm what it actually shows, ESPECIALLY when more than one image is present (do not guess which is which). Once confirmed, call record_file_attach with the record's id - the one you just created, or the EXISTING record from step 3 when the event was already captured - and that exact filename so the evidence lives with the record permanently. Use ONLY a filename from the <thread_attachments> note; never invent one, and never attach an image you have not verified belongs to the record. Most records have no photo - that is fine; only attach when the user actually shared one for this event.

**Dates.** Anchor every record on the day the event happened, not the day you process it. If the user says "yesterday I baked", compute the date from the conversation's timestamps. Month-level precision is fine when the day is unknown - but prefer a concrete day when the conversation gives one.

**Grounding.** Use memory_search (read-only) to confirm a subject when you're unsure which article an event belongs to. Never fabricate an event the user didn't describe.

**Be conservative.** A precise, deduplicated record on the right article beats a flurry of vague ones. When in doubt whether something is a discrete event, skip it.

**Final reply: one or two sentences** naming the records you logged (and on which articles) or the reason you logged none. Plain text, no Markdown. This surfaces in the user's log drawer.`;

// ---------------------------------------------------------------------------
// Toolbox + run plumbing
// ---------------------------------------------------------------------------

function buildWikiRecordsToolbox(): Toolbox {
  return {
    name: 'wiki_records',
    tools: [
      asAgentTool(wiki, WIKI_WIRE_SCHEMA),
      asAgentTool(records, RECORDS_WIRE_SCHEMA),
      asAgentTool(recordLinkCreate, RECORD_LINK_CREATE_WIRE_SCHEMA),
      asAgentTool(recordFileAttach, RECORD_FILE_ATTACH_WIRE_SCHEMA),
      asAgentTool(analyzeImage, ANALYZE_IMAGE_WIRE_SCHEMA),
      asAgentTool(memorySearch, MEMORY_SEARCH_WIRE_SCHEMA),
    ],
  };
}

function normaliseReasoning(finalText: string): string {
  return finalText.replace(/\s+/g, ' ').trim() || '(none)';
}

type RecordsRunOutcome =
  | { kind: 'done'; toolCalls: number; reasoning: string; messageCount: number }
  | { kind: 'empty-slice' }
  | {
    kind: 'error';
    error: string;
    /**
     * True when retrying cannot change the result (a context-length
     * rejection that survived the distill path); the sweep skips such
     * threads on the first failure. Mirrors WikiRunOutcome.
     */
    deterministic?: boolean;
  };

async function runExtractionOnThread(
  adminClient: SupabaseClient,
  userId: string,
  threadId: string,
  terminalMsgId: string,
  log: EdgeLogger,
  complete?: AgentCompleteFn,
): Promise<RecordsRunOutcome> {
  let transcript: VeniceWireMessage[];
  let finalTurn: string;
  let messageCount: number;
  let apiKey: string;
  try {
    const slice = await loadThreadSliceUpTo(adminClient, threadId, terminalMsgId);
    if (slice.length === 0) return { kind: 'empty-slice' };
    messageCount = slice.length;

    const key = await readVeniceKey(adminClient);
    if (!key) return { kind: 'error', error: 'no Venice key configured (app_config unseeded)' };
    apiKey = key;

    transcript = slice.map(messageToVenice);
    // Surface the thread's live attachment filenames so the (text-tier)
    // model knows what it can inspect with analyze_image and attach with
    // record_file_attach - the raw slice carries no attachment metadata.
    // Kept separate from the transcript so the distill path can swap
    // the conversation for notes while sending the same instruction.
    const attachmentsNote = await loadThreadAttachmentsNote(adminClient, threadId);
    finalTurn = attachmentsNote
      ? `${attachmentsNote}\n\n${WIKI_RECORDS_PROMPT}`
      : WIKI_RECORDS_PROMPT;
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
  }

  const baseCtx: Omit<AgentToolContext, 'signal' | 'depth'> = {
    adminClient,
    userId,
    threadId,
  };

  const run = (messages: VeniceWireMessage[]): ReturnType<typeof runHeadlessAgent> =>
    runHeadlessAgent(
      {
        model: WIKI_RECORDS_MODEL,
        messages,
        toolbox: buildWikiRecordsToolbox(),
        baseCtx,
        apiKey,
        signal: new AbortController().signal,
        complete,
        maxTokens: WIKI_RECORDS_MAX_COMPLETION_TOKENS,
        reasoningEffort: 'medium',
      },
      0,
    );
  // Distilled shape: one user turn carrying the notes block plus the
  // same final instruction the direct shape ends on.
  const distilled = async (): Promise<VeniceWireMessage[]> => {
    const notes = await distillTranscript({
      apiKey,
      model: WIKI_RECORDS_MODEL,
      messages: transcript,
      focus: WIKI_RECORDS_DISTILL_FOCUS,
      // 'low': distillation is extraction over evidence already in
      // context (see CLAUDE.md on sub-completion budgets).
      reasoningEffort: 'low',
      complete,
      onInfo: (m) => log.debug(`thread ${threadId}: ${m}`),
    });
    return [{ role: 'user', content: `${renderDistilledNotesBlock(notes)}\n\n${finalTurn}` }];
  };

  try {
    log.debug(`asking ${WIKI_RECORDS_MODEL} about thread ${threadId} (${messageCount} messages)`);
    let result;
    if (!transcriptFitsDirect(transcript)) {
      log.info(
        `thread ${threadId} transcript exceeds the working context window; ` +
          `distilling before the tool loop`,
      );
      result = await run(await distilled());
    } else {
      try {
        result = await run([...transcript, { role: 'user', content: finalTurn }]);
      } catch (err) {
        // The estimate said the transcript fits, but the backend
        // rejected it - a tighter ceiling than the pinned working
        // window, or mid-loop growth from accumulated tool results.
        if (!isContextLengthError(err)) throw err;
        log.warn(`thread ${threadId} hit the context ceiling mid-run; retrying distilled`);
        result = await run(await distilled());
      }
    }
    return {
      kind: 'done',
      toolCalls: result.toolCalls,
      reasoning: normaliseReasoning(result.finalText),
      messageCount,
    };
  } catch (err) {
    return {
      kind: 'error',
      error: err instanceof Error ? err.message : String(err),
      deterministic: isContextLengthError(err),
    };
  }
}

async function markRecordProcessed(
  adminClient: SupabaseClient,
  threadId: string,
  holderId: string,
  terminalMsgId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await adminClient.rpc(
    'mark_thread_wiki_record_processed_if_claimed',
    { p_thread_id: threadId, p_holder_id: holderId, p_msg_id: terminalMsgId, p_user_id: userId },
  );
  if (error) {
    throw new Error(`mark_thread_wiki_record_processed_if_claimed failed: ${error.message}`);
  }
  return data === true;
}

async function recordExtractionFailureOrSkip(
  adminClient: SupabaseClient,
  threadId: string,
  holderId: string,
  terminalMsgId: string,
  reason: string,
  userId: string,
  // 1 for deterministic failures (skip immediately - the retry would
  // fail identically); MAX_FAILURES_PER_THREAD for transient ones.
  maxFailures: number = MAX_FAILURES_PER_THREAD,
): Promise<'released' | 'skipped' | 'claim-lost'> {
  const { data, error } = await adminClient.rpc('record_wiki_record_failure_or_skip', {
    p_thread_id: threadId,
    p_holder_id: holderId,
    p_msg_id: terminalMsgId,
    p_max_failures: maxFailures,
    p_reason: reason,
    p_user_id: userId,
  });
  if (error) {
    throw new Error(`record_wiki_record_failure_or_skip failed: ${error.message}`);
  }
  return data as 'released' | 'skipped' | 'claim-lost';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface WikiRecordsSweepOptions {
  maxThreads?: number;
  complete?: AgentCompleteFn;
}

export interface WikiRecordsSweepSummary {
  claimed: number;
  processed: number;
  emptySlice: number;
  skipped: number;
  released: number;
  claimLost: number;
  errors: number;
}

/**
 * One cron tick: claim up to maxThreads eligible threads across all
 * users and run the extraction agent on each. NON-throwing by contract,
 * same shape as runWikiSweepTick - a per-thread failure routes through
 * the failure RPC and the loop moves on; an infrastructure failure stops
 * the tick.
 */
export async function runWikiRecordsSweepTick(
  adminClient: SupabaseClient,
  opts: WikiRecordsSweepOptions = {},
): Promise<WikiRecordsSweepSummary> {
  const maxThreads = opts.maxThreads ?? DEFAULT_SWEEP_MAX_THREADS;
  const summary: WikiRecordsSweepSummary = {
    claimed: 0,
    processed: 0,
    emptySlice: 0,
    skipped: 0,
    released: 0,
    claimLost: 0,
    errors: 0,
  };

  for (let i = 0; i < maxThreads; i += 1) {
    const holderId = crypto.randomUUID();
    const { data: claimRows, error: claimErr } = await adminClient.rpc(
      'claim_next_thread_for_wiki_records',
      { p_holder_id: holderId, p_ttl_seconds: WIKI_RECORD_CLAIM_TTL_SECONDS },
    );
    if (claimErr) {
      console.error(`[wiki-records-sweep] claim failed: ${claimErr.message}`);
      summary.errors += 1;
      break;
    }
    const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
    if (!claim || typeof claim.thread_id !== 'string') break; // queue empty

    summary.claimed += 1;
    const threadId = claim.thread_id as string;
    const userId = claim.user_id as string;
    const terminalMsgId = claim.terminal_msg_id as string;
    const title = typeof claim.title === 'string' ? claim.title : null;
    const titleTag = title ? `"${title}"` : '[untitled]';
    const log = createEdgeLogger(userId, 'wiki-records');

    try {
      log.info(`picked up thread ${threadId} @ msg ${terminalMsgId} ${titleTag}`);
      const recordsBefore = await countRecordsForThread(adminClient, threadId);
      const outcome = await runExtractionOnThread(
        adminClient,
        userId,
        threadId,
        terminalMsgId,
        log,
        opts.complete,
      );

      if (outcome.kind === 'empty-slice') {
        const marked = await markRecordProcessed(adminClient, threadId, holderId, terminalMsgId, userId);
        if (marked) summary.emptySlice += 1;
        else summary.claimLost += 1;
      } else if (outcome.kind === 'done') {
        const marked = await markRecordProcessed(adminClient, threadId, holderId, terminalMsgId, userId);
        if (marked) {
          let reasoning = outcome.reasoning;
          const recordsAfter = await countRecordsForThread(adminClient, threadId);
          if (
            claimsRecordCreation(reasoning) &&
            recordsBefore !== null &&
            recordsAfter !== null &&
            recordsAfter === recordsBefore
          ) {
            log.warn(
              `thread ${threadId}: unverified self-report - reasoning claims a record ` +
                `but wiki_records rows for this thread went from ${recordsBefore} to ${recordsAfter} ${titleTag}`,
            );
            reasoning =
              `${reasoning} [unverified self-report: claimed record creation, ` +
              `but wiki_records rows for this thread went from ${recordsBefore} to ${recordsAfter}]`;
          }
          log.info(
            `finished thread ${threadId} ` +
              `(${outcome.toolCalls} tool calls over ${outcome.messageCount} messages, ` +
              `reasoning="${reasoning}") ${titleTag}`,
          );
          await appendWikiAgentLog(adminClient, userId, {
            agent: 'wiki-records',
            triggerSource: 'scheduled',
            threadId,
            terminalMsgId,
            toolCalls: outcome.toolCalls,
            reasoning,
          });
          summary.processed += 1;
        } else {
          summary.claimLost += 1;
        }
      } else {
        let failureOutcome: 'released' | 'skipped' | 'claim-lost';
        try {
          failureOutcome = await recordExtractionFailureOrSkip(
            adminClient,
            threadId,
            holderId,
            terminalMsgId,
            outcome.error,
            userId,
            outcome.deterministic ? 1 : MAX_FAILURES_PER_THREAD,
          );
        } catch (rpcErr) {
          log.warn(
            `thread ${threadId} extraction error: ${outcome.error} ${titleTag} ` +
              `(failure RPC also threw: ${rpcErr instanceof Error ? rpcErr.message : String(rpcErr)})`,
          );
          summary.errors += 1;
          continue;
        }
        if (failureOutcome === 'skipped') {
          log.warn(
            `thread ${threadId} extraction error: ${outcome.error} ` +
              `(reached failure cap; pointer advanced) ${titleTag}`,
          );
          summary.skipped += 1;
        } else if (failureOutcome === 'claim-lost') {
          summary.claimLost += 1;
        } else {
          log.info(
            `thread ${threadId} extraction error: ${outcome.error} ` +
              `(claim released; will retry next sweep) ${titleTag}`,
          );
          summary.released += 1;
        }
      }
    } catch (err) {
      log.warn(
        `thread ${threadId} cycle failed: ${err instanceof Error ? err.message : String(err)} ` +
          `(claim TTL will release the row) ${titleTag}`,
      );
      summary.errors += 1;
    } finally {
      await log.flush();
    }
  }

  return summary;
}

// Test-only surface. The toolbox composition is a safety invariant - the
// extraction agent gets read-only memory + image access (memory_search,
// analyze_image) and three write tools: the records combo (op=create),
// record_link_create, and record_file_attach (it creates a record from a
// live event, so it can verify a photo the user posted in the same
// conversation and hang it on the record). It never gets the wiki
// combo's write ops (save / delete) or memory writes -
// article bodies and memory stay off-limits.
export const __test = {
  buildWikiRecordsToolbox,
  WIKI_RECORDS_PROMPT,
  claimsRecordCreation,
};

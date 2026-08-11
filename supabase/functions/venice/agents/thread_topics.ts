// Thread topic-tagging work unit (function-side port of
// src/lib/agents/topics/). One tagging pass per cycle: claim a thread
// whose newest terminal assistant message hasn't been tagged, fetch
// its messages up to that message, append the topics instruction
// (with the user's existing topic vocabulary inlined for
// normalisation), ask the fast model for a JSON object listing 1-4
// topic tags, and parse + validate the output before the save RPC.
// The tags power the topic-filter dropdown in the conversation list.
//
// Two drivers share the run half: tagOneThread (per-user claim from a
// chat turn's waitUntil tail, via ./curation.ts) and
// sweepClaimAndTagThread (cross-user claim from the hourly curation
// sweep). Both are best-effort and non-throwing.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger, type EdgeLogger } from '../../_shared/edge-log.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { loadThreadSliceUpTo } from './_agent_tools.ts';
import {
  completeJsonObject,
  completeOverThreadSlice,
  CURATION_CLAIM_TTL_SECONDS,
} from './_curation_helpers.ts';
import { TOPICS_MODEL } from '../../_shared/agent-models.ts';

// Mirror of UNTAGGED_TOPIC_SENTINEL in src/lib/supabase.ts - the
// filter UI's "no topics on this row" marker. A model that emitted it
// as a tag would corrupt the drawer's filter semantics, so the
// validator below rejects it outright.
const UNTAGGED_TOPIC_SENTINEL = '(untagged)';

/**
 * The topics instruction, appended as the final user turn after the
 * conversation transcript. Verbatim copy of TOPICS_PROMPT_PREFIX /
 * TOPICS_PROMPT_SUFFIX in src/lib/agents/topics/prompt.ts so the
 * model gets identical guidance whichever path drove it.
 *
 * Design notes (from the browser original):
 *   - "Reuse names from the existing list if any fit" is the
 *     normalisation step. Without it the vocabulary sprawls into
 *     near-duplicates ("baking", "bakes", "baked-goods") and the
 *     drawer dropdown turns into noise within a month.
 *   - "1-4 topics" is the cap. One is the floor because a thread
 *     never genuinely has zero topics; four is the ceiling because
 *     more tags than that turns the filter into noise.
 *   - "Lowercase, no punctuation except hyphens, no plurals" is the
 *     normalisation hint; normaliseTag post-processes too, but the
 *     prompt makes the right shape the first attempt.
 *   - The reserved sentinel "(untagged)" is forbidden explicitly so
 *     the model can't emit the filter UI's no-topics marker.
 */
const TOPICS_PROMPT_PREFIX = `You've just finished the conversation above. Step out of that role.
Nobody will read this reply as a chat turn - the output is being
written to a database column that powers a topic-filter dropdown in
the conversation list.

Pick 1-4 short topic tags describing what this conversation is about.

Rules for each tag:
- Lowercase. ASCII letters, digits, and hyphens only.
- One or two words. Prefer single words ("baking") over phrases
  ("bread-baking") unless the single word would be too generic
  ("project" -> "saas-onboarding").
- Singular, not plural ("recipe" not "recipes").
- Topical, not conversational. "sourdough" beats "questions"; the
  subject matter is the topic, not the shape of the exchange.
- Do NOT use the literal string "(untagged)" - it's a UI primitive,
  not a topic.

If any of the tags below already fit, REUSE them verbatim instead of
minting a near-duplicate. The goal is a small, stable vocabulary - a
new tag should only appear when no existing tag fits.

Existing tags (reuse if any apply):
`;

const TOPICS_PROMPT_SUFFIX = `

Output a single JSON object with one key, "topics", whose value is an
array of strings:

{"topics": ["baking", "sourdough"]}

No preamble, no trailing text, no markdown fence. Just the object.`;

/**
 * Render the full prompt for a given existing-topics vocabulary. An
 * empty list renders as "(none yet)" so the model sees a clear marker
 * instead of a dangling blank.
 */
function buildTopicsPrompt(existingTopics: readonly string[]): string {
  const list =
    existingTopics.length === 0 ? '(none yet)' : existingTopics.join(', ');
  return TOPICS_PROMPT_PREFIX + list + TOPICS_PROMPT_SUFFIX;
}

/**
 * Strip a leading/trailing ```json fence if the model added one
 * despite the prompt's "no markdown fence" instruction. Some fast
 * models still wrap structured JSON when their default behaviour
 * leaks through. Duplicated across the three topics units rather
 * than extracted - keeping each unit's validator next to its prompt
 * beats a shared util that has to grow for every caller's edge cases
 * (see CLAUDE.md on premature abstraction).
 */
function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    const withoutFence = trimmed
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '');
    return withoutFence.trim();
  }
  return trimmed;
}

/**
 * Per-tag validation + normalisation. Returns null when the tag fails
 * any rule, otherwise the canonical form. Rules track the prompt:
 *
 *   - Must be a non-empty string after lowercasing and trim.
 *   - Strip characters outside [a-z0-9-]. A model that emits
 *     "bread-baking!" becomes "bread-baking"; "Cooking 101" becomes
 *     "cooking-101". A tag that strips down to empty is dropped.
 *   - Length 1..40 chars. The lower bound is "anything substantive";
 *     the upper bound is "a topic, not a sentence" - a 40-char tag
 *     is already way past the prompt's "one or two words" target.
 *   - Cannot equal the "(untagged)" sentinel - that's a UI primitive,
 *     not a topic, and a model that emits it would corrupt the
 *     drawer's filter semantics. Surrounding parens get stripped by
 *     the regex above anyway but the explicit guard makes the
 *     forbidden value impossible to reach via any normalisation
 *     path.
 */
function normaliseTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const lowered = raw.toLowerCase().trim();
  if (lowered.length === 0) return null;
  const cleaned = lowered.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (cleaned.length === 0 || cleaned.length > 40) return null;
  if (cleaned === UNTAGGED_TOPIC_SENTINEL) return null;
  return cleaned;
}

/**
 * Parse the raw model output into a validated topic list. Returns an
 * empty array on any parse failure, missing key, wrong type, or
 * all-invalid items. The empty-array path triggers the driver's
 * "empty-topics" branch which releases the claim without writing -
 * the row re-enters the queue and a future cycle retries.
 */
function parseTopics(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as Record<string, unknown>;
  const list = obj.topics;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const norm = normaliseTag(item);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= 4) break;
  }
  return out;
}

/** Outcome of one thread-topics cycle, mirroring the browser unit's CycleResult vocabulary. */
export type ThreadTopicsOutcome =
  /** No claimable thread - everything is tagged, claimed, or ineligible. */
  | 'empty-queue'
  /** Claimed, tagged, saved. The queue may hold more rows. */
  | 'tagged'
  /**
   * The save RPC returned false - another run took over mid-tagging.
   * Not an error; drop the work and drain.
   */
  | 'claim-lost'
  /**
   * Agent produced no usable topics (parse failure, all items
   * dropped by validation, model emitted only the reserved
   * sentinel). Claim is released so the row re-enters the queue
   * immediately; the next cycle retries naturally. Not an error -
   * a transient model misbehavior shouldn't cost a TTL wait.
   */
  | 'empty-topics'
  /** Supabase or Venice errored during the cycle. */
  | 'error';

/**
 * The run half shared by both drivers: the caller already holds the
 * per-thread claim; this tags the slice and saves-or-clears.
 * Non-throwing - every failure path folds into an outcome the drain
 * loops in ./curation.ts can act on.
 */
async function tagClaimedThread(
  adminClient: SupabaseClient,
  userId: string,
  log: EdgeLogger,
  holderId: string,
  threadId: string,
  terminalMsgId: string,
  existingTopics: readonly string[],
): Promise<ThreadTopicsOutcome> {
  log.info(
    `picked up thread ${threadId} @ msg ${terminalMsgId} (vocab=${existingTopics.length})`,
  );

  let topics: string[];
  let inputMessageCount: number;
  try {
    // Slicing the history at the claimed terminal message means a race
    // where the user added turns mid-tagging simply queues the thread
    // for the next cycle.
    const slice = await loadThreadSliceUpTo(adminClient, threadId, terminalMsgId);
    if (slice.length === 0) {
      // Pathological empty thread - nothing to tag. Treated as the
      // empty-output case below (claim released, row requeues) so the
      // queue never wedges on it.
      topics = [];
      inputMessageCount = 0;
    } else {
      const apiKey = await readVeniceKey(adminClient);
      if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

      // completeOverThreadSlice owns the transcript sizing: message
      // cap, per-row excerpting, token budget, and the shrink-retry on
      // a context-length rejection.
      //
      // Bounded JSON output - 512 tokens is a generous cap for an
      // object whose longest plausible body is `{"topics":["a","b",
      // "c","d"]}` with 40-char tags. The json_object response format
      // pins the model to JSON shape so the parser doesn't have to
      // handle freeform prose around the object.
      const { result: text, messageCount } = await completeOverThreadSlice(
        slice,
        buildTopicsPrompt(existingTopics),
        (messages) =>
          completeJsonObject({
            apiKey,
            model: TOPICS_MODEL,
            messages,
            maxTokens: 512,
          }),
      );
      topics = parseTopics(text);
      inputMessageCount = messageCount;
    }
  } catch (err) {
    log.debug(
      `thread ${threadId} agent reported error`,
      err instanceof Error ? err.message : String(err),
    );
    return 'error';
  }

  if (topics.length === 0) {
    // Model produced nothing usable. Release the claim so the row
    // re-enters the queue immediately; the next cycle retries. Best-
    // effort: if the clear RPC fails, the per-thread claim TTL will
    // let the row re-enter the queue eventually anyway.
    try {
      await adminClient.rpc('clear_topics_claim', {
        p_thread_id: threadId,
        p_holder_id: holderId,
        p_user_id: userId,
      });
    } catch {
      // see above
    }
    return 'empty-topics';
  }

  try {
    const { data: saved, error } = await adminClient.rpc(
      'save_thread_topics_if_claimed',
      {
        p_thread_id: threadId,
        p_holder_id: holderId,
        p_topics: topics,
        p_msg_id: terminalMsgId,
        p_user_id: userId,
      },
    );
    if (error) throw new Error(error.message);
    if (saved === true) {
      log.info(
        `tagged thread ${threadId}: [${topics.join(', ')}] ` +
          `(${inputMessageCount} messages in)`,
      );
      return 'tagged';
    }
    log.debug(
      `claim lost on thread ${threadId} - another run took over mid-tagging`,
    );
    return 'claim-lost';
  } catch (err) {
    log.debug(
      `save RPC threw for thread ${threadId}`,
      err instanceof Error ? err.message : String(err),
    );
    return 'error';
  }
}

/** Coerce the claim row's existing_topics column to a clean string list. */
function asTopicList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
}

/**
 * Run one thread-topics cycle for `userId`: claim the oldest
 * tag-eligible thread via the per-user RPC and tag it. Fired from the
 * chat-turn curation tail (./curation.ts), which owns the logger and
 * its flush. Non-throwing.
 */
export async function tagOneThread(
  adminClient: SupabaseClient,
  userId: string,
  log: EdgeLogger,
): Promise<ThreadTopicsOutcome> {
  // Fresh holder per call - the claim RPC's atomic per-thread
  // claim+TTL is the mutual exclusion. Same no-lease posture as
  // ./reflection.ts.
  const holderId = crypto.randomUUID();
  let claim: {
    thread_id?: unknown;
    terminal_msg_id?: unknown;
    existing_topics?: unknown;
  } | null;
  try {
    // p_user_id is the b-strict escape hatch: the service-role admin
    // client has no auth.uid(), so the RPC scopes to the thread owner
    // via coalesce(p_user_id, auth.uid()).
    const { data, error } = await adminClient.rpc('claim_next_thread_for_topics', {
      p_holder_id: holderId,
      p_ttl_seconds: CURATION_CLAIM_TTL_SECONDS,
      p_user_id: userId,
    });
    if (error) throw new Error(`claim_next_thread_for_topics failed: ${error.message}`);
    claim = Array.isArray(data) ? data[0] : data;
  } catch (err) {
    log.error(
      'thread-topics claim failed',
      err instanceof Error ? err : new Error(String(err)),
    );
    return 'error';
  }
  if (!claim || typeof claim.thread_id !== 'string') return 'empty-queue';
  return await tagClaimedThread(
    adminClient,
    userId,
    log,
    holderId,
    claim.thread_id,
    claim.terminal_msg_id as string,
    asTopicList(claim.existing_topics),
  );
}

/**
 * One sweep step: claim the most-overdue tag-eligible thread across
 * ALL users (SECURITY DEFINER claim) and tag it. Driven by
 * runCurationSweepTick in ./curation.ts. The logger exists only once
 * a claim lands - a claim is what tells us WHOSE drawer the lines
 * belong in - and is flushed here because each claim may belong to a
 * different user. Non-throwing.
 */
export async function sweepClaimAndTagThread(
  adminClient: SupabaseClient,
): Promise<ThreadTopicsOutcome> {
  const holderId = crypto.randomUUID();
  let claim: {
    thread_id?: unknown;
    terminal_msg_id?: unknown;
    existing_topics?: unknown;
    user_id?: unknown;
  } | null;
  try {
    const { data, error } = await adminClient.rpc(
      'claim_next_thread_for_topics_sweep',
      { p_holder_id: holderId, p_ttl_seconds: CURATION_CLAIM_TTL_SECONDS },
    );
    if (error) {
      throw new Error(`claim_next_thread_for_topics_sweep failed: ${error.message}`);
    }
    claim = Array.isArray(data) ? data[0] : data;
  } catch (err) {
    console.error(
      '[topics-sweep] claim failed:',
      err instanceof Error ? err.message : String(err),
    );
    return 'error';
  }
  if (!claim || typeof claim.thread_id !== 'string' || typeof claim.user_id !== 'string') {
    return 'empty-queue';
  }

  const log = createEdgeLogger(claim.user_id, 'topics');
  try {
    return await tagClaimedThread(
      adminClient,
      claim.user_id,
      log,
      holderId,
      claim.thread_id,
      claim.terminal_msg_id as string,
      asTopicList(claim.existing_topics),
    );
  } finally {
    // Flush before the sweep moves on so the outcome line isn't
    // dropped as an un-awaited broadcast when the tick settles.
    await log.flush();
  }
}

// Test-only surface: the parser + validator are behavior parity with
// the browser agent (src/lib/agents/topics/) and get asserted in
// supabase/functions/tests/curation.test.ts.
export const __test = { parseTopics, normaliseTag };

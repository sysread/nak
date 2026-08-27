// Memory topic-tagging work unit (function-side port of
// src/lib/agents/memory_topics/). One tagging pass per cycle: the
// claim RPC returns the memory's label + data + the user's existing
// topic vocabulary in a single round trip, so the run half just
// builds the prompt, calls the fast model with a JSON-pinned response
// format, and parses + normalises the output before the save RPC.
//
// The wrinkles vs the thread topics unit (./thread_topics.ts):
//
//   1. The claim returns label + data (the memory's text) rather than
//      a thread id + terminal-msg id. The input is the memory itself;
//      no second SELECT before the completion.
//   2. The save guard doesn't take a msg_id argument - eligibility
//      is driven by `last_topics_at`, which the save stamps to now().
//      A content-change trigger nulls last_topics_at to re-queue the
//      row on the next cycle.
//
// Two drivers share the run half: tagOneMemory (per-user claim from a
// chat turn's waitUntil tail, via ./curation.ts) and
// sweepClaimAndTagMemory (cross-user claim from the hourly curation
// sweep). Both are best-effort and non-throwing.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger, type EdgeLogger } from '../../_shared/edge-log.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import {
  completeJsonObject,
  CURATION_CLAIM_TTL_SECONDS,
} from './_curation_helpers.ts';
import { MEMORY_TOPICS_MODEL } from '../../_shared/agent-models.ts';

// Mirror of UNTAGGED_TOPIC_SENTINEL in src/lib/supabase.ts - the
// filter UI's "no topics on this row" marker, forbidden as a tag.
const UNTAGGED_TOPIC_SENTINEL = '(untagged)';

/**
 * The memory-topics instruction. Verbatim copy of
 * MEMORY_TOPICS_PROMPT_PREFIX / MEMORY_TOPICS_PROMPT_SUFFIX in
 * src/lib/agents/memory_topics/prompt.ts so the model gets identical
 * guidance whichever path drove it.
 *
 * Why a different prompt from the thread topics unit: the input shape
 * is different. The thread unit gets a conversation transcript and is
 * asked "what was this conversation ABOUT"; this unit gets a single
 * piece of free-form text (a fact the assistant remembered about the
 * user) and is asked "what SUBJECT does this fact concern". A memory
 * like "user is allergic to shellfish" should land under "allergies"
 * or "food" - the topic is the subject of the fact, not the fact
 * itself. Forcing the thread prompt onto memories produced verbose
 * tag sets that paraphrased the data field rather than categorising
 * it.
 */
const MEMORY_TOPICS_PROMPT_PREFIX = `You are tagging one note the assistant has remembered about the user.
The note has a short LABEL and a longer DATA body. Your job is to pick
1-4 short topic tags describing the SUBJECT AREA the note concerns -
the category a user would file the note under, not a summary of what
the note says.

Examples to calibrate:
- LABEL "Allergic to shellfish", DATA "Reacts to shrimp and lobster.
  Carries an epi-pen." -> ["allergies", "food"]
- LABEL "Prefers vim", DATA "Uses neovim with lazyvim config; resists
  switching to vscode." -> ["editor", "tooling"]
- LABEL "Lives in Berlin", DATA "Moved from London in 2023; speaks
  intermediate German." -> ["location", "language"]
- LABEL "Daughter named Maya", DATA "Born 2019; allergic to peanuts."
  -> ["family", "allergies"]

Rules for each tag:
- Lowercase. ASCII letters, digits, and hyphens only.
- One word ("allergies") preferred; two-word hyphenated phrase ("dietary-restrictions")
  only when one word is too generic to be useful.
- Prefer the form that reads naturally as a category name.
  "allergies" / "preferences" read more naturally than "allergy" /
  "preference" for category tags; "vim" stays singular because it
  names a specific thing. When in doubt, match the form already used
  in the existing vocabulary below.
- Subject area, not the assertion itself. "shellfish-allergy" is a
  fact; "allergies" is its category.
- Do NOT use the literal string "(untagged)" - it's a UI primitive,
  not a topic.

If any of the tags below already fit, REUSE them verbatim instead of
minting a near-duplicate. The goal is a small, stable vocabulary - a
new tag should only appear when no existing tag fits.

Existing tags (reuse if any apply):
`;

const MEMORY_TOPICS_PROMPT_SUFFIX = `

Output a single JSON object with one key, "topics", whose value is an
array of strings:

{"topics": ["allergies", "food"]}

No preamble, no trailing text, no markdown fence. Just the object.`;

/**
 * Build the model-facing user-turn body. Renders the memory's label
 * and data verbatim (no escaping - the model is meant to read them as
 * prose) framed by the instruction prefix + closing suffix.
 *
 * Empty existing-topics list renders as "(none yet)" so the model sees
 * a clear marker instead of a dangling blank.
 */
function buildMemoryTopicsPrompt(
  label: string,
  data: string,
  existingTopics: readonly string[],
): string {
  const vocab =
    existingTopics.length === 0 ? '(none yet)' : existingTopics.join(', ');
  return (
    MEMORY_TOPICS_PROMPT_PREFIX +
    vocab +
    '\n\nThe note:\n\nLABEL: ' +
    label +
    '\n\nDATA: ' +
    data +
    MEMORY_TOPICS_PROMPT_SUFFIX
  );
}

/**
 * Strip a leading/trailing ```json fence if the model added one
 * despite the prompt's "no markdown fence" instruction. Duplicated
 * across the three topics units rather than extracted - keeping each
 * unit's validator next to its prompt beats a shared util that has
 * to grow for every caller's edge cases (see CLAUDE.md on premature
 * abstraction).
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
 * any rule, otherwise the canonical form. Identical rules to
 * ./thread_topics.ts::normaliseTag: lowercase, strip non-alphanum-
 * or-hyphen, length 1..40, can't equal the "(untagged)" sentinel.
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
 * Parse the model's raw output into a validated topic list, capped at
 * 4. Returns an empty array on any parse failure or all-invalid
 * items. The empty path triggers the driver's "empty-topics" branch
 * which releases the claim without writing - the row re-enters the
 * queue and a future cycle retries.
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

/** Outcome of one memory-topics cycle, mirroring the browser unit's CycleResult vocabulary. */
export type MemoryTopicsOutcome =
  /** No claimable memory - everything is tagged, claimed, or ineligible. */
  | 'empty-queue'
  /** Claimed, tagged, saved. The queue may hold more rows. */
  | 'tagged'
  /**
   * The save RPC returned false - another run took over mid-tagging,
   * or the user edited the memory between claim and save and the
   * trigger nulled our claim. Not an error; drop the work and drain.
   */
  | 'claim-lost'
  /**
   * Agent produced no usable topics (parse failure, all items dropped
   * by validation, model emitted only the reserved sentinel). Claim
   * is released so the row re-enters the queue immediately; the next
   * cycle retries naturally.
   */
  | 'empty-topics'
  /** Supabase or Venice errored during the cycle. */
  | 'error';

/**
 * The run half shared by both drivers: the caller already holds the
 * per-memory claim; this tags the memory and saves-or-clears.
 * Non-throwing - every failure path folds into an outcome the drain
 * loops in ./curation.ts can act on.
 */
async function tagClaimedMemory(
  adminClient: SupabaseClient,
  userId: string,
  log: EdgeLogger,
  holderId: string,
  memoryId: string,
  label: string,
  data: string,
  existingTopics: readonly string[],
): Promise<MemoryTopicsOutcome> {
  log.info(`picked up memory ${memoryId} (vocab=${existingTopics.length})`);

  let topics: string[];
  try {
    const apiKey = await readVeniceKey(adminClient);
    if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

    // Bounded JSON output - 256 tokens is plenty for an object shaped
    // `{"topics":["a","b","c","d"]}` with 40-char tags. The
    // json_object response format pins the model to JSON so the
    // parser doesn't have to handle freeform prose around the object.
    const text = await completeJsonObject({
      apiKey,
      model: MEMORY_TOPICS_MODEL,
      // Classification/extraction over evidence already in context - a
      // thinking pass is pure latency and budget burn. The model can
      // reason, so this suppression is load-bearing, not a no-op.
      disableThinking: true,
      messages: [
        { role: 'user', content: buildMemoryTopicsPrompt(label, data, existingTopics) },
      ],
      maxTokens: 256,
    });
    topics = parseTopics(text);
  } catch (err) {
    log.debug(
      `memory ${memoryId} agent reported error`,
      err instanceof Error ? err.message : String(err),
    );
    return 'error';
  }

  if (topics.length === 0) {
    // Model produced nothing usable. Release the claim so the row
    // re-enters the queue immediately; the next cycle retries. Best-
    // effort: if the clear RPC fails, the per-memory claim TTL will
    // let the row re-enter the queue eventually anyway.
    try {
      await adminClient.rpc('clear_memory_topics_claim', {
        p_memory_id: memoryId,
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
      'save_memory_topics_if_claimed',
      {
        p_memory_id: memoryId,
        p_holder_id: holderId,
        p_topics: topics,
        p_user_id: userId,
      },
    );
    if (error) throw new Error(error.message);
    if (saved === true) {
      log.info(`tagged memory ${memoryId}: [${topics.join(', ')}]`);
      return 'tagged';
    }
    log.debug(
      `claim lost on memory ${memoryId} - ` +
        'another run took over mid-tagging, or the memory was edited',
    );
    return 'claim-lost';
  } catch (err) {
    log.debug(
      `save RPC threw for memory ${memoryId}`,
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
 * Run one memory-topics cycle for `userId`: claim the oldest
 * tag-eligible memory via the per-user RPC and tag it. Fired from the
 * chat-turn curation tail (./curation.ts), which owns the logger and
 * its flush. Non-throwing.
 */
export async function tagOneMemory(
  adminClient: SupabaseClient,
  userId: string,
  log: EdgeLogger,
): Promise<MemoryTopicsOutcome> {
  // Fresh holder per call - the claim RPC's atomic per-memory
  // claim+TTL is the mutual exclusion. Same no-lease posture as
  // ./reflection.ts.
  const holderId = crypto.randomUUID();
  let claim: {
    memory_id?: unknown;
    label?: unknown;
    data?: unknown;
    existing_topics?: unknown;
  } | null;
  try {
    // p_user_id is the b-strict escape hatch: the service-role admin
    // client has no auth.uid(), so the RPC scopes to the memory owner
    // via coalesce(p_user_id, auth.uid()).
    const { data, error } = await adminClient.rpc('claim_next_memory_for_topics', {
      p_holder_id: holderId,
      p_ttl_seconds: CURATION_CLAIM_TTL_SECONDS,
      p_user_id: userId,
    });
    if (error) throw new Error(`claim_next_memory_for_topics failed: ${error.message}`);
    claim = Array.isArray(data) ? data[0] : data;
  } catch (err) {
    log.error(
      'memory-topics claim failed',
      err instanceof Error ? err : new Error(String(err)),
    );
    return 'error';
  }
  if (!claim || typeof claim.memory_id !== 'string') return 'empty-queue';
  return await tagClaimedMemory(
    adminClient,
    userId,
    log,
    holderId,
    claim.memory_id,
    typeof claim.label === 'string' ? claim.label : '',
    typeof claim.data === 'string' ? claim.data : '',
    asTopicList(claim.existing_topics),
  );
}

/**
 * One sweep step: claim the most-overdue tag-eligible memory across
 * ALL users (SECURITY DEFINER claim) and tag it. Driven by
 * runCurationSweepTick in ./curation.ts. The logger exists only once
 * a claim lands - a claim is what tells us WHOSE drawer the lines
 * belong in - and is flushed here because each claim may belong to a
 * different user. Non-throwing.
 */
export async function sweepClaimAndTagMemory(
  adminClient: SupabaseClient,
): Promise<MemoryTopicsOutcome> {
  const holderId = crypto.randomUUID();
  let claim: {
    memory_id?: unknown;
    label?: unknown;
    data?: unknown;
    existing_topics?: unknown;
    user_id?: unknown;
  } | null;
  try {
    const { data, error } = await adminClient.rpc(
      'claim_next_memory_for_topics_sweep',
      { p_holder_id: holderId, p_ttl_seconds: CURATION_CLAIM_TTL_SECONDS },
    );
    if (error) {
      throw new Error(`claim_next_memory_for_topics_sweep failed: ${error.message}`);
    }
    claim = Array.isArray(data) ? data[0] : data;
  } catch (err) {
    console.error(
      '[memory-topics-sweep] claim failed:',
      err instanceof Error ? err.message : String(err),
    );
    return 'error';
  }
  if (!claim || typeof claim.memory_id !== 'string' || typeof claim.user_id !== 'string') {
    return 'empty-queue';
  }

  const log = createEdgeLogger(claim.user_id, 'memory-topics');
  try {
    return await tagClaimedMemory(
      adminClient,
      claim.user_id,
      log,
      holderId,
      claim.memory_id,
      typeof claim.label === 'string' ? claim.label : '',
      typeof claim.data === 'string' ? claim.data : '',
      asTopicList(claim.existing_topics),
    );
  } finally {
    // Flush before the sweep moves on so the outcome line isn't
    // dropped as an un-awaited broadcast when the tick settles.
    await log.flush();
  }
}

// Test-only surface: the parser + validator are behavior parity with
// the browser agent (src/lib/agents/memory_topics/) and get asserted
// in supabase/functions/tests/curation.test.ts.
export const __test = { parseTopics, normaliseTag };

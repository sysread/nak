// Conversation-digest work unit. Once per (user, local calendar day),
// after that day has ended in the user's timezone, read every
// conversation the user had that day and write one row to
// conversation_digests: a short overview of the day plus a per-thread
// {thread_id, title, summary} table. The Daily digest panel on the
// Chats tab is the only consumer.
//
// Single driver: runDigestSweepTick, called by the venice function's
// /digest-sweep route, which pg_cron hits hourly (schema.sql,
// nak_trigger_digest_sweep). The per-user "is a day due" decision -
// timezone resolution, day-gate, oldest-first backfill order, settings
// toggle - lives entirely in the claim_next_digest_day RPC; this
// module only summarizes what the claim hands it.
//
// Failure posture: a run that dies (bad JSON, truncated completion,
// transport error) reports through record_digest_failure, which
// releases the claim for an hourly retry until DIGEST_FAILURE_CAP
// consecutive failures on the same day, then writes a placeholder
// row to advance the queue. The cap matters because the claim always
// serves the oldest undigested day across the user's WHOLE history
// (there is no backfill floor) - without it a poison day would pin
// every day behind it forever.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger } from '../../_shared/edge-log.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { completeJsonObjectWithMeta } from './_curation_helpers.ts';
import { DIGEST_MODEL } from '../../_shared/agent-models.ts';

// Server-side model id, held here directly (this module cannot import
// from src/lib; same convention as the curation agents). The
// big-window tier matters: the input is a full day of conversation across
// every thread, which can run long, while the output is a small JSON
// object.

// Claim TTL. A digest run is one fetch plus one completion - minutes,
// not hours - so ten minutes of headroom covers a slow completion
// without letting a crashed run block the user for long.
const DIGEST_CLAIM_TTL_SECONDS = 600;

// Users processed per tick. Each is one Venice completion; the hourly
// cadence resumes a longer backlog drain across ticks.
const DEFAULT_SWEEP_MAX_USERS = 3;

// Consecutive failures on one day before record_digest_failure writes
// a placeholder and moves on. Matches the wiki sweep's retry budget.
const DIGEST_FAILURE_CAP = 3;

// Input-side caps. Per-message truncation keeps one giant paste from
// eating the whole transcript budget; the total cap keeps the prompt
// well inside the model window and the spend predictable.
const MAX_CHARS_PER_MESSAGE = 1500;
const MAX_TRANSCRIPT_CHARS = 150_000;
const MAX_MESSAGES_FETCHED = 2000;

// Output budget. The reply is a few hundred tokens of JSON, but on a
// reasoning model max_completion_tokens pays for the thinking pass
// too, and thinking burn scales with the INPUT (a whole day of chat
// across every thread - the largest input any sub-completion in the
// tree sees) - a budget sized to the output shape dies with
// finish_reason='length' on exactly the busiest days (see CLAUDE.md,
// Venice sub-completions on reasoning models). A reasoning pass can
// run chatty regardless of the pinned low effort, and the model is
// cheap enough that headroom costs nothing, so this is sized so only
// a genuine runaway hits it - the fail-closed length check below is
// the guard for that case, not the budget.
const DIGEST_MAX_TOKENS = 65536;

const DIGEST_PROMPT_HEADER = `You are writing a daily digest of a user's AI-assistant conversations.
Below is everything the user discussed on %DATE%, grouped by conversation.

Reply with a single JSON object, nothing else:
{
  "summary": "1-3 sentence overview of the day's discussions",
  "threads": [
    {"thread_id": "<id copied verbatim from the header>",
     "title": "<the conversation's title, copied from the header>",
     "summary": "1-2 sentence summary of that conversation"}
  ]
}

Rules:
- One threads[] entry per conversation below, in the same order.
- Describe subject matter (problems, decisions, artifacts), not the
  shape of the exchange ("the user asked and the assistant answered").
- Present tense, no preamble, no markdown.`;

interface DayMessage {
  threadId: string;
  title: string;
  role: string;
  content: string;
}

export interface DigestThreadEntry {
  thread_id: string;
  title: string;
  summary: string;
}

export interface DigestSweepOptions {
  /** Users to process this invocation; defaults to DEFAULT_SWEEP_MAX_USERS. */
  maxUsers?: number;
}

/** Per-tick counters returned to the /digest-sweep caller (and the dev shim). */
export interface DigestSweepSummary {
  claimed: number;
  written: number;
  emptyDay: number;
  claimLost: number;
  /** Failures released for an hourly retry (below the cap). */
  released: number;
  /** Days skipped with a placeholder after hitting the failure cap. */
  skipped: number;
  errors: number;
}

/**
 * Fetch the day's user/assistant messages across every thread the
 * user owns, oldest first. The UTC day boundaries come from the claim
 * RPC (computed in SQL against the user's timezone) so no timezone
 * math happens here.
 */
async function fetchDayMessages(
  adminClient: SupabaseClient,
  userId: string,
  dayStart: string,
  dayEnd: string,
): Promise<DayMessage[]> {
  // The threads embed MUST name its FK: six threads.last_*_msg_id
  // pointer columns also relate threads to messages, so a bare
  // `threads!inner` makes PostgREST refuse the query as an ambiguous
  // relationship (PGRST201) on every call - the failure mode that
  // skipped whole days of digests before the hint was added.
  const { data, error } = await adminClient
    .from('messages')
    .select('thread_id, role, content, created_at, threads!messages_thread_id_fkey!inner(user_id, title)')
    .eq('threads.user_id', userId)
    .in('role', ['user', 'assistant'])
    .gte('created_at', dayStart)
    .lt('created_at', dayEnd)
    // Wall-clock ordering on purpose: this is a cross-thread day
    // window ("what happened today, in the order it happened"), not a
    // per-thread transcript - position only orders within one thread.
    .order('created_at', { ascending: true })
    .limit(MAX_MESSAGES_FETCHED);
  if (error) throw new Error(`day-message fetch failed: ${error.message}`);
  const out: DayMessage[] = [];
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const content = typeof row.content === 'string' ? row.content : '';
    if (content.length === 0) continue;
    const thread = row.threads as Record<string, unknown> | null;
    out.push({
      threadId: String(row.thread_id ?? ''),
      title:
        thread && typeof thread.title === 'string' && thread.title.length > 0
          ? thread.title
          : 'Untitled',
      role: String(row.role ?? ''),
      content,
    });
  }
  return out;
}

/**
 * Render the day's messages as a transcript grouped by thread, with
 * per-message and total char caps. Thread headers carry the id the
 * model must echo back, so the digest rows can deep-link to the
 * conversation later.
 */
export function buildDayTranscript(messages: DayMessage[]): string {
  const parts: string[] = [];
  let total = 0;
  let currentThread: string | null = null;
  for (const m of messages) {
    if (total >= MAX_TRANSCRIPT_CHARS) {
      parts.push('[transcript truncated - day exceeded the input budget]');
      break;
    }
    if (m.threadId !== currentThread) {
      currentThread = m.threadId;
      const header = `\n=== Conversation "${m.title}" (thread_id: ${m.threadId}) ===`;
      parts.push(header);
      total += header.length;
    }
    const body =
      m.content.length > MAX_CHARS_PER_MESSAGE
        ? m.content.slice(0, MAX_CHARS_PER_MESSAGE) + ' [...]'
        : m.content;
    const line = `${m.role}: ${body}`;
    parts.push(line);
    total += line.length;
  }
  return parts.join('\n');
}

/**
 * Parse and clamp the model's JSON reply. Throws on any shape
 * violation - the caller treats a throw as "leave the claim to its
 * TTL and retry next tick" rather than persisting a garbage digest.
 */
export function parseDigestReply(
  raw: string,
  validThreadIds: ReadonlySet<string>,
): { summary: string; threads: DigestThreadEntry[] } {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('digest reply is not an object');
  }
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  if (summary.length === 0) throw new Error('digest reply has no summary');
  const rawThreads = Array.isArray(parsed.threads) ? parsed.threads : [];
  const threads: DigestThreadEntry[] = [];
  const seen = new Set<string>();
  for (const t of rawThreads as Array<Record<string, unknown>>) {
    if (typeof t !== 'object' || t === null) continue;
    const threadId = typeof t.thread_id === 'string' ? t.thread_id : '';
    const threadSummary = typeof t.summary === 'string' ? t.summary.trim() : '';
    // Drop hallucinated ids rather than persisting a dead deep-link;
    // dedupe because fast models occasionally repeat an entry.
    if (!validThreadIds.has(threadId) || seen.has(threadId)) continue;
    if (threadSummary.length === 0) continue;
    seen.add(threadId);
    threads.push({
      thread_id: threadId,
      title:
        typeof t.title === 'string' && t.title.trim().length > 0
          ? t.title.trim().slice(0, 200)
          : 'Untitled',
      summary: threadSummary.slice(0, 1000),
    });
  }
  if (threads.length === 0) throw new Error('digest reply matched no real threads');
  return { summary: summary.slice(0, 2000), threads };
}

/**
 * One cron tick: claim up to maxUsers (user, day) pairs and digest
 * each. NON-throwing by contract - per-user failures are counted and
 * the loop moves on; an infrastructure failure (claim RPC down) stops
 * the tick. Per-user progress is logged through an edge logger bound
 * to the digest's OWNER so it lands in their Logs drawer.
 */
export async function runDigestSweepTick(
  adminClient: SupabaseClient,
  opts: DigestSweepOptions = {},
): Promise<DigestSweepSummary> {
  const maxUsers = opts.maxUsers ?? DEFAULT_SWEEP_MAX_USERS;
  const summary: DigestSweepSummary = {
    claimed: 0,
    written: 0,
    emptyDay: 0,
    claimLost: 0,
    released: 0,
    skipped: 0,
    errors: 0,
  };

  const failedThisTick = new Set<string>();
  for (let i = 0; i < maxUsers; i += 1) {
    const holderId = crypto.randomUUID();
    const { data: claimRows, error: claimErr } = await adminClient.rpc(
      'claim_next_digest_day',
      { p_holder_id: holderId, p_ttl_seconds: DIGEST_CLAIM_TTL_SECONDS },
    );
    if (claimErr) {
      console.error(`[digest-sweep] claim_next_digest_day failed: ${claimErr.message}`);
      summary.errors += 1;
      break;
    }
    const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
    if (!claim || typeof claim.user_id !== 'string') break; // queue empty

    const userId = claim.user_id as string;
    const digestDate = String(claim.digest_date);

    // A failure releases its claim immediately, and the claim RPC
    // always serves a user's oldest undigested day - so within one
    // tick the loop would re-claim the day it just failed and burn
    // the whole failure cap in minutes instead of the hourly retries
    // the cap is meant to grant. Skip a pair that already failed this
    // tick; its claim rides the TTL and the next tick retries.
    if (failedThisTick.has(`${userId}:${digestDate}`)) continue;

    summary.claimed += 1;
    const dayStart = String(claim.day_start);
    const dayEnd = String(claim.day_end);
    const log = createEdgeLogger(userId, 'digest');

    try {
      log.info(`digesting ${digestDate}`);
      const messages = await fetchDayMessages(adminClient, userId, dayStart, dayEnd);

      if (messages.length === 0) {
        // The claim gate saw substantive traffic, but the fetch found
        // none (messages deleted since, or a boundary race). Persist a
        // placeholder so the day stops being re-claimed every tick.
        const saved = await adminClient.rpc('save_conversation_digest', {
          p_user_id: userId,
          p_holder_id: holderId,
          p_digest_date: digestDate,
          p_summary: 'No conversations on this day.',
          p_threads: [],
        });
        if (saved.error) throw new Error(`save failed: ${saved.error.message}`);
        if (saved.data === true) summary.emptyDay += 1;
        else summary.claimLost += 1;
        continue;
      }

      const apiKey = await readVeniceKey(adminClient);
      if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

      const transcript = buildDayTranscript(messages);
      const prompt =
        DIGEST_PROMPT_HEADER.replace('%DATE%', digestDate) + '\n\n' + transcript;
      const { content, finishReason } = await completeJsonObjectWithMeta({
        apiKey,
        model: DIGEST_MODEL,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: DIGEST_MAX_TOKENS,
        // Extraction over evidence already in context - low effort is
        // the right tier, and it keeps the thinking pass from eating
        // the output budget on a busy day.
        reasoningEffort: 'low',
      });
      if (finishReason === 'length') {
        // Truncated mid-object. Fail closed (claim TTL retries) rather
        // than persisting whatever half-JSON survived.
        throw new Error('digest completion truncated (finish_reason=length)');
      }

      const validIds = new Set(messages.map((m) => m.threadId));
      const digest = parseDigestReply(content, validIds);

      const saved = await adminClient.rpc('save_conversation_digest', {
        p_user_id: userId,
        p_holder_id: holderId,
        p_digest_date: digestDate,
        p_summary: digest.summary,
        p_threads: digest.threads,
      });
      if (saved.error) throw new Error(`save failed: ${saved.error.message}`);
      if (saved.data === true) {
        log.info(
          `wrote digest for ${digestDate} (${digest.threads.length} conversations)`,
        );
        summary.written += 1;
      } else {
        log.debug(`claim lost on ${digestDate} - another run took over`);
        summary.claimLost += 1;
      }
    } catch (err) {
      const failureMsg = err instanceof Error ? err.message : String(err);
      failedThisTick.add(`${userId}:${digestDate}`);
      try {
        const failed = await adminClient.rpc('record_digest_failure', {
          p_user_id: userId,
          p_holder_id: holderId,
          p_digest_date: digestDate,
          p_failure_cap: DIGEST_FAILURE_CAP,
        });
        if (failed.error) throw new Error(failed.error.message);
        const outcome = typeof failed.data === 'string' ? failed.data : 'released';
        if (outcome === 'skipped') {
          log.warn(
            `digest for ${digestDate} failed: ${failureMsg} ` +
              '(reached failure cap; placeholder written to advance the queue)',
          );
          summary.skipped += 1;
        } else if (outcome === 'claim-lost') {
          log.debug(
            `digest for ${digestDate} failed: ${failureMsg} ` +
              '(claim already gone; another run will retry)',
          );
          summary.claimLost += 1;
        } else {
          log.warn(
            `digest for ${digestDate} failed: ${failureMsg} (claim released; retried next tick)`,
          );
          summary.released += 1;
        }
      } catch (rpcErr) {
        // Bookkeeping failed on top of the original error. The claim
        // TTL still releases the row, so progress continues on the
        // slower fallback path; surface both for correlation.
        log.warn(
          `digest for ${digestDate} failed: ${failureMsg} ` +
            `(failure RPC also threw: ${rpcErr instanceof Error ? rpcErr.message : String(rpcErr)})`,
        );
        summary.errors += 1;
      }
    } finally {
      await log.flush();
    }
  }
  return summary;
}

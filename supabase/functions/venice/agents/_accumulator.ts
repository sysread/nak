// Distill-then-act support for headless agents whose input transcript
// may not fit the serving backend's context window. Port of the
// accumulator pattern from fnord (lib/ai/accumulator.ex): when a
// transcript is too large to hand to the tool-loop agent verbatim, we
// render it to text, split it into chunks, and run one completion per
// chunk that folds the chunk into an accumulated notes buffer. The
// notes - not the raw transcript - then feed the agent's normal tool
// loop, so all writes still happen in one pass with the full toolbox
// and the usual dedup discipline. Chunk passes are read-only by
// design: letting them write would mean tool calls issued from
// partial knowledge of the conversation.
//
// Consumers: agents/wiki.ts and agents/wiki_records.ts (the two
// sweep agents that feed whole thread slices to a model), plus
// agents/_curation_helpers.ts, which borrows estimateWireTokens and
// isContextLengthError for the cheaper truncate-and-shrink sizing the
// curation units use (a topic list doesn't justify a distill pass per
// chunk the way an encyclopedia article does). The remaining slice
// consumers - reflection and samskara_evaluation - still send
// unbounded slices and can adopt this module when their inputs start
// hitting the same wall.

import { toolComplete } from '../tools/_venice_complete.ts';
import type { AgentCompleteFn } from './_run.ts';
import type { VeniceWireMessage } from './_recall_helpers.ts';

// The char->token estimate used across nak (see MAX_RECALL_CHARS in
// _recall_helpers.ts: "~50k tokens at 4 chars/token"). Conservative
// for English prose; CJK-heavy content runs closer to 1 char/token,
// which the working-window margin below absorbs.
const CHARS_PER_TOKEN = 4;

/**
 * The context window we BUDGET against, deliberately far below the
 * 1M the model registry claims for the wiki fleet's models. The
 * registry number is unverified metadata, not a contract: on
 * 2026-07-23 the backend serving deepseek-v4-flash enforced a 163840
 * ceiling (two threads were skipped with "maximum context length is
 * 163840 tokens"), and a probe a week later accepted requests sized
 * for 1M+. Budgeting against a number that moves under us means 400s;
 * budgeting conservatively costs at most a few extra distill passes
 * on rare oversized threads. 96k also keeps headroom under the lowest
 * ceiling observed in production for the act pass's tool schemas and
 * mid-loop tool-result growth.
 */
export const WORKING_CONTEXT_TOKENS = 96_000;

// Output budget for each distill completion. The notes for one chunk
// are a few paragraphs; thousands of tokens of headroom because a
// reasoning model's thinking pass spends from the same budget (see
// CLAUDE.md "Venice sub-completions on reasoning models").
const DISTILL_MAX_OUTPUT_TOKENS = 8_192;

// Mirror of fnord's backoff knobs: on a context-length 400, shrink
// the chunk budget by BACKOFF_STEP of the working window and retry;
// below BACKOFF_FLOOR give up. Deliberate divergence from fnord: the
// shrunken fraction persists across subsequent chunks instead of
// resetting per chunk - a ceiling tight enough to reject one chunk
// will reject the next identically, and resetting guarantees a
// failed call per chunk.
const BACKOFF_FLOOR = 0.6;
const BACKOFF_STEP = 0.2;

// Below this chunk budget the distill loop errors out rather than
// crawling through a transcript a paragraph at a time - if overhead
// (prompt + accumulated notes + output reserve) eats the window down
// to this, something is structurally wrong.
const MIN_CHUNK_CHARS = 8_000;

// Tool traffic inside the transcript is mostly environmental (search
// dumps, article bodies the chat already read); the distill notes
// target what the USER said and decided. Excerpting keeps a single
// web_search result from displacing three user turns from a chunk.
const TOOL_RESULT_EXCERPT_CHARS = 2_000;
const TOOL_CALL_ARGS_EXCERPT_CHARS = 500;

/**
 * Substring sentinel for the upstream "prompt too large" rejection.
 * Observed shape (truncated to VeniceError's 200-char body slice):
 *
 *   Venice chat/completions 400: {"error":{"message":"This model's
 *   maximum context length is 163840 tokens. However, you requested
 *   65536 output tokens and your prompt contains at least 98305 input
 *   tokens, ...
 *
 * Matching the phrase rather than the status keeps it narrow: content
 * -classifier 400s and malformed-request 400s carry different bodies
 * and must stay on their own error paths.
 */
const CONTEXT_LENGTH_SENTINEL = 'maximum context length';

/**
 * True when `err` is the deterministic "input does not fit the
 * model's context window" rejection. Callers branch on this to
 * distill-and-retry (or to skip with an honest reason) instead of
 * burning transient-failure retries on an error that cannot clear.
 */
export function isContextLengthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes(CONTEXT_LENGTH_SENTINEL);
}

/**
 * Rough token estimate for the wire-shape transcript the act pass
 * would send: message content plus tool_calls JSON, at the standard
 * chars-per-token ratio.
 */
export function estimateWireTokens(messages: readonly VeniceWireMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    if (m.tool_calls && m.tool_calls.length > 0) {
      chars += JSON.stringify(m.tool_calls).length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Whether a transcript is small enough to hand to the tool loop
 * verbatim. Over-budget transcripts go through distillTranscript
 * first; under-budget ones run exactly as they always have.
 */
export function transcriptFitsDirect(messages: readonly VeniceWireMessage[]): boolean {
  return estimateWireTokens(messages) <= WORKING_CONTEXT_TOKENS;
}

function excerpt(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n[... ${text.length - cap} more chars omitted from this distillation]`;
}

/**
 * Render one wire message as a plain-text block for chunking. Tool
 * results and tool-call arguments are excerpted (see the constants
 * above); user and assistant prose is kept whole.
 */
function renderMessage(m: VeniceWireMessage): string {
  const lines: string[] = [];
  if (m.role === 'tool') {
    lines.push(`[tool result${m.name ? ` (${m.name})` : ''}]`);
    if (m.content) lines.push(excerpt(m.content, TOOL_RESULT_EXCERPT_CHARS));
  } else {
    lines.push(`[${m.role}]`);
    if (m.content) lines.push(m.content);
    for (const call of m.tool_calls ?? []) {
      lines.push(
        `(called ${call.function.name} with ${excerpt(call.function.arguments, TOOL_CALL_ARGS_EXCERPT_CHARS)})`,
      );
    }
  }
  return lines.join('\n');
}

const DISTILL_SYSTEM_PROMPT = `You are distilling a long conversation transcript into working notes for another agent. You process the transcript in sequential chunks; each request shows your accumulated notes so far and the next chunk.

Update the notes:
1. Fold in everything from the current chunk that matters for the goal below.
2. Build on the existing notes, preserving their structure. Revise an entry only when the new chunk contradicts or refines it. Never drop an entry.
3. Record concrete details: dates, names, quantities, decisions, reversals. Quote short key statements verbatim when the wording carries weight.
4. If the chunk ends mid-topic, mark the dangling thread with <partial> so a later chunk can complete it.

Respond ONLY with the full updated notes - no preamble, no commentary.`;

/**
 * Take the next chunk from the pending rendered blocks without
 * consuming them - the caller commits the consumption only after the
 * chunk's completion succeeds, so a backoff retry recomputes from
 * untouched state.
 *
 * Whole blocks are preferred; a single block larger than the budget
 * is hard-split, with `remainder` carrying the tail back to the head
 * of the queue.
 */
function nextChunk(
  pending: readonly string[],
  budgetChars: number,
): { chunk: string; consumed: number; remainder: string | null } {
  const parts: string[] = [];
  let used = 0;
  let consumed = 0;
  for (const block of pending) {
    // +1 for the joining newline.
    if (used + block.length + 1 > budgetChars && consumed > 0) break;
    if (block.length > budgetChars && consumed === 0) {
      // Oversized single block: split it at the budget.
      return {
        chunk: block.slice(0, budgetChars),
        consumed: 1,
        remainder: block.slice(budgetChars),
      };
    }
    parts.push(block);
    used += block.length + 1;
    consumed += 1;
  }
  return { chunk: parts.join('\n'), consumed, remainder: null };
}

export interface DistillTranscriptOptions {
  apiKey: string;
  /** Concrete Venice model id; callers pass the same id the act pass runs on. */
  model: string;
  /** The transcript to distill - the slice WITHOUT the agent's final prompt turn. */
  messages: readonly VeniceWireMessage[];
  /**
   * What the notes must capture, stated for the distill model. Agent-
   * specific: the wiki agent wants user-revealing facts and article
   * subjects, the records agent wants dated events.
   */
  focus: string;
  /**
   * reasoning_effort for the distill calls. Callers pass 'low' for
   * reasoning models (extraction over in-context evidence does not
   * earn a thinking budget - see CLAUDE.md) and omit it entirely for
   * non-reasoning models, where the field can 400.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Test seam; defaults to toolComplete (the live Venice call). */
  complete?: AgentCompleteFn;
  /** Best-effort progress line, e.g. into the run's edge logger. */
  onInfo?: (message: string) => void;
}

/**
 * Distill an oversized transcript into an accumulated notes string.
 * Throws on failure - including a context-length rejection that
 * backoff cannot clear - so the caller's normal error path handles
 * it; a thrown context-length error from HERE means the thread is
 * unprocessable at any chunking, which is skip-with-honest-reason
 * territory.
 */
export async function distillTranscript(opts: DistillTranscriptOptions): Promise<string> {
  const complete = opts.complete ?? toolComplete;
  const info = opts.onInfo ?? ((): void => {});
  const systemPrompt = `${DISTILL_SYSTEM_PROMPT}\n\n# Goal\n${opts.focus}`;

  const pending = opts.messages.map(renderMessage);
  let buffer = '';
  let frac = 1.0;
  let pass = 0;

  while (pending.length > 0) {
    // Everything that rides along with the chunk spends from the same
    // window: the prompt, the accumulated notes, and the reserved
    // output budget.
    const overheadTokens = Math.ceil((systemPrompt.length + buffer.length) / CHARS_PER_TOKEN) +
      DISTILL_MAX_OUTPUT_TOKENS;
    const budgetChars = (Math.floor(WORKING_CONTEXT_TOKENS * frac) - overheadTokens) *
      CHARS_PER_TOKEN;
    if (budgetChars < MIN_CHUNK_CHARS) {
      throw new Error(
        `distillation cannot fit a workable chunk (budget ${budgetChars} chars at fraction ${frac.toFixed(1)})`,
      );
    }

    const { chunk, consumed, remainder } = nextChunk(pending, budgetChars);
    const userPrompt = `# Notes so far\n${
      buffer || '(none yet - this is the first chunk)'
    }\n\n# Next transcript chunk\n${chunk}`;

    let text: string;
    let finishReason: string | null;
    try {
      const completion = await complete({
        apiKey: opts.apiKey,
        model: opts.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxTokens: DISTILL_MAX_OUTPUT_TOKENS,
        reasoningEffort: opts.reasoningEffort,
        retryRateLimit: true,
      });
      text = completion.text.trim();
      finishReason = completion.finishReason;
    } catch (err) {
      if (isContextLengthError(err) && frac - BACKOFF_STEP >= BACKOFF_FLOOR) {
        frac -= BACKOFF_STEP;
        info(
          `distill chunk rejected for context length; backing off chunk budget to ${
            Math.round(frac * 100)
          }% of the working window`,
        );
        continue; // nothing was consumed; recompute the chunk smaller.
      }
      throw err;
    }

    if (!text) {
      // A truncated reasoning pass can eat the whole output budget and
      // return empty content (finish_reason 'length'); folding that in
      // would silently wipe the notes accumulated so far.
      throw new Error(
        `distill pass returned no text (finish_reason=${finishReason ?? 'unknown'})`,
      );
    }

    buffer = text;
    pending.splice(0, consumed);
    if (remainder !== null) pending.unshift(remainder);
    pass += 1;
    info(`distill pass ${pass} folded ${consumed} message block(s); ${pending.length} remaining`);
  }

  return buffer;
}

/**
 * The stand-in block the act pass sends in place of the raw
 * transcript, so the agent model knows it is reading a distillation
 * rather than the conversation itself.
 */
export function renderDistilledNotesBlock(notes: string): string {
  return [
    '<conversation_notes>',
    'The conversation was too large to include verbatim. The notes below were',
    'distilled from the full transcript by a prior pass; treat them as your',
    'view of the conversation.',
    '',
    notes,
    '</conversation_notes>',
  ].join('\n');
}

// Test-only surface: the chunking and rendering internals, exercised
// in supabase/functions/tests/accumulator.test.ts without a network.
export const __test = {
  nextChunk,
  renderMessage,
  DISTILL_SYSTEM_PROMPT,
  MIN_CHUNK_CHARS,
  TOOL_RESULT_EXCERPT_CHARS,
  BACKOFF_FLOOR,
  BACKOFF_STEP,
};

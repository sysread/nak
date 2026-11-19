// Shared decision-call state shaping, used by the decision-model
// judges that feed the /decisions endpoint a settled thread's
// transcript (B4 intent employment, B5 follow-up resolution).
//
// Homed in venice/agents/ (not _shared/venice/) on purpose: the
// _shared/venice/ barrel re-exports every member and is wire-relay
// only (see _shared/venice.ts), and the StoredMessage type lives in
// ./_recall_helpers.ts - a _shared/venice module would need a
// shared-to-agents import direction the tree nowhere has (the
// precedent, _shared/thread-transcript.ts, defines its own row type
// instead).
//
// The caps are BUDGET-driven (clef-api's 32k-token state cap, ~4
// chars/token), not judgment-driven - that is the point where the
// "renderers deliberately not shared" convention
// (_shared/thread-transcript.ts:71-75) stops applying. Per consumer:
// the question builders, the coercion rules above the coercers here,
// and the transcript trim budget (trimToCharBudget at the call site -
// the trim was never part of the serializer).

import type { StoredMessage } from './_recall_helpers.ts';

// Per-row clip for transcript content. trimToCharBudget always keeps
// the last message even when it alone exceeds the budget; without
// this clip that row serializes whole, blows the 32k-token state cap,
// and the thread takes a deterministic-400 empty verdict instead of a
// judged one.
export const MAX_ROW_CHARS = 24_000;
// Per-tool-result body cap. Same figure as second_thoughts.ts'
// chat-path serializer cap - a coincidence of budgets, not a shared
// contract (that one caps a chat-turn serializer; this caps
// decision-call state).
export const MAX_TOOL_RESULT_CHARS = 4000;
// Per-tool-call argument cap in the rendered tool-call line. The lean
// is visible in WHICH tool ran and roughly with what; the full
// argument blob is not needed and can be huge.
export const MAX_TOOL_ARG_CHARS = 300;

// Cap on items judged per call (intents, follow-ups). The source sets
// are unbounded and the 32k-TOKEN budget is shared by state AND
// questions, so the question fan-out needs a ceiling. Excess items
// are logged by the caller and get no judgment this round.
export const DECISION_ITEM_CAP = 12;

// Shared ceiling for one decision call. A STALLED fetch is not an
// error fail-open can catch: an untimed judge call hangs its whole
// cycle (no mark, no log, the isolate dies at the hosted wall clock,
// the claim burns an attempt). 10s is ~25x the expected latency and
// far under any kill.
export const DECISION_CALL_TIMEOUT_MS = 10_000;

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...[clipped]` : text;
}

/**
 * Render one tool_calls array as a compact human-readable line list,
 * arguments capped (the lean is in the call, not the blob).
 */
export function renderToolCalls(raw: unknown[], argCap: number = MAX_TOOL_ARG_CHARS): string {
  const lines: string[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const fn = (c as { function?: { name?: unknown; arguments?: unknown } }).function;
    const name = typeof fn?.name === 'string' ? fn.name : 'unknown';
    const args = typeof fn?.arguments === 'string' ? fn.arguments : '';
    lines.push(`  - ${name}(${clip(args, argCap)})`);
  }
  return lines.join('\n');
}

export interface TranscriptCaps {
  rowChars?: number;
  toolResultChars?: number;
  toolArgChars?: number;
}

/**
 * Serialize a thread transcript into a single fenced string, carried
 * as decision-call STATE (data, not a chat turn) so nothing invites
 * the model to answer as a conversational voice. Role-tagged rows:
 * user and assistant content, tool calls as rendered lines,
 * tool-result bodies capped, fork-framing system rows verbatim
 * (short boundary context; the chat path sends them as system
 * messages).
 */
export function serializeTranscript(
  rows: readonly StoredMessage[],
  caps: TranscriptCaps = {},
): string {
  const rowChars = caps.rowChars ?? MAX_ROW_CHARS;
  const toolResultChars = caps.toolResultChars ?? MAX_TOOL_RESULT_CHARS;
  const toolArgChars = caps.toolArgChars ?? MAX_TOOL_ARG_CHARS;
  const parts: string[] = ['<transcript>'];
  for (const m of rows) {
    if (m.role === 'user') {
      parts.push(`[user]\n${clip(m.content ?? '', rowChars)}`);
    } else if (m.role === 'assistant') {
      const seg: string[] = ['[assistant]'];
      const body = (m.content ?? '').trim();
      if (body) seg.push(clip(body, rowChars));
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        seg.push(`(tool calls)\n${renderToolCalls(m.tool_calls, toolArgChars)}`);
      }
      parts.push(seg.join('\n'));
    } else if (m.role === 'tool') {
      const label = m.name ? `tool result: ${m.name}` : 'tool result';
      parts.push(`[${label}]\n${clip(m.content ?? '', toolResultChars)}`);
    } else {
      parts.push(`[system]\n${clip(m.content ?? '', rowChars)}`);
    }
  }
  parts.push('</transcript>');
  return parts.join('\n\n');
}

/** The answers map a /decisions response carries, shape-checked. */
export function answersOf(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') return null;
  return answers as Record<string, unknown>;
}

/** The noul probability under one question id, clamped to [0,1];
 *  null on any drift (the caller fails open). */
export function noulOf(answers: Record<string, unknown>, id: string): number | null {
  const answer = answers[id];
  if (!answer || typeof answer !== 'object') return null;
  const noul = (answer as { noul?: unknown }).noul;
  if (typeof noul !== 'number' || !Number.isFinite(noul)) return null;
  return Math.min(1, Math.max(0, noul));
}

/** The choice pick under one question id; null on any drift. */
export function choiceOf(answers: Record<string, unknown>, id: string): string | null {
  const answer = answers[id];
  if (!answer || typeof answer !== 'object') return null;
  const choice = (answer as { choice?: unknown }).choice;
  return typeof choice === 'string' ? choice : null;
}

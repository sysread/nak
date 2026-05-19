/**
 * UI-behavior primitives for the nested tool-call display
 * rendered inside an assistant bubble. Pure functions only - no
 * runes, no Svelte imports, no DOM. The companion
 * `src/components/ToolCalls.svelte` composes these with its own
 * framework-native reactivity (the `expanded` per-call rune,
 * the click-to-toggle handler) and the markup.
 *
 * Type imports from `$lib/tools` and `$lib/supabase` carry the
 * `OpenAIToolCall` and `Message` shapes the primitives operate
 * over.
 */
import type { OpenAIToolCall } from '../tools';
import type { Message } from '../supabase';

export type Status = 'pending' | 'ok' | 'error';

/**
 * Session-local timing for an in-flight or recently-completed
 * call. Shared by the parent's timings map and by `statusFor` /
 * `durationPill`.
 */
export interface CallTiming {
  startedAt: number;
  endedAt?: number;
  error?: boolean;
}

/**
 * Status decision tree for one call. Four sources, in
 * precedence:
 *
 *   - Session-local timing with no end: in flight while the
 *     session is still streaming (pending), or an orphaned
 *     cutoff once `sending` flips false (error).
 *   - Session-local timing with `error` set: definitively
 *     errored.
 *   - Replayed history (no timings): parse the result content.
 *     A JSON `error` key means failure; anything else (including
 *     non-JSON) is success.
 *   - Neither timing nor result: brief window during a streaming
 *     turn between the assistant message landing and the first
 *     onToolStart firing (pending), or an orphan tail once
 *     `sending` is false (error so the spinner does not
 *     animate forever).
 */
export function statusFor(
  callId: string,
  timings: Record<string, CallTiming>,
  resultsByCallId: Record<string, Message>,
  sending: boolean
): Status {
  const t = timings[callId];
  const result = resultsByCallId[callId];
  if (t && !t.endedAt) return sending ? 'pending' : 'error';
  if (t?.error) return 'error';
  if (result) {
    try {
      const parsed = JSON.parse(result.content) as unknown;
      if (
        parsed &&
        typeof parsed === 'object' &&
        'error' in (parsed as object)
      ) {
        return 'error';
      }
    } catch {
      // Non-JSON content is uncommon but fine - treat as success.
    }
    return 'ok';
  }
  return sending ? 'pending' : 'error';
}

/**
 * Live or final duration pill text. Empty string when no timing
 * exists (replayed history - historical latency wasn't worth
 * persisting). Final duration when the call ended; otherwise a
 * live elapsed counter against the parent's monotonic `nowMs`.
 */
export function durationPill(
  callId: string,
  timings: Record<string, CallTiming>,
  nowMs: number
): string {
  const t = timings[callId];
  if (!t) return '';
  if (t.endedAt !== undefined) {
    return `${Math.round(t.endedAt - t.startedAt)} ms`;
  }
  const elapsed = Math.max(0, Math.round(nowMs - t.startedAt));
  return `${elapsed} ms`;
}

/**
 * Pretty-print a JSON string for the markdown fence. Falls back
 * to the raw string if parsing fails - the LLM occasionally
 * emits invalid JSON and we still want to show what it sent.
 */
export function prettyJson(raw: string): string {
  if (!raw) return '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/**
 * The `arguments` JSON wrapped in a `json` markdown fence so
 * `<Markdown>` can hand it to highlight.js. Empty arguments
 * default to `{}` so the fence has something well-formed inside.
 */
export function fencedArgs(call: OpenAIToolCall): string {
  return '```json\n' + prettyJson(call.function.arguments || '{}') + '\n```';
}

/**
 * The tool-result content wrapped in a `json` fence, or the
 * in-progress placeholder when the result has not yet landed.
 * The placeholder italics render via the markdown's emphasis
 * pass.
 */
export function fencedResult(
  callId: string,
  resultsByCallId: Record<string, Message>
): string {
  const result = resultsByCallId[callId];
  if (!result) return '_In progress…_';
  return '```json\n' + prettyJson(result.content) + '\n```';
}

/**
 * Pull the narration sentence out of a call's arguments JSON.
 * Returns null when:
 *   - the key is missing (older persisted calls from before the
 *     `activity` injection existed, or a streaming call whose
 *     arguments have not finished arriving),
 *   - the value is not a string,
 *   - or the value is empty after trim.
 *
 * Callers fall back to the legacy tool-name-primary layout when
 * this returns null.
 */
export function activityFor(call: OpenAIToolCall): string | null {
  const raw = call.function.arguments;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && 'activity' in parsed) {
      const value = (parsed as { activity: unknown }).activity;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
      }
    }
  } catch {
    // Partial JSON during streaming is expected; the activity
    // will appear on the next render once the fragments close.
  }
  return null;
}

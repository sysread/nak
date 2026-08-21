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
import { getToolFormatters } from '../tools';
import type { OpenAIToolCall, ToolFormatters } from '../tools';
import type { Message } from '../supabase';
import { formatJsonStringAsMarkdown } from './tool-format';

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
 * Status decision tree for one call. Five sources, in
 * precedence:
 *
 *   - Session-local timing with no end: in flight while the
 *     session is still streaming (pending), or an orphaned
 *     cutoff once `sending` flips false (error).
 *   - Session-local timing with `error` set: definitively
 *     errored.
 *   - Session-local timing with `endedAt` set and no error:
 *     the wire tool_call_response event already confirmed the
 *     dispatcher returned a non-error outcome. Treat as ok
 *     even if the persisted tool-result row hasn't propagated
 *     via the messages realtime subscription yet. Without this
 *     branch, the post-END window (sending=false, result row
 *     still in flight) renders the card with a red X on a tool
 *     that actually worked.
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
  // A timing with no end only means THIS SESSION never saw the finish
  // - the server-side dispatch keeps running through a Stop, and its
  // persisted result row can land afterwards (realtime or reload).
  // When that row exists, classify from its content below instead of
  // from the stale local timing; without the `!result` guard a
  // stopped-but-actually-successful tool rendered a red X forever.
  if (t && !t.endedAt && !result) return sending ? 'pending' : 'error';
  if (t?.error) return 'error';
  if (t?.endedAt) return 'ok';
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
 * View mode for the tool-call detail panel. `markdown` is the
 * default human-readable rendering (`tool-format.ts`'s
 * TOML-ish output, or a per-tool override when the tool's
 * schema declared one); `json` is the raw pretty-printed JSON
 * fence, useful when the user wants the wire shape. The toggle
 * lives in `ToolCalls.svelte` and is per-call - one row can be
 * in markdown view while another sits in JSON.
 */
export type DetailView = 'markdown' | 'json';

/**
 * Render the `arguments` JSON for the detail panel. In `json`
 * mode the output is a `json`-fenced block (highlight.js
 * styling); in `markdown` mode we prefer the tool's own
 * `formatArgs` override when declared and fall back to the
 * generic JSON-as-markdown formatter otherwise. Empty arguments
 * default to `{}` so the parse never throws.
 */
export function renderArgs(
  call: OpenAIToolCall,
  view: DetailView,
  formatters: ToolFormatters | undefined
): string {
  const raw = call.function.arguments || '{}';
  if (view === 'json') {
    return '```json\n' + prettyJson(raw) + '\n```';
  }
  if (formatters?.formatArgs) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return formatters.formatArgs(parsed);
    } catch {
      // Partial-stream args or malformed JSON: fall through to
      // the generic path, which shows the raw text in a fence
      // rather than crashing the panel.
    }
  }
  return formatJsonStringAsMarkdown(raw);
}

/**
 * Render the tool-result content for the detail panel. Same
 * shape as `renderArgs`: JSON-fenced in `json` mode; in
 * `markdown` mode we honour the tool's `formatResult` override
 * when present and fall back to the generic formatter. The
 * "in progress" placeholder is identical in both views - there's
 * no payload yet to differ on.
 */
export function renderResult(
  callId: string,
  resultsByCallId: Record<string, Message>,
  view: DetailView,
  formatters: ToolFormatters | undefined
): string {
  const result = resultsByCallId[callId];
  if (!result) return '_In progress…_';
  if (view === 'json') {
    return '```json\n' + prettyJson(result.content) + '\n```';
  }
  if (formatters?.formatResult) {
    try {
      const parsed = JSON.parse(result.content) as unknown;
      return formatters.formatResult(parsed);
    } catch {
      // Non-JSON tool returns are uncommon but valid; let the
      // generic path render the raw string as a fenced block.
    }
  }
  return formatJsonStringAsMarkdown(result.content);
}

/**
 * Default view mode for a freshly-expanded call. Markdown is
 * the readable shape we want users to land on; the toggle in
 * the detail panel flips it to JSON for the wire-shape case.
 */
export const DEFAULT_DETAIL_VIEW: DetailView = 'markdown';

/**
 * Flip the current view to the other side. Centralised so the
 * `.svelte` file's button handler stays a one-liner and so the
 * two-state set is the only thing this module exports.
 */
export function flipDetailView(current: DetailView): DetailView {
  return current === 'markdown' ? 'json' : 'markdown';
}

/**
 * Resolve the tool's per-call formatter overrides at render
 * time. The lookup goes through the eagerly-loaded tool
 * registry, so it doesn't pull in any lazy impl chunks - the
 * `formatArgs` / `formatResult` fields ride on the schema half
 * of the ToolDef. Returns `undefined` for unknown tool names
 * (renamed/removed tools in persisted history); the renderer
 * falls back to the generic formatter in that case.
 */
export function formattersFor(name: string): ToolFormatters | undefined {
  return getToolFormatters(name);
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

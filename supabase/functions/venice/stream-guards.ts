// Output guards armed for the function-side streaming chat path. This
// file is the Deno-side mirror of src/lib/stream-guards.ts (browser):
// same special-token-leak detector, same retry-temperature schedule,
// same model arming decision - but operating on the Venice wire body
// rather than the browser's ChatRequest type, and with the leaky-model
// list duplicated here so the function does not need to reach into the
// browser's models registry.
//
// Why duplicated rather than shared: the model arming list is small
// (a handful of DeepSeek/llama-family ids today) and the StreamGuard
// interface in ../_shared/venice-stream.ts is the load-bearing
// contract both sides honor. Concrete guard impls are allowed to
// diverge; only the interface and the `name` strings must match so
// `guard_retry` events on the Broadcast channel mean the same thing
// to a browser consumer regardless of which side fired them. If the
// arming list grows or the guard logic gets non-trivial enough that
// drift becomes a real risk, fold this file into a shared module then.

import type {
  AttemptProgress,
  GuardVerdict,
  StreamGuard,
} from '../_shared/venice-stream.ts';

/**
 * Temperature to force on each retry, indexed by attempt-1 (the first
 * retry uses index 0). A re-roll at the original (often-zero)
 * temperature would re-emit the identical glitch, so each retry trades
 * some determinism for sampling variation. The first attempt is left at
 * whatever the caller set - a healthy turn pays no temperature
 * distortion; only the salvage re-rolls do. Mirrors the browser values.
 */
const RETRY_TEMPERATURE_SCHEDULE: readonly number[] = [0.8, 1.0];

/**
 * Leading delimiters of leaked model special tokens. DeepSeek tokens
 * open with `<` immediately followed by U+FF5C FULLWIDTH VERTICAL LINE
 * (e.g. `<｜begin▁of▁sentence｜>`); llama-family tokens open with `<`
 * and an ASCII pipe (`<|eot_id|>`, `<|python_tag|>`). Matching the
 * two-character opener catches the whole class of a family in one
 * check, including tokens we have not enumerated, because stop / begin
 * / role tokens all share the opener.
 *
 * Anchored to the OPENING of the response - the leak streams as
 * ordinary text starting at position 0 with no reasoning and no tool
 * call preceding it. A response that legitimately discusses these
 * tokens later in the body is never caught.
 */
const SPECIAL_TOKEN_LEAK_PREFIXES: readonly string[] = ['<｜', '<|'];

const MAX_LEAK_PREFIX_LEN = Math.max(
  ...SPECIAL_TOKEN_LEAK_PREFIXES.map((p) => p.length),
);

function leftTrim(s: string): string {
  return s.replace(/^\s+/, '');
}

/** True when `text` (already left-trimmed) opens with a known leak delimiter. */
export function startsWithSpecialTokenLeak(text: string): boolean {
  return SPECIAL_TOKEN_LEAK_PREFIXES.some((p) => text.startsWith(p));
}

/**
 * True when `text` is too short to rule out becoming a leak opener once
 * more deltas arrive (e.g. a bare `<` that might be followed by U+FF5C).
 * Keeps the wrapper buffering one more event instead of prematurely
 * committing to a reply that might still turn out to be a leak.
 */
function couldStillBecomeLeak(text: string): boolean {
  if (text.length === 0 || text.length >= MAX_LEAK_PREFIX_LEN) return false;
  return SPECIAL_TOKEN_LEAK_PREFIXES.some((p) => p.startsWith(text));
}

/**
 * Guard for the leaked-special-token failure mode. Verdict logic, in
 * order:
 *
 *   - any reasoning or tool-call output -> 'keep'. A leak opens with
 *     its token at position 0 with no reasoning and no tool call.
 *   - visible text opens with a leak delimiter -> 'retry'.
 *   - no visible text yet -> 'undecided' until the stream ends, then
 *     'keep'. An empty completion is not this guard's concern.
 *   - a bare partial that could still become a leak opener ->
 *     'undecided' (buffer one more delta).
 *   - otherwise -> 'keep'.
 *
 * On retry: bump the wire body's temperature per the schedule so the
 * sampler actually varies.
 */
export function specialTokenLeakGuard(): StreamGuard {
  return {
    name: 'special-token-leak',
    verdict(p: AttemptProgress): GuardVerdict {
      if (p.sawReasoning || p.sawToolCall) return 'keep';
      const text = leftTrim(p.visibleText);
      if (startsWithSpecialTokenLeak(text)) return 'retry';
      if (text.length === 0) return p.ended ? 'keep' : 'undecided';
      if (!p.ended && couldStillBecomeLeak(text)) return 'undecided';
      return 'keep';
    },
    prepareRetry(
      body: Record<string, unknown>,
      attempt: number,
    ): Record<string, unknown> {
      const idx = Math.min(attempt - 1, RETRY_TEMPERATURE_SCHEDULE.length - 1);
      return { ...body, temperature: RETRY_TEMPERATURE_SCHEDULE[idx] };
    },
  };
}

/**
 * Concrete Venice model ids known to leak their own special tokens when
 * streamed. Mirrors `leaksSpecialTokens: true` on the per-model entries
 * in the browser's src/lib/models registry. Keep this list in sync
 * deliberately: any new model added to the browser registry with the
 * flag set must also land here, or the function will not arm the guard
 * and the failure mode reappears.
 *
 * Source of truth check: grep `leaksSpecialTokens: true` under
 * src/lib/models/ and confirm every match is mirrored here.
 */
const LEAKY_MODEL_IDS: ReadonlySet<string> = new Set<string>([
  // DeepSeek family - emits `<｜begin▁of▁sentence｜>` on first token in
  // the observed regression. Add new family members here when they
  // start exhibiting the same behavior.
  'deepseek-v4-flash',
  'deepseek-v4',
]);

/**
 * Returns the guards to arm for a given concrete model id. A model
 * gets the special-token guard exactly when it is flagged as leaking.
 * Models with no configured gotchas get an empty list and the
 * getStreamingCompletion wrapper degenerates to a pass-through with
 * no buffering overhead.
 */
export function streamGuardsForModel(modelId: string): StreamGuard[] {
  if (LEAKY_MODEL_IDS.has(modelId)) {
    return [specialTokenLeakGuard()];
  }
  return [];
}

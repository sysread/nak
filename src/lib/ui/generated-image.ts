/**
 * UI-behavior primitives for the dedicated generated-image card that
 * renders directly below a `generate_image` tool-call card. Pure
 * functions only - no runes, no Svelte, no DOM. The companion
 * `src/components/GeneratedImageCard.svelte` owns the by-filename
 * resolution effect and the markup; `Chat.svelte`'s message-block
 * builder calls `generatedImagesForGroup` to turn an assistant
 * tool-group row into zero or more card descriptors.
 *
 * Why a dedicated card instead of the generic per-message attachment
 * slot: generate_image attaches its output to the round's
 * assistant-with-tool-calls row server-side, AFTER that row was already
 * inserted and echoed over the messages realtime channel. The
 * `message_attachments` insert fires no `messages` realtime event, so
 * the producing tab's in-memory row never re-hydrated with the
 * attachment - the image only appeared after a full page reload. The
 * card resolves the image itself by filename, bypassing the realtime
 * nudge that never comes, and shows a placeholder sized to the image's
 * aspect ratio until the bytes resolve.
 */
import type { Message } from '../supabase';
import type { OpenAIToolCall } from '../tools';

export const GENERATE_IMAGE_TOOL_NAME = 'generate_image';

export interface GeneratedImageDescriptor {
  /** tool_call_id - stable key for the keyed #each loop. */
  key: string;
  /** Filename the orchestrator minted; the card resolves the image by it. */
  filename: string;
  /** CSS `aspect-ratio` for the placeholder box, e.g. "16 / 9". */
  aspectRatio: string;
}

interface ParsedResult {
  filename: string;
  width: number;
  height: number;
}

/**
 * Parse a generate_image tool-result row's content into the image
 * descriptor. Returns null for any shape that isn't a successful
 * generation: a failed call carries an `error` key and no filename, a
 * partial/streamed row may be empty, and malformed JSON parses to
 * nothing - all of which yield null so the card is simply not emitted
 * (the failed tool-call card already conveys the failure).
 */
export function parseGeneratedImageResult(
  content: string
): ParsedResult | null {
  if (!content) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.filename !== 'string' || o.filename.length === 0) return null;
  // Dimensions are best-effort - older rows or a provider that didn't
  // echo them fall back to a square box in aspectRatioCss.
  const width = typeof o.width === 'number' ? o.width : 0;
  const height = typeof o.height === 'number' ? o.height : 0;
  return { filename: o.filename, width, height };
}

/**
 * CSS `aspect-ratio` value from pixel dimensions. Falls back to a
 * square when either dimension is missing or non-positive so the
 * placeholder box always has a defined shape and the card doesn't
 * reflow when the resolved image replaces it.
 */
export function aspectRatioCss(width: number, height: number): string {
  if (width > 0 && height > 0) return `${width} / ${height}`;
  return '1 / 1';
}

/**
 * Walk an assistant tool-group row's tool_calls and emit one
 * descriptor per successful generate_image call. A call with no
 * result row yet, or a failed/unparseable result, is skipped - the
 * card appears once the descriptor is known (filename + dims), which
 * is exactly when the tool-result row lands. Order follows the
 * tool_calls order so multiple generations in one turn render top to
 * bottom in call order.
 */
export function generatedImagesForGroup(
  calls: readonly OpenAIToolCall[],
  resultsByCallId: Record<string, Message>
): GeneratedImageDescriptor[] {
  const out: GeneratedImageDescriptor[] = [];
  for (const call of calls) {
    if (call.function.name !== GENERATE_IMAGE_TOOL_NAME) continue;
    const result = resultsByCallId[call.id];
    if (!result) continue;
    const parsed = parseGeneratedImageResult(result.content);
    if (!parsed) continue;
    out.push({
      key: call.id,
      filename: parsed.filename,
      aspectRatio: aspectRatioCss(parsed.width, parsed.height),
    });
  }
  return out;
}

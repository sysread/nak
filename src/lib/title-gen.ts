/**
 * Background title-generation pipeline. Runs in parallel with the main
 * chat-loop on the opening turn of a fresh thread so the conversation
 * picks up a topical title before the model is done streaming its
 * reply.
 *
 * Why not let the main model do this through `update_title`: the main
 * chat-loop's metadata system message used to nag the model to rename
 * on round 1, but that load made the first reply slower and noisier -
 * the rename instruction competed with the actual task framing, and
 * a placeholder-titled thread would sometimes ship a turn or two
 * before the model got around to the tool call. Pulling title-gen
 * out into a dedicated single-shot completion against a small fast
 * model (gpt-oss 20b via Venice's e2ee tier) means the title lands
 * regardless of what the main model is busy doing, and the wire load
 * on the main turn drops by exactly one nag block.
 *
 * Shape: one Venice `completeChat` call against `agentModel('autoTitle')`,
 * with a tiny dedicated system prompt and the user's typed text as
 * the prompt. No tools, no history, no priming, no recall context.
 * `disableThinking: true` because the underlying model is reasoning-
 * capable and we want the title text directly, not a CoT preamble.
 * The output is sanitised through the same helper the `update_title`
 * tool uses (trim, strip surrounding quotes / trailing punctuation,
 * cap length) so manual + automatic + tool-driven renames all land
 * with the same shape.
 *
 * Failure model: best-effort. A network failure, a Venice 4xx, an
 * abort - any of these resolve `null` and the caller logs once and
 * moves on. The main chat-loop's metadata message will fire the
 * fallback nag on round 2 if the title is still the placeholder by
 * then, so a failed background completion just delays the rename by
 * one round at worst.
 */
import type { VeniceClient } from './venice';
import { agentModel } from './models';
import { sanitizeTitle } from './tools/update_title';
import { createLogger } from './logger.svelte';

const log = createLogger('auto-title');

/**
 * System prompt for the title-gen sub-call. Short on purpose: the
 * task is bounded and the model just needs to know to emit the
 * title verbatim rather than wrapping it in conversational scaffold.
 * Editing this changes auto-titling on every fresh thread, so
 * treat it as a voice-tuning change.
 */
const TITLE_GEN_SYSTEM_PROMPT = [
  'Read the user message below and return a 3-6 word title for the',
  'conversation it would open. Plain text, no quotes, no trailing',
  'punctuation, no preamble. Title-case is fine but not required.',
  'If the message is a greeting or pleasantry, look past it to the',
  'underlying topic the user actually wants to discuss; only fall',
  "back to a generic title (\"Casual chat\", \"Quick question\") when",
  'no topic is recoverable.',
].join('\n');

/**
 * Single-shot title generation from the opening user message. Returns
 * the sanitised title on success, `null` on any failure or empty
 * output. Callers fire-and-forget this and persist the title only
 * when the resolved value is non-null AND the thread is still on the
 * placeholder (someone else, the model via `update_title` or the
 * user via the rename input, may have beaten us to it).
 *
 * `signal` is the caller's abort - typically the same controller that
 * scopes the parent send(). Aborting cancels the in-flight Venice
 * call cleanly; an aborted call resolves null rather than throwing
 * so the caller's await doesn't need a try/catch.
 */
export async function generateThreadTitle(
  venice: VeniceClient,
  userText: string,
  signal: AbortSignal,
): Promise<string | null> {
  const trimmed = userText.trim();
  if (trimmed.length === 0) return null;

  try {
    const result = await venice.completeChat({
      model: agentModel('autoTitle').id,
      messages: [
        { role: 'system', content: TITLE_GEN_SYSTEM_PROMPT },
        { role: 'user', content: trimmed },
      ],
      signal,
      // Reasoning kill switch: the underlying model is reasoning-
      // capable and would otherwise burn its output budget on a CoT
      // preamble. Bounded task with a tiny answer; we want the title
      // text directly. Same discipline the web_search and
      // research_docs tools use against reasoning models.
      disableThinking: true,
      // Tight budget. A 3-6 word title can't exceed 80 chars after
      // sanitisation (TITLE_MAX_CHARS); 64 raw tokens covers that
      // with headroom for the model emitting a slightly longer
      // string the sanitiser then trims.
      maxTokens: 64,
    });
    const title = sanitizeTitle(result.text);
    if (title.length === 0) {
      log.warn('completion produced no usable title');
      return null;
    }
    return title;
  } catch (err) {
    if (signal.aborted) return null;
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(`title generation failed: ${detail}`);
    return null;
  }
}

/**
 * Single-shot title generator. Used by the auto-title worker (see
 * `src/lib/agents/auto_title/`) to name threads still on the
 * `'New conversation'` placeholder. Previously called fire-and-
 * forget from `Chat.svelte`'s send() on the opening turn; that path
 * lost work whenever the user closed or refreshed the tab before the
 * single Venice call resolved, so titling moved into a polling
 * worker that retries until the row is named.
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
 * moves on. The auto-title worker treats a null return as 'no-title',
 * releases the per-thread claim so the row goes back to the queue,
 * and the next cycle retries. The chat-loop's round-2+ metadata-
 * message nag is a further fallback when the worker hasn't yet
 * polled the row.
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
      // Project-wide 2048 floor for agent sub-calls (see commit
      // 21d990d). The earlier 64-token cap here was a regression: it
      // assumed the "3-6 word" prompt + disable_thinking would fully
      // bound the output, but gpt-oss-20b sometimes emits a CoT
      // preamble or ignores the length instruction, and the cap got
      // hit mid-word - threads landed with titles like "troubleshooting
      // the" instead of "Troubleshooting the refrigerator". The prompt
      // is what controls answer length; sanitizeTitle's first-line
      // + 80-char slice is what enforces it on the storage side. The
      // wire cap just needs enough headroom that finish_reason
      // doesn't become 'length' on a chatty completion.
      maxTokens: 2048,
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

/**
 * The intuition pipeline. Three stages:
 *
 *   1. Perception - one fast-model call. Reads the transcript,
 *      classifies the prompt, and produces an objective-observer
 *      summary.
 *   2. Drive reactions - five fast-model calls in parallel. Each
 *      takes the perception as input and produces a first-person
 *      reaction in the voice of its drive.
 *   3. Synthesis - one fast-model call. Aggregates the drive
 *      reactions into a single internal monologue prompt that primes
 *      the conscious agent's response.
 *
 * Total calls: 7 (1 + 5 + 1) on the fast tier, with the 5 drives
 * running concurrently. End-to-end latency is dominated by stages 1
 * and 3 plus the slowest drive call - typically 3 sequential
 * roundtrips on the fast model.
 *
 * The pipeline is non-streaming. Each stage hits Venice's one-shot
 * completion endpoint via `venice.completeChat` and reads the single
 * text result, mirroring the same pattern the samskara agent uses
 * (see src/lib/agents/samskara/agent.ts).
 *
 * Failure model:
 *   - Perception failure aborts the pipeline. Returns null so the
 *     caller leaves the prior cache in place.
 *   - Per-drive failures are tolerated: a drive that errors or
 *     returns empty is omitted from the payload's `drives` map. The
 *     synthesis step still runs against whatever drives did
 *     respond.
 *   - Synthesis failure aborts. Returns null.
 *
 * Why tolerate drive failures: the synthesis prompt is robust to
 * uneven input and we'd rather ship a slightly less-rounded
 * intuition than block the conscious response over one drive call
 * timing out. Falling back to the prior cache on a partial failure
 * would mean a stale read drives the next several turns even after
 * the underlying state has shifted.
 */
import type { VeniceClient, VeniceMessage } from '../venice';
import { VeniceError } from '../venice';
import { createLogger } from '../logger.svelte';
// The bulky template strings (PERCEPTION_PROMPT, SYNTHESIS_PROMPT,
// DRIVE_BASE_PROMPT, DRIVE_PROMPTS) and DRIVE_NAMES live in
// `./prompts`; they are only read when a turn actually triggers the
// pipeline. Dynamic-importing them inside runIntuitionPipeline keeps
// the ~10 kB raw prompt module out of the main chunk - chat-loop's
// static import of `runIntuitionPipeline` itself stays cheap.
import type { DriveName } from './prompts';
import type { IntuitionPayload, IntuitionTrigger } from './types';

const log = createLogger('intuition');

/**
 * Drive a single non-streaming Venice completion. Same pattern the
 * samskara and summary agents use; reasoning content on the response
 * is ignored, only the body text contributes.
 *
 * disableThinking is non-negotiable: the fast tier currently routes
 * to GLM-4.7, a reasoning model that by default emits chain-of-
 * thought through `reasoning_content` BEFORE writing any text into
 * `content`. Even with the 2048 floor we keep `disableThinking` set
 * so the budget goes to the answer instead of a CoT preamble that
 * sometimes still runs long enough to eat the cap. Web_search hit
 * the same trap and fixed it the same way; for an internal-
 * monologue prompt the reasoning pass wouldn't have added much
 * anyway.
 */
async function callOnce(
  venice: VeniceClient,
  model: string,
  systemPrompt: string,
  userContent: string,
  signal: AbortSignal,
  maxTokens: number
): Promise<string> {
  const result = await venice.completeChat({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    maxTokens,
    disableThinking: true,
    signal,
  });
  return result.text.trim();
}

/**
 * Build the perception input - the conversation transcript that the
 * objective-observer reads. We strip system messages (they're framing,
 * not conversation) and tool messages (they're internal plumbing the
 * user never sees), and render user/assistant turns as a plain
 * "<role> said: <content>" sequence. Mirrors fnord's transcript
 * builder.
 *
 * Multimodal user messages (image attachments) flatten to the text
 * parts only - the perception agent doesn't read images, and a
 * paragraph saying "the user attached a screenshot of their
 * spreadsheet" wouldn't add anything the text parts don't already
 * hint at. If the user asked a question with no text and only an
 * image, the perception will read the assistant's response as the
 * primary signal, which is acceptable degradation.
 */
function buildTranscript(history: readonly VeniceMessage[]): string {
  const lines: string[] = [];
  for (const m of history) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = stringContent(m.content);
    if (text.length === 0) continue;
    lines.push(`${m.role} said: ${text}`);
  }
  return lines.join('\n\n');
}

function stringContent(content: VeniceMessage['content']): string {
  if (typeof content === 'string') return content;
  // Multimodal array: keep text parts, ignore image parts.
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/**
 * Normalize the perception output to guarantee a leading
 * "Classification: <category>" line. The perception prompt asks for
 * it, but fast models occasionally elide structured prefixes; the
 * synthesis step's first-person classification acknowledgment has
 * nothing to read in that case. Prepending an "ambiguous" marker
 * matches the existing taxonomy and carries no behavioral branch on
 * the conscious side - same fallback fnord uses.
 */
function ensureClassificationPrefix(raw: string): string {
  if (/^\s*Classification:\s*\S+/i.test(raw)) return raw;
  return `Classification: ambiguous\n\n${raw}`;
}

export interface RunIntuitionInputs {
  venice: VeniceClient;
  /** Concrete Venice model id. Caller resolves the fast tier. */
  model: string;
  /** History up to and including the most recent user message; same
   *  shape the chat-loop passes. The pipeline is read-only on this
   *  array - it does not mutate or extend. */
  history: readonly VeniceMessage[];
  signal: AbortSignal;
  /** Round id (= count of user messages in history) at run time. */
  round: number;
  /** Mood snapshot at run time, or null when no mood is available
   *  (cold start, mood-clear thread). */
  mood: { band: number; column: 'confident' | 'tentative' } | null;
  /** Why this run was scheduled. Persisted on the payload for
   *  observability and surfaced in the modal. */
  trigger: IntuitionTrigger;
}

/**
 * Run the full pipeline. Returns the cache-ready payload, or null on
 * an unrecoverable failure (perception or synthesis errored). Caller
 * is responsible for persisting the payload to the thread row -
 * see ./cache.ts.
 *
 * Cancellation: every Venice call threads the inputs.signal through.
 * An aborted pipeline returns null; partial drive results from a
 * mid-pipeline abort are discarded (we don't ship a half-aggregated
 * payload).
 */
export async function runIntuitionPipeline(
  inputs: RunIntuitionInputs
): Promise<IntuitionPayload | null> {
  const { venice, model, history, signal, round, mood, trigger } = inputs;
  const startedAt = Date.now();
  // Log at info so a user troubleshooting "the brain icon never
  // showed" can see whether the pipeline ever started. The matching
  // success/failure lines below close the round.
  log.info('pipeline starting', { trigger, round });

  const transcript = buildTranscript(history);
  if (transcript.length === 0) {
    // Empty transcript = nothing to perceive. Caller's debounce
    // should normally avoid this, but we'd rather degrade gracefully
    // than throw on a freshly-minted thread.
    log.warn('skipped pipeline: empty transcript');
    return null;
  }

  // Pull the prompt strings + drive list at run time; see the
  // file-level comment for why this is dynamic.
  const {
    PERCEPTION_PROMPT,
    SYNTHESIS_PROMPT,
    DRIVE_BASE_PROMPT,
    DRIVE_PROMPTS,
    DRIVE_NAMES,
  } = await import('./prompts');

  // Stage 1: perception. 2048 is the project-wide floor on agent
  // sub-call caps (see CLAUDE.md / analyze_image post-mortem); a
  // routine turn lands around 80-150 tokens, so the cap is mostly
  // headroom against an unusual situation where the model wants to
  // write a longer paragraph without truncating mid-thought.
  let perceptionRaw: string;
  try {
    perceptionRaw = await callOnce(
      venice,
      model,
      PERCEPTION_PROMPT,
      transcript,
      signal,
      2048
    );
  } catch (err) {
    if (err instanceof VeniceError && err.kind === 'rate_limit') {
      log.warn('perception rate-limited; leaving prior cache in place');
    } else {
      log.warn('perception failed', err);
    }
    return null;
  }
  if (perceptionRaw.length === 0) {
    log.warn('perception returned empty text');
    return null;
  }
  const perception = ensureClassificationPrefix(perceptionRaw);
  log.debug('perception', { perception });

  // Stage 2: drive reactions in parallel. Each drive sees the
  // perception (not the raw transcript) so all five react to the
  // same digest - matches fnord's structure.
  const drivePromises = DRIVE_NAMES.map(
    async (name): Promise<[DriveName, string | null]> => {
      const systemPrompt = `${DRIVE_BASE_PROMPT}\n\n${DRIVE_PROMPTS[name]}`;
      try {
        // 2048 is the project-wide floor on agent sub-call caps. The
        // prompt's 2-3 sentence target lands well under that; the
        // headroom only matters when an alarmed drive earns the air
        // to push harder.
        const text = await callOnce(
          venice,
          model,
          systemPrompt,
          `# My perception of the discussion:\n${perception}`,
          signal,
          2048
        );
        if (text.length === 0) return [name, null];
        log.debug(`drive:${name}`, { reaction: text });
        return [name, text];
      } catch (err) {
        log.warn(`drive:${name} failed`, err);
        return [name, null];
      }
    }
  );
  const driveResults = await Promise.all(drivePromises);

  if (signal.aborted) return null;

  const drives: Partial<Record<DriveName, string>> = {};
  for (const [name, text] of driveResults) {
    if (text !== null) drives[name] = text;
  }
  // If every drive failed, we have no input for synthesis. Bail
  // rather than synthesize against an empty array - the result
  // would be vacuous.
  if (Object.keys(drives).length === 0) {
    log.warn('all drive reactions failed; skipping synthesis');
    return null;
  }

  // Stage 3: synthesis. Perception and drives both ride in a single
  // user message; the model's reply IS the synthesis. An earlier
  // shape passed drives in an assistant-role message (mirroring
  // fnord's "drives are the model's own internal voices already
  // speaking" framing), but the fast tier (GLM-4.7 via Venice) on
  // this conversation-shape was returning the SYNTHESIS_PROMPT body
  // verbatim as its content - the model parsed "ends with assistant"
  // as a prefix-completion / template-quirk situation and echoed the
  // system prompt instead of producing a synthesis. The user saw
  // the prompt rendered in both the intuition card and the
  // diagnostics modal. Folding drives into the user turn keeps the
  // shape conventional (system + single user) and the model produces
  // a normal assistant reply.
  const drivesText = DRIVE_NAMES.map((n) => drives[n])
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join('\n\n');

  let synthesisRaw: string;
  try {
    const result = await venice.completeChat({
      model,
      messages: [
        { role: 'system', content: SYNTHESIS_PROMPT },
        {
          role: 'user',
          content:
            `# Perception\n${perception}\n\n` +
            `# Drive Reactions\n${drivesText}`,
        },
      ],
      // 2048 is the project-wide floor on agent sub-call caps. The
      // prompt's 2-3 sentence target lands well under that; the
      // prompt itself is what discourages rambling, not the cap.
      maxTokens: 2048,
      // Same rationale as callOnce above - the fast tier is a
      // reasoning model and we cannot afford to spend the maxTokens
      // budget on a CoT preamble that never reaches the content
      // field.
      disableThinking: true,
      signal,
    });
    synthesisRaw = result.text.trim();
  } catch (err) {
    if (err instanceof VeniceError && err.kind === 'rate_limit') {
      log.warn('synthesis rate-limited; leaving prior cache in place');
    } else {
      log.warn('synthesis failed', err);
    }
    return null;
  }
  if (synthesisRaw.length === 0) {
    log.warn('synthesis returned empty text');
    return null;
  }
  // Belt-and-braces guard against the prompt-echo failure mode the
  // user-message-only shape was supposed to fix: if the model ever
  // returns the synthesis prompt verbatim again (or any leading slab
  // of it), bail rather than persist the prompt as the synthesis.
  // The first sentence of SYNTHESIS_PROMPT is a stable substring
  // unlikely to appear in any genuine synthesis output - it names
  // both "AI agent" and "Subconsciousness" in one sentence, neither
  // of which the synthesis itself should ever use (the prompt
  // explicitly forbids referring to the synthesis process).
  if (synthesisRaw.includes('You are the Subconsciousness')) {
    log.warn(
      'synthesis echoed the system prompt; treating as failure',
      synthesisRaw.slice(0, 80)
    );
    return null;
  }
  log.debug('synthesis', { synthesis: synthesisRaw });

  const payload: IntuitionPayload = {
    v: 1,
    perception,
    drives,
    synthesis: synthesisRaw,
    computed_at_round: round,
    computed_at_band: mood?.band ?? null,
    computed_at_column: mood?.column ?? null,
    computed_at_at: Date.now(),
    trigger,
  };
  // Companion to the "pipeline starting" log above. The drive count
  // matters: less than five means at least one drive call failed (rate
  // limit, parse error) and the synthesis ran on a partial set. Less
  // than three is a signal the run is starved enough to be worth
  // investigating - the synthesis prompt holds up but the texture
  // drops off.
  log.info('pipeline complete', {
    trigger,
    round,
    drivesAvailable: Object.keys(drives).length,
    elapsedMs: Date.now() - startedAt,
  });
  return payload;
}

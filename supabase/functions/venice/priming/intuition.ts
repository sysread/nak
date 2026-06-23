// The intuition turn-entry priming pipeline - the canonical
// implementation, run inside the venice edge function (extracted from the
// browser during the priming relocation). Three stages:
//
//   1. Perception - one fast-model call. Reads the transcript,
//      classifies the prompt, and produces an objective-observer
//      summary.
//   2. Drive reactions - five fast-model calls in parallel. Each takes
//      the perception as input and produces a first-person reaction in
//      the voice of its drive.
//   3. Synthesis - one fast-model call. Aggregates the drive reactions
//      into a single internal monologue that primes the conscious
//      agent's response.
//
// Total calls: 7 (1 + 5 + 1) on the fast tier, with the 5 drives running
// concurrently. The pipeline is non-streaming - each stage hits Venice's
// one-shot completion endpoint and reads the single text result.
//
// Failure model:
//   - Perception failure aborts the pipeline. Returns null so the
//     orchestrator leaves the prior cache in place.
//   - Per-drive failures are tolerated: a drive that errors or returns
//     empty is omitted from the payload's `drives` map. Synthesis still
//     runs against whatever drives did respond.
//   - Synthesis failure aborts. Returns null.
//
// The orchestrator owns trigger evaluation, cache read, and persistence;
// this module only runs the pipeline and returns a fresh payload.

import { type SupabaseClient } from '@supabase/supabase-js';
import { type EdgeLogger } from '../../_shared/edge-log.ts';
import { type IntuitionTrigger } from '../../_shared/priming-triggers.ts';
import { veniceComplete, VeniceError } from '../../_shared/venice.ts';
import {
  DRIVE_BASE_PROMPT,
  DRIVE_NAMES,
  type DriveName,
  DRIVE_PROMPTS,
  PERCEPTION_PROMPT,
  SYNTHESIS_PROMPT,
} from './intuition-prompts.ts';
import { type IntuitionPayload } from './intuition-payload.ts';

// admin is currently unused inside the pipeline body (the orchestrator
// owns the DB read/write), but it stays on the opts so a future stage
// that needs a thread read - or a move of persistence in here - has the
// client without a signature churn. Referenced via a discard below to
// keep the unused-parameter lint quiet without dropping it from the API.

/** 2048 is the project-wide floor on agent sub-call caps (see CLAUDE.md /
 *  analyze_image post-mortem). A routine turn lands well under it; the
 *  cap is headroom against the rare longer paragraph, not a length lever
 *  (the prompts control length). */
const MAX_TOKENS = 2048;

/**
 * Drive a single non-streaming Venice completion: a system + user pair,
 * the body text trimmed, reasoning content ignored.
 *
 * disable_thinking is set defensively. The intuition slot resolves to a
 * non-reasoning model today, so the flag is a no-op; it stays on so the
 * call survives a re-point to a reasoning id (an unsuppressed CoT
 * preamble would eat the MAX_TOKENS answer budget). retryRateLimit is on
 * because this is a server-side background call with no browser
 * rate-limit loop behind it - a single "model overloaded" 429 would
 * otherwise fail the sub-call.
 */
async function callOnce(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const raw = await veniceComplete({
    apiKey,
    body: {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      max_completion_tokens: MAX_TOKENS,
      venice_parameters: { disable_thinking: true },
    },
    retryRateLimit: true,
    signal,
  });
  const content = (raw as { choices?: Array<{ message?: { content?: unknown } }> })
    .choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}

/**
 * Build the perception input - the conversation transcript the
 * objective-observer reads. System and tool messages are stripped
 * (framing and internal plumbing, not conversation); user/assistant
 * turns render as a plain "<role> said: <content>" sequence.
 */
function buildTranscript(
  history: ReadonlyArray<{ role: string; content?: string | null }>,
): string {
  const lines: string[] = [];
  for (const m of history) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = typeof m.content === 'string' ? m.content : '';
    if (text.length === 0) continue;
    lines.push(`${m.role} said: ${text}`);
  }
  return lines.join('\n\n');
}

/**
 * Normalize the perception output to guarantee a leading
 * "Classification: <category>" line. The prompt asks for it, but fast
 * models occasionally elide structured prefixes; the synthesis step's
 * first-person classification acknowledgment has nothing to read in that
 * case. Prepending an "ambiguous" marker matches the existing taxonomy
 * and carries no behavioral branch on the conscious side.
 */
function ensureClassificationPrefix(raw: string): string {
  if (/^\s*Classification:\s*\S+/i.test(raw)) return raw;
  return `Classification: ambiguous\n\n${raw}`;
}

/**
 * Run the full pipeline and return a fresh payload. The orchestrator owns
 * trigger evaluation, cache read, and persistence - none of those happen
 * here. Returns null only when the pipeline genuinely fails (empty
 * transcript, perception/synthesis error, all drives failed, or
 * mid-pipeline abort).
 */
export async function runIntuitionPipeline(opts: {
  admin: SupabaseClient;
  userId: string;
  apiKey: string;
  threadId: string;
  modelId: string;
  history: Array<{ role: string; content?: string | null }>;
  round: number;
  mood: { band: number; column: 'confident' | 'tentative' } | null;
  nowMs: number;
  trigger: IntuitionTrigger;
  signal?: AbortSignal;
  log: EdgeLogger;
}): Promise<IntuitionPayload | null> {
  const { apiKey, modelId, history, round, mood, nowMs, trigger, signal, log } = opts;
  // admin / userId / threadId belong to the orchestrator's persistence
  // contract, not the pipeline body; keep them on the API (see the
  // signature comment above) without tripping the unused-parameter lint.
  void opts.admin;
  void opts.userId;
  void opts.threadId;

  const startedAt = Date.now();
  // Log at info so a user troubleshooting "the brain icon never showed"
  // can see whether the pipeline ever started.
  log.info('intuition pipeline starting', { trigger, round });

  const transcript = buildTranscript(history);
  if (transcript.length === 0) {
    // Empty transcript = nothing to perceive. Degrade gracefully on a
    // freshly-minted thread rather than throw.
    log.warn('skipped intuition pipeline: empty transcript');
    return null;
  }

  // Stage 1: perception.
  let perceptionRaw: string;
  try {
    perceptionRaw = await callOnce(apiKey, modelId, PERCEPTION_PROMPT, transcript, signal);
  } catch (err) {
    if (err instanceof VeniceError && err.kind === 'rate_limit') {
      log.warn('intuition perception rate-limited; leaving prior cache in place');
    } else {
      log.warn('intuition perception failed', err);
    }
    return null;
  }
  if (perceptionRaw.length === 0) {
    log.warn('intuition perception returned empty text');
    return null;
  }
  const perception = ensureClassificationPrefix(perceptionRaw);
  log.debug('intuition perception', { perception });

  // Stage 2: drive reactions in parallel. Each drive sees the perception
  // (not the raw transcript) so all five react to the same digest.
  const drivePromises = DRIVE_NAMES.map(
    async (name): Promise<[DriveName, string | null]> => {
      const systemPrompt = `${DRIVE_BASE_PROMPT}\n\n${DRIVE_PROMPTS[name]}`;
      try {
        const text = await callOnce(
          apiKey,
          modelId,
          systemPrompt,
          `# My perception of the discussion:\n${perception}`,
          signal,
        );
        if (text.length === 0) return [name, null];
        log.debug(`intuition drive:${name}`, { reaction: text });
        return [name, text];
      } catch (err) {
        log.warn(`intuition drive:${name} failed`, err);
        return [name, null];
      }
    },
  );
  const driveResults = await Promise.all(drivePromises);

  if (signal?.aborted) return null;

  const drives: Partial<Record<DriveName, string>> = {};
  for (const [name, text] of driveResults) {
    if (text !== null) drives[name] = text;
  }
  // If every drive failed, synthesis has no input. Bail rather than
  // synthesize against an empty set - the result would be vacuous.
  if (Object.keys(drives).length === 0) {
    log.warn('all intuition drive reactions failed; skipping synthesis');
    return null;
  }

  // Stage 3: synthesis. Perception and drives both ride in a single user
  // message; the model's reply IS the synthesis. Drives fold into the
  // user turn (not an assistant turn) to keep the shape conventional
  // (system + single user) - an assistant-terminated shape made the fast
  // model echo the SYNTHESIS_PROMPT body verbatim as its content.
  const drivesText = DRIVE_NAMES.map((n) => drives[n])
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join('\n\n');

  let synthesisRaw: string;
  try {
    const raw = await veniceComplete({
      apiKey,
      body: {
        model: modelId,
        messages: [
          { role: 'system', content: SYNTHESIS_PROMPT },
          {
            role: 'user',
            content:
              `# Perception\n${perception}\n\n` +
              `# Drive Reactions\n${drivesText}`,
          },
        ],
        max_completion_tokens: MAX_TOKENS,
        venice_parameters: { disable_thinking: true },
      },
      retryRateLimit: true,
      signal,
    });
    const content = (raw as { choices?: Array<{ message?: { content?: unknown } }> })
      .choices?.[0]?.message?.content;
    synthesisRaw = typeof content === 'string' ? content.trim() : '';
  } catch (err) {
    if (err instanceof VeniceError && err.kind === 'rate_limit') {
      log.warn('intuition synthesis rate-limited; leaving prior cache in place');
    } else {
      log.warn('intuition synthesis failed', err);
    }
    return null;
  }
  if (synthesisRaw.length === 0) {
    log.warn('intuition synthesis returned empty text');
    return null;
  }
  // Belt-and-braces guard against the prompt-echo failure mode: if the
  // model returns the synthesis prompt verbatim (or any leading slab of
  // it), bail rather than persist the prompt as the synthesis. The first
  // sentence of SYNTHESIS_PROMPT is a stable substring unlikely to appear
  // in any genuine synthesis output.
  if (synthesisRaw.includes('You are the Subconsciousness')) {
    log.warn(
      'intuition synthesis echoed the system prompt; treating as failure',
      synthesisRaw.slice(0, 80),
    );
    return null;
  }
  log.debug('intuition synthesis', { synthesis: synthesisRaw });

  const payload: IntuitionPayload = {
    v: 1,
    perception,
    drives,
    synthesis: synthesisRaw,
    computed_at_round: round,
    computed_at_band: mood?.band ?? null,
    computed_at_column: mood?.column ?? null,
    computed_at_at: nowMs,
    trigger,
  };
  // Companion to the "pipeline starting" log. A drive count below five
  // means at least one drive call failed and synthesis ran on a partial
  // set; below three is a signal the run is starved enough to investigate.
  log.info('intuition pipeline complete', {
    trigger,
    round,
    drivesAvailable: Object.keys(drives).length,
    elapsedMs: Date.now() - startedAt,
  });
  return payload;
}

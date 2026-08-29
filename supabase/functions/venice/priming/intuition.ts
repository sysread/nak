// The intuition turn-entry priming pipeline - the canonical
// implementation, run inside the venice edge function (extracted from the
// browser during the priming relocation). Three stages:
//
//   1. Perception - one call on the perception model (deepseek, 1M
//      window). Reads the transcript, classifies the prompt, and
//      produces an objective-observer summary.
//   2. Drive reactions - one structured-JSON call on the drive/synthesis
//      model (mistral). Produces all five drive reactions in a single
//      JSON object with one key per drive. Formerly five parallel calls;
//      collapsed to one to cut the drive stage from max(5 latencies) to
//      1. The context-pollution trade (later keys conditioned on earlier
//      ones within the same generation) is mitigated by prompt-level
//      independence instruction; see DRIVES_COLLAPSED_PROMPT.
//   3. Synthesis - one call on the drive/synthesis model. Aggregates
//      the drive reactions into a single internal monologue that primes
//      the conscious agent's response.
//
// Total calls: 3 (1 + 1 + 1). The pipeline is non-streaming - each
// stage hits Venice's one-shot completion endpoint and reads the single
// text result.
//
// Failure model:
//   - Perception failure aborts the pipeline. Returns null so the
//     orchestrator leaves the prior cache in place.
//   - Drive-call failure (network error, rate limit, empty response)
//     aborts. A successful call whose JSON is missing a drive key or has
//     an empty value for it degrades gracefully: that drive is omitted
//     from the payload's `drives` map, and synthesis runs against
//     whatever drives did respond. A JSON parse failure aborts.
//   - Synthesis failure aborts. Returns null.
//
// The orchestrator owns trigger evaluation, cache read, and persistence;
// this module only runs the pipeline and returns a fresh payload.

import { type SupabaseClient } from '@supabase/supabase-js';
import { type EdgeLogger } from '../../_shared/edge-log.ts';
import { type IntuitionTrigger } from '../../_shared/priming-triggers.ts';
import { veniceComplete, VeniceError } from '../../_shared/venice.ts';
import {
  DRIVE_NAMES,
  type DriveName,
  DRIVES_COLLAPSED_PROMPT,
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
 * disable_thinking stays on the body for whichever id the caller
 * passes. This function is used only for the perception stage, which
 * rides deepseek-v4-flash-0731-fast (reasoning-capable, high default
 * effort - the flag is load-bearing, pinning the thinking pass off so
 * it does not eat the MAX_TOKENS answer budget or add latency on the
 * pre-turn critical path). The drive and synthesis stages call
 * veniceComplete directly. retryRateLimit is on because this is a server-side background
 * call with no browser rate-limit loop behind it - a single "model
 * overloaded" 429 would otherwise fail the sub-call.
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
  /**
   * Model id for the perception stage only. The perception call reads
   * the entire untrimmed transcript and may need a larger context
   * window than the drive/synthesis calls (whose inputs are short).
   * Falls back to `modelId` when absent.
   */
  perceptionModelId?: string;
  history: Array<{ role: string; content?: string | null }>;
  round: number;
  mood: { band: number; column: 'confident' | 'tentative' } | null;
  nowMs: number;
  trigger: IntuitionTrigger;
  signal?: AbortSignal;
  log: EdgeLogger;
}): Promise<IntuitionPayload | null> {
  const { apiKey, modelId, perceptionModelId, history, round, mood, nowMs, trigger, signal, log } = opts;
  const perceptionModel = perceptionModelId ?? modelId;
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
    perceptionRaw = await callOnce(apiKey, perceptionModel, PERCEPTION_PROMPT, transcript, signal);
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

  // Stage 2: drive reactions in a single structured-JSON call. All five
  // drives react to the same perception; the model returns a JSON object
  // with one key per drive. Formerly five parallel calls; collapsed to
  // one to cut the drive stage from max(5 latencies) to 1.
  let drivesRaw: string;
  try {
    const raw = await veniceComplete({
      apiKey,
      body: {
        model: modelId,
        messages: [
          { role: 'system', content: DRIVES_COLLAPSED_PROMPT },
          {
            role: 'user',
            content: `# My perception of the discussion:\n${perception}`,
          },
        ],
        max_completion_tokens: MAX_TOKENS,
        response_format: { type: 'json_object' },
        venice_parameters: { disable_thinking: true },
      },
      retryRateLimit: true,
      signal,
    });
    const content = (raw as { choices?: Array<{ message?: { content?: unknown } }> })
      .choices?.[0]?.message?.content;
    drivesRaw = typeof content === 'string' ? content.trim() : '';
  } catch (err) {
    if (err instanceof VeniceError && err.kind === 'rate_limit') {
      log.warn('intuition drives rate-limited; leaving prior cache in place');
    } else {
      log.warn('intuition drives failed', err);
    }
    return null;
  }
  if (drivesRaw.length === 0) {
    log.warn('intuition drives returned empty text');
    return null;
  }

  if (signal?.aborted) return null;

  // Parse the JSON response. Each drive key that is present and non-empty
  // joins the drives map; missing or empty keys are treated as failed
  // drives (same tolerance as the former per-drive error handling).
  const drives: Partial<Record<DriveName, string>> = {};
  try {
    const parsed = JSON.parse(drivesRaw) as Record<string, unknown>;
    for (const name of DRIVE_NAMES) {
      const val = parsed[name];
      if (typeof val === 'string' && val.trim().length > 0) {
        drives[name] = val.trim();
        log.debug(`intuition drive:${name}`, { reaction: val.trim() });
      }
    }
  } catch (err) {
    log.warn('intuition drives JSON parse failed', {
      raw: drivesRaw.slice(0, 200),
      err,
    });
    return null;
  }

  // If every drive was missing or empty, synthesis has no input. Bail
  // rather than synthesize against an empty set - the result would be
  // vacuous.
  if (Object.keys(drives).length === 0) {
    log.warn('all intuition drive reactions empty or missing; skipping synthesis');
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

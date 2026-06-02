/**
 * Bias-observer agent. One method - `observe` - which corresponds to
 * the single worker phase. Reads a conversation transcript, calls
 * the fast-model tier once, parses the structured-JSON response,
 * and returns a typed array of observations.
 *
 * The agent itself runs zero validation against the catalog and zero
 * confidence clamping. That logic lives in the worker's save phase
 * so the loop can test the agent and the validation independently;
 * the agent's contract is "parse what the model said, return null
 * on parse failure or rate-limit re-throw."
 *
 * Mirrors `src/lib/agents/samskara/agent.ts` deliberately - same
 * `callOnce` + `tryParseJson` plumbing - so the maintenance cost of
 * the agent layer stays constant as features land.
 */
import type { SupabaseService } from '../../supabase';
import { VeniceError } from '../../venice';
import {
  BIAS_OBSERVER_PROMPT,
  type BiasObservationResult,
  type BiasReactionResult,
} from './prompts';
import { isBiasKey } from '../../bias/catalog-keys';

/** One transcript line passed to the agent. The agent only reads
 *  user and assistant turns; tool calls are not in the input. */
export interface TranscriptLine {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Strip a leading/trailing ```json fence if the model added one
 * despite the prompt's "no markdown fence" instruction. Same helper
 * the samskara agent uses; some fast models still wrap structured
 * JSON when their default behaviour leaks through.
 */
function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    const withoutFence = trimmed
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '');
    return withoutFence.trim();
  }
  return trimmed;
}

function tryParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(stripJsonFence(raw)) as T;
  } catch {
    return null;
  }
}

async function callOnce(
  supabase: SupabaseService,
  model: string,
  systemPrompt: string,
  userPayload: string,
  signal: AbortSignal,
  maxTokens: number
): Promise<string> {
  const result = await supabase.complete({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPayload },
    ],
    maxTokens,
    signal,
  });
  return result.text;
}

export class BiasObserverAgent {
  constructor(
    private supabase: SupabaseService,
    /** Fast model id. Worker passes whatever `agentModel('bias')`
     *  resolves to; tests pass a deterministic stub. */
    private model: string
  ) {}

  /**
   * One analysis pass over a conversation. Returns both observations
   * (biases the user exhibited) and reactions (how the user
   * responded to the assistant's compensation behavior for biases
   * in `activeBiases`) on success, or null when:
   *   - the model produced unparseable output (a parse failure)
   *   - the response had the wrong top-level shape
   *
   * Rate-limit errors re-throw so the cycle driver can route them
   * to the long back-off; other Venice errors are swallowed to
   * null and the cycle driver maps null to the short error path.
   *
   * The `maxTokens` cap is generous - the agent typically emits a
   * small object (often empty); 4096 covers the upper envelope of
   * a long-thread analysis that flags multiple biases with full
   * reasoning. The catalog block alone is large enough on the
   * prompt side that we want plenty of completion room.
   */
  async observe(
    transcript: readonly TranscriptLine[],
    activeBiases: readonly string[],
    signal: AbortSignal
  ): Promise<{
    observations: BiasObservationResult[];
    reactions: BiasReactionResult[];
  } | null> {
    const payload = JSON.stringify({
      messages: transcript.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
      })),
      active_biases: Array.from(activeBiases),
    });

    let raw: string;
    try {
      raw = await callOnce(
        this.supabase,
        this.model,
        BIAS_OBSERVER_PROMPT,
        payload,
        signal,
        4096
      );
    } catch (err) {
      // Rate-limit re-throws so the cycle driver can map to its
      // long back-off (60s) rather than the short error back-off
      // (15s). Other Venice failures are transient and treated as
      // a parse-failure equivalent (the thread stays unclaimed via
      // the TTL release; the next scan picks it back up).
      if (err instanceof VeniceError && err.kind === 'rate_limit') throw err;
      return null;
    }

    const parsed = tryParseJson<{
      observations?: unknown;
      reactions?: unknown;
    }>(raw);
    if (!parsed) return null;
    // Tolerate one of the two top-level keys being missing - the
    // agent may produce only observations on a thread with no
    // active biases, or only reactions if it found nothing
    // bias-shaped but had compensation to react to. An entirely
    // missing object is a parse failure; partial output is fine.
    if (!Array.isArray(parsed.observations) && !Array.isArray(parsed.reactions)) {
      return null;
    }

    // Per-item validation. Items that fail shape checks are dropped
    // silently - we'd rather lose one bad item than throw away the
    // whole pass. Catalog validation uses the type guard from
    // catalog.ts; unknown bias names are dropped.
    const observations: BiasObservationResult[] = [];
    if (Array.isArray(parsed.observations)) {
      for (const item of parsed.observations) {
        if (typeof item !== 'object' || item === null) continue;
        const o = item as Record<string, unknown>;
        const bias = typeof o.bias === 'string' ? o.bias : null;
        if (!bias || !isBiasKey(bias)) continue;
        const confidence = typeof o.confidence === 'number' ? o.confidence : null;
        if (confidence === null || Number.isNaN(confidence)) continue;
        const reasoning = typeof o.reasoning === 'string' ? o.reasoning.trim() : '';
        if (reasoning.length === 0) continue;
        const evidenceMessageId =
          typeof o.evidence_message_id === 'string' && o.evidence_message_id.length > 0
            ? o.evidence_message_id
            : null;
        observations.push({
          bias,
          confidence,
          reasoning,
          evidenceMessageId,
        });
      }
    }

    // Reactions: the bias must be in the active set the worker
    // passed in. A reaction for a non-active bias is fabrication
    // (no compensation was on the wire for it) and gets dropped.
    // wasConfirmed is the three-state boolean | null; reasoning
    // must be non-empty.
    const activeSet = new Set(activeBiases);
    const reactions: BiasReactionResult[] = [];
    if (Array.isArray(parsed.reactions)) {
      for (const item of parsed.reactions) {
        if (typeof item !== 'object' || item === null) continue;
        const r = item as Record<string, unknown>;
        const bias = typeof r.bias === 'string' ? r.bias : null;
        if (!bias || !isBiasKey(bias)) continue;
        if (!activeSet.has(bias)) continue;
        const reasoning = typeof r.reasoning === 'string' ? r.reasoning.trim() : '';
        if (reasoning.length === 0) continue;
        let wasConfirmed: boolean | null;
        if (r.was_confirmed === true) wasConfirmed = true;
        else if (r.was_confirmed === false) wasConfirmed = false;
        else if (r.was_confirmed === null) wasConfirmed = null;
        else continue;
        reactions.push({ bias, wasConfirmed, reasoning });
      }
    }

    return { observations, reactions };
  }
}

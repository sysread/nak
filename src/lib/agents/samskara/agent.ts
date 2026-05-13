/**
 * Samskara formation agent. One class per phase would be heavy; this
 * file holds a single `SamskaraAgent` whose methods correspond to the
 * worker phases. Each method makes ONE Venice fast-model call, parses
 * the JSON the prompt requests, and returns a typed result.
 *
 * The agent does NOT acquire leases, claim rows, or persist results.
 * That's the worker's job (see `./loop.ts`). This class is pure
 * model-call logic so it can be unit-tested with a mock VeniceClient.
 *
 * Why not split into per-phase agent classes: each phase shares the
 * exact same plumbing (build one prompt, call completeChat, parse
 * JSON, error-handle). Splitting would multiply the boilerplate
 * without adding insight. The `phase` arg on each method is
 * intentionally implicit in the method name.
 */
import type { VeniceClient } from '../../venice';
import { VeniceError } from '../../venice';
import {
  ASSIMILATOR_PROMPT,
  RELATOR_PROMPT,
  MINTER_PROMPT,
  REACTION_PROMPT,
  COMPOUND_SUMMARY_PROMPT,
} from './prompts';

/**
 * Result of an assimilation pass. `null` when the agent failed or
 * produced unparseable output - the worker logs and skips. We
 * deliberately don't throw on parse failure; the row stays claimed
 * until the TTL releases it.
 */
export interface AssimilationResult {
  situation: string;
  outcome: string;
  valence: number;
}

export interface RelatorResult {
  kind: 'pattern' | 'contrast' | 'prerequisite' | 'consequence' | 'orthogonal';
  label: string;
}

export interface MintResult {
  confirm: boolean;
  prediction: string;
  innerVoice: string;
  valence: number;
  confidence: number;
}

export interface ReactionResult {
  confirm: string[];
  disconfirm: string[];
  neutral: string[];
}

export interface CohortMember {
  id: string;
  prediction: string;
}

/**
 * Strip a leading/trailing ```json fence if the model added one
 * despite the "no markdown fence" instruction. Some fast models still
 * wrap JSON when the prompt doesn't override their default behaviour
 * strongly enough; this is cheap insurance.
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

/**
 * Best-effort JSON parse. Returns null when the model emitted
 * something that doesn't parse - the worker treats null the same as
 * any other agent failure (claim TTLs out, row reclaimed next pass).
 */
function tryParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(stripJsonFence(raw)) as T;
  } catch {
    return null;
  }
}

/**
 * Drive a single non-streaming Venice completion. Same pattern the
 * summary agent uses; the response body is read directly off
 * `completeChat`'s ChatCompletion - no streaming-deltas path
 * because background JSON-shaped agents have no UI surface to
 * incrementally render into.
 */
async function callOnce(
  venice: VeniceClient,
  model: string,
  systemPrompt: string,
  userPayload: string,
  signal: AbortSignal,
  maxTokens: number
): Promise<string> {
  const result = await venice.completeChat({
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

export class SamskaraAgent {
  constructor(
    private venice: VeniceClient,
    /** Fast model id to drive every phase. Defaults to VENICE_FAST or whichever the worker passes. */
    private model: string
  ) {}

  /**
   * Assimilate one substrate stub into structured fields. Receives
   * the user message text and the assistant message text; returns
   * null on parse failure or rate-limit.
   */
  async assimilate(
    userMessage: string,
    assistantMessage: string,
    signal: AbortSignal
  ): Promise<AssimilationResult | null> {
    const payload = JSON.stringify({
      user_message: userMessage,
      assistant_message: assistantMessage,
    });
    let raw: string;
    try {
      raw = await callOnce(this.venice, this.model, ASSIMILATOR_PROMPT, payload, signal, 2048);
    } catch (err) {
      // Rate-limit re-throws so the cycle driver can map to its
      // long back-off (60s) rather than the short error back-off
      // (15s). Other Venice failures are transient and treated as
      // a parse-failure equivalent (the row stays claimed; the TTL
      // releases it; the next pass retries).
      if (err instanceof VeniceError && err.kind === 'rate_limit') throw err;
      return null;
    }
    const parsed = tryParseJson<{
      situation?: unknown;
      outcome?: unknown;
      valence?: unknown;
    }>(raw);
    if (
      !parsed ||
      typeof parsed.situation !== 'string' ||
      parsed.situation.length === 0
    ) {
      return null;
    }
    return {
      situation: parsed.situation,
      outcome: typeof parsed.outcome === 'string' ? parsed.outcome : '',
      valence: typeof parsed.valence === 'number' ? clamp(parsed.valence, -1, 1) : 0,
    };
  }

  /**
   * Label the relation between two substrate snapshots. Returns null
   * on parse failure; returns kind='orthogonal' when the model itself
   * decided there's no meaningful relation.
   */
  async relate(
    a: { situation: string; outcome: string | null },
    b: { situation: string; outcome: string | null },
    signal: AbortSignal
  ): Promise<RelatorResult | null> {
    const payload = JSON.stringify({ a, b });
    let raw: string;
    try {
      raw = await callOnce(this.venice, this.model, RELATOR_PROMPT, payload, signal, 2048);
    } catch (err) {
      // Rate-limit re-throws so the cycle driver can map to its
      // long back-off (60s) rather than the short error back-off
      // (15s). Other Venice failures are transient and treated as
      // a parse-failure equivalent (the row stays claimed; the TTL
      // releases it; the next pass retries).
      if (err instanceof VeniceError && err.kind === 'rate_limit') throw err;
      return null;
    }
    const parsed = tryParseJson<{ kind?: unknown; label?: unknown }>(raw);
    if (!parsed || typeof parsed.kind !== 'string') return null;
    const allowed: RelatorResult['kind'][] = [
      'pattern',
      'contrast',
      'prerequisite',
      'consequence',
      'orthogonal',
    ];
    if (!(allowed as string[]).includes(parsed.kind)) return null;
    const label = typeof parsed.label === 'string' ? parsed.label : '';
    return { kind: parsed.kind as RelatorResult['kind'], label };
  }

  /**
   * Mint a samskara from a cluster. The cluster shape is opaque to
   * the agent; the worker hands it the sample situations and labels
   * already extracted. Returns null on parse failure or when
   * confirm:false comes back.
   */
  async mint(
    cluster: {
      sample_labels: string[];
      sample_situations: string[];
      reinforcement: number;
    },
    signal: AbortSignal
  ): Promise<MintResult | null> {
    const payload = JSON.stringify(cluster);
    let raw: string;
    try {
      raw = await callOnce(this.venice, this.model, MINTER_PROMPT, payload, signal, 2048);
    } catch (err) {
      // Rate-limit re-throws so the cycle driver can map to its
      // long back-off (60s) rather than the short error back-off
      // (15s). Other Venice failures are transient and treated as
      // a parse-failure equivalent (the row stays claimed; the TTL
      // releases it; the next pass retries).
      if (err instanceof VeniceError && err.kind === 'rate_limit') throw err;
      return null;
    }
    const parsed = tryParseJson<{
      confirm?: unknown;
      prediction?: unknown;
      inner_voice?: unknown;
      valence?: unknown;
      confidence?: unknown;
    }>(raw);
    if (!parsed || parsed.confirm !== true) return null;
    if (typeof parsed.prediction !== 'string' || parsed.prediction.length === 0) {
      return null;
    }
    return {
      confirm: true,
      prediction: parsed.prediction,
      innerVoice: typeof parsed.inner_voice === 'string' ? parsed.inner_voice : '',
      valence: typeof parsed.valence === 'number' ? clamp(parsed.valence, -1, 1) : 0,
      confidence:
        typeof parsed.confidence === 'number' ? clamp(parsed.confidence, 0, 1) : 0.5,
    };
  }

  /**
   * Classify a cohort's reaction. Returns null on parse failure; the
   * worker leaves the cohort unresolved (its fired_at ages out via
   * the 10-minute window and decay handles it from there).
   */
  async classifyReaction(
    cohort: CohortMember[],
    assistantMessage: string,
    nextUserMessage: string,
    signal: AbortSignal
  ): Promise<ReactionResult | null> {
    const payload = JSON.stringify({
      cohort,
      assistant_message: assistantMessage,
      user_message: nextUserMessage,
    });
    let raw: string;
    try {
      raw = await callOnce(this.venice, this.model, REACTION_PROMPT, payload, signal, 2048);
    } catch (err) {
      // Rate-limit re-throws so the cycle driver can map to its
      // long back-off (60s) rather than the short error back-off
      // (15s). Other Venice failures are transient and treated as
      // a parse-failure equivalent (the row stays claimed; the TTL
      // releases it; the next pass retries).
      if (err instanceof VeniceError && err.kind === 'rate_limit') throw err;
      return null;
    }
    const parsed = tryParseJson<{
      confirm?: unknown;
      disconfirm?: unknown;
      neutral?: unknown;
    }>(raw);
    if (!parsed) return null;
    const confirm = asStringArray(parsed.confirm);
    const disconfirm = asStringArray(parsed.disconfirm);
    const neutral = asStringArray(parsed.neutral);
    if (!confirm || !disconfirm || !neutral) return null;
    return { confirm, disconfirm, neutral };
  }

  /**
   * Generate the compound prose summary. Returns null on parse
   * failure or empty output. The worker leaves the prior summary in
   * place when this returns null - better stale than empty.
   */
  async summarizeCompound(
    samskaras: {
      prediction: string;
      inner_voice: string | null;
      valence: number | null;
      confidence: number;
      health: number;
    }[],
    signal: AbortSignal
  ): Promise<string | null> {
    const payload = JSON.stringify({ samskaras });
    let raw: string;
    try {
      raw = await callOnce(
        this.venice,
        this.model,
        COMPOUND_SUMMARY_PROMPT,
        payload,
        signal,
        2048
      );
    } catch (err) {
      // Rate-limit re-throws so the cycle driver can map to its
      // long back-off (60s) rather than the short error back-off
      // (15s). Other Venice failures are transient and treated as
      // a parse-failure equivalent (the row stays claimed; the TTL
      // releases it; the next pass retries).
      if (err instanceof VeniceError && err.kind === 'rate_limit') throw err;
      return null;
    }
    const trimmed = raw.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  for (const item of v) {
    if (typeof item !== 'string') return null;
  }
  return v as string[];
}

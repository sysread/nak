/**
 * Pre-configured model tiers. The tier is what the app persists (on a
 * thread row and in the user's default); the Venice model id is an
 * implementation detail that can move as the tiers are retuned without
 * invalidating stored data.
 *
 * Why the indirection: Venice (and AI providers generally) rotate model
 * names aggressively. If we stored "kimi-k2-5" directly on every thread
 * row, changing the Smart tier to a newer model would orphan every
 * existing thread. Storing `smart | balanced | fast` means we can
 * retarget the tier by editing this file alone.
 *
 * The `icon` field is an emoji codepoint used by the 3-button tier
 * toggle in Chat.svelte. See the comment on `balanced.icon` below for
 * why some icons need an explicit variation selector.
 */

export type ModelTier = 'smart' | 'balanced' | 'fast';

/**
 * OpenAI-style reasoning_effort knob. Passed through verbatim in the
 * `reasoning_effort` body field on /chat/completions — Venice forwards
 * it to the underlying provider. Only meaningful on models whose
 * ModelSpec marks `supportsReasoning: true`; ignored on others (some
 * providers 400 on the unknown field, so we omit it entirely when the
 * resolved model can't reason).
 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

/**
 * Default when the user hasn't picked anything explicitly. `low` keeps
 * latency in the chat-turn ballpark — `medium` / `high` can stretch a
 * simple reply into multi-second think time. Users who want more can
 * bump per-thread or change their default in Settings.
 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'low';

export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return v === 'low' || v === 'medium' || v === 'high';
}

/** Display labels for the three effort levels. Keep short; the dropdown is narrow. */
export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export interface ModelSpec {
  tier: ModelTier;
  /** Venice API model id sent in chat-completion requests. */
  id: string;
  /** Human label for UI. */
  label: string;
  /** Tier glyph — a single unicode character suitable as a tiny prefix icon. */
  icon: string;
  /** One-line tradeoff copy shown under the label. */
  description: string;
  /** Context window (tokens), for display. */
  contextWindow: number;
  /**
   * True when Venice's model spec for this id accepts the
   * `reasoning_effort` knob. Drives the per-thread dropdown in the
   * composer: we hide it when false rather than send a field the
   * provider will reject. Sourced from Venice's /models response —
   * update by hand when a tier is re-pointed at a non-reasoning model.
   */
  supportsReasoning: boolean;
}

export const MODELS: Record<ModelTier, ModelSpec> = {
  smart: {
    tier: 'smart',
    id: 'kimi-k2-5',
    label: 'Smart',
    icon: '🧠',
    description: 'Best quality, slower.',
    contextWindow: 256_000,
    supportsReasoning: true,
  },
  balanced: {
    tier: 'balanced',
    id: 'arcee-trinity-large-thinking',
    label: 'Balanced',
    // U+262F YIN YANG + U+FE0F emoji presentation. Chosen over U+2696
    // SCALES because the scales glyph is all thin strokes in every major
    // emoji font, and it vanishes against the toggle background in both
    // themes; yin-yang is a solid bi-tonal disc that reads at any size.
    icon: '\u262F\uFE0F',
    description: 'Good quality, moderate speed.',
    contextWindow: 256_000,
    supportsReasoning: true,
  },
  fast: {
    tier: 'fast',
    id: 'grok-41-fast',
    label: 'Fast',
    icon: '\u26A1\uFE0F',
    description: 'Fastest; ~1M-token context.',
    contextWindow: 1_000_000,
    supportsReasoning: true,
  },
};

export const TIERS: readonly ModelTier[] = ['smart', 'balanced', 'fast'];

export const DEFAULT_TIER: ModelTier = 'balanced';

/** Tier used for one-shot utility calls (auto-titling, etc.). */
export const UTILITY_TIER: ModelTier = 'fast';

export function isModelTier(v: unknown): v is ModelTier {
  return v === 'smart' || v === 'balanced' || v === 'fast';
}

/**
 * Resolve the concrete tier to use for a given thread. A per-thread
 * override wins; otherwise fall back to the user's configured default.
 */
export function resolveTier(
  threadModel: ModelTier | null,
  defaultTier: ModelTier
): ModelTier {
  return threadModel ?? defaultTier;
}

/**
 * Resolve the reasoning effort to use for a given thread. Mirrors
 * resolveTier: the per-thread override wins over the user default.
 * Callers still have to gate on `MODELS[tier].supportsReasoning`
 * before putting this on the wire.
 */
export function resolveReasoningEffort(
  threadEffort: ReasoningEffort | null,
  defaultEffort: ReasoningEffort
): ReasoningEffort {
  return threadEffort ?? defaultEffort;
}

/**
 * Reverse lookup: given a Venice model id (e.g. 'kimi-k2-5'), return the
 * ModelSpec whose `id` matches. Used by the per-message context-window
 * indicator — a message row stores the concrete id it was answered by,
 * and we need the id → contextWindow map to compute a percentage.
 *
 * Returns null when no tier matches, which happens on rows written under
 * a now-retired model id (we've retargeted the tier in the meantime but
 * old rows still carry the old id). The caller should hide the
 * indicator rather than guess at the window.
 */
export function findModelById(id: string | null | undefined): ModelSpec | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  for (const spec of Object.values(MODELS)) {
    if (spec.id === id) return spec;
  }
  return null;
}

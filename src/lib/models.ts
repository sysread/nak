/**
 * Pre-configured model tiers. The tier is what the app persists (on a
 * thread row and in the user's default); the Venice model id is an
 * implementation detail that can move as the tiers are retuned without
 * invalidating stored data.
 */

export type ModelTier = 'smart' | 'balanced' | 'fast';

export interface ModelSpec {
  tier: ModelTier;
  /** Venice API model id sent in chat-completion requests. */
  id: string;
  /** Human label for UI. */
  label: string;
  /** One-line tradeoff copy shown under the label. */
  description: string;
  /** Context window (tokens), for display. */
  contextWindow: number;
}

export const MODELS: Record<ModelTier, ModelSpec> = {
  smart: {
    tier: 'smart',
    id: 'kimi-k2-5',
    label: 'Smart',
    description: 'Best quality, slower.',
    contextWindow: 256_000,
  },
  balanced: {
    tier: 'balanced',
    id: 'arcee-trinity-large-thinking',
    label: 'Balanced',
    description: 'Good quality, moderate speed.',
    contextWindow: 256_000,
  },
  fast: {
    tier: 'fast',
    id: 'grok-41-fast',
    label: 'Fast',
    description: 'Fastest; ~1M-token context.',
    contextWindow: 1_000_000,
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

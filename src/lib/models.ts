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

/**
 * OpenAI-style `text.verbosity` knob ('low' | 'medium' | 'high'). Passed
 * through on /chat/completions nested under `text` — i.e. body shape
 * `{text: {verbosity: '…'}}`. Controls how long the assistant's answers
 * tend to be before any reasoning-effort knob kicks in: 'low' biases
 * toward short direct replies, 'high' toward expansive prose. Omitted
 * entirely when unset so providers that don't recognize the field
 * don't 400 on it (same discipline we use for reasoning_effort).
 *
 * Orthogonal to reasoning_effort: verbosity controls output length,
 * reasoning controls how much internal thinking happens before the
 * output. A reasoning-heavy, low-verbosity turn does a lot of hidden
 * work and emits a terse answer; the opposite pairing thinks little
 * and writes a lot.
 */
export type Verbosity = 'low' | 'medium' | 'high';

export const VERBOSITIES: readonly Verbosity[] = ['low', 'medium', 'high'];

/**
 * Default when the user hasn't picked anything explicitly. 'medium' is
 * the neutral middle — neither forcing terse single-line answers nor
 * padding simple replies into essays. Users who prefer one extreme
 * can flip per-thread or change their default in Settings.
 */
export const DEFAULT_VERBOSITY: Verbosity = 'medium';

export function isVerbosity(v: unknown): v is Verbosity {
  return v === 'low' || v === 'medium' || v === 'high';
}

/** Display labels for the three verbosity levels. Keep short; the dropdown is narrow. */
export const VERBOSITY_LABELS: Record<Verbosity, string> = {
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
  /**
   * True when the model accepts OpenAI-compatible multimodal input —
   * `content` as an array of `{type:'text'|'image_url', ...}` parts
   * rather than a plain string. Drives the attachment pre-send guard:
   * on a vision tier, an image attachment is consumable (we inline it
   * as `image_url`); on a non-vision tier the send is blocked until
   * the user removes the image or switches tier. Sourced from the
   * `model_spec.capabilities.supportsVision` field on Venice's
   * /models response — update by hand when a tier is re-pointed.
   */
  supportsVision: boolean;
  /**
   * Tier-level reasoning-effort default. When set, wins over the
   * user's account-level default (but not the per-thread override).
   * Used to differentiate two tiers that point at the same Venice
   * model id — e.g. when Smart and Balanced both run kimi-k2-6, the
   * tier labels are really "same model, different thinking
   * budgets", and this field is what realises that contract.
   * Absent means "no tier opinion — fall through to the user
   * default." Only consulted when `supportsReasoning` is also true.
   */
  defaultReasoningEffort?: ReasoningEffort;
}

export const MODELS: Record<ModelTier, ModelSpec> = {
  smart: {
    tier: 'smart',
    id: 'zai-org-glm-5-1',
    label: 'Smart',
    icon: '🧠',
    description: 'GLM-5.1 with deep thinking. Best for hard problems.',
    contextWindow: 200_000,
    supportsReasoning: true,
    // Vision support unknown at retarget time - set false to route
    // images through analyze_image(). Flip to true if Venice confirms
    // native vision support for this id.
    supportsVision: false,
    defaultReasoningEffort: 'high',
  },
  balanced: {
    tier: 'balanced',
    id: 'minimax-m27',
    label: 'Balanced',
    // U+262F YIN YANG + U+FE0F emoji presentation. Chosen over U+2696
    // SCALES because the scales glyph is all thin strokes in every major
    // emoji font, and it vanishes against the toggle background in both
    // themes; yin-yang is a solid bi-tonal disc that reads at any size.
    icon: '\u262F\uFE0F',
    description: 'MiniMax M27 with light thinking. Good default for most turns.',
    contextWindow: 198_000,
    supportsReasoning: true,
    // Vision support unknown at retarget time - set false to route
    // images through analyze_image(). Flip to true if Venice confirms
    // native vision support for this id.
    supportsVision: false,
    defaultReasoningEffort: 'low',
  },
  fast: {
    tier: 'fast',
    id: 'mistral-small-2603',
    label: 'Fast',
    icon: '\u26A1\uFE0F',
    description: 'Mistral Small. Fast, vision-capable, 256k context.',
    contextWindow: 256_000,
    supportsReasoning: true,
    // mistral-small-2603 supports vision natively on Venice and is also
    // the model analyze_image() calls for its vision sub-completions on
    // all tiers (see VISION_ANALYSIS_MODEL below).
    supportsVision: true,
  },
};

export const TIERS: readonly ModelTier[] = ['smart', 'balanced', 'fast'];

export const DEFAULT_TIER: ModelTier = 'balanced';

/** Tier used for one-shot utility calls (auto-titling, etc.). */
export const UTILITY_TIER: ModelTier = 'fast';

/**
 * Model the memory-reflection agent runs against. Tracks the fast
 * tier because the reflection task is "read the conversation, make
 * some judgments, call the memory tools" — not reasoning-heavy, but
 * bottlenecked on input length (entire thread as context). The fast
 * tier's ~1M-token window means we don't need a summariser layer in
 * front of the agent.
 *
 * Re-points automatically if the fast tier is retargeted, which is
 * usually what we want — if a cheaper/faster model lands in the fast
 * slot, reflection benefits without a separate edit. If the tiers are
 * ever retuned and the new fast model regresses on long-context
 * understanding, override by hardcoding the concrete Venice id here.
 */
export const VENICE_REFLECTION_MODEL = MODELS.fast.id;

/**
 * Model the memory-recall agent runs against. Uses qwen3-5-35b-a3b,
 * matching the image-analysis tool's model tier. The task is "read
 * the live conversation, search memories, produce a short note" -
 * bounded synthesis, no reasoning required. Input is capped by
 * MAX_RECALL_CHARS in the agent before the call, so the 256k context
 * window is not a constraint in practice. Kept as a distinct constant
 * from VENICE_REFLECTION_MODEL so recall and reflection can be tuned
 * independently if one regresses.
 */
export const VENICE_RECALL_MODEL = 'qwen3-5-35b-a3b';

/**
 * Model the conversation-recall agent runs against. Same rationale as
 * VENICE_RECALL_MODEL - bounded synthesis, 256k context is sufficient
 * after the MAX_RECALL_CHARS cap. Kept distinct from VENICE_RECALL_MODEL
 * so the two recall surfaces can be pinned to different models
 * independently if one regresses.
 */
export const VENICE_CONVERSATION_RECALL_MODEL = 'mistral-small-3-2-24b-instruct';

/**
 * Model the thread-summary agent runs against. The task is "read the
 * conversation, write 2-3 sentences" - cheap, bounded (MAX_INPUT_MESSAGES
 * = 120), and doesn't require reasoning. mistral-small-3-2-24b-instruct
 * is well within spec; the output goes into a single embedding vector.
 */
export const VENICE_SUMMARY_MODEL = 'mistral-small-3-2-24b-instruct';

/**
 * Vision model the analyze_image tool calls for its sub-completions.
 * Intentionally decoupled from any user-facing tier so a tier retarget
 * doesn't silently break image analysis. Switched from mistral-small-2603
 * to qwen3-5-122b-a10b after mistral-small consistently missed detail in
 * testing - the larger model is more thorough on dense or text-heavy images.
 */
export const VISION_ANALYSIS_MODEL = 'e2ee-qwen3-5-122b-a10b';

/**
 * Model the samskara formation agent runs against. The task is five
 * short JSON-out phases (assimilate, relate, mint, classify, compound
 * summary) - small prompts with maxTokens 200-500 per phase. Structured
 * output on bounded context; no reasoning required. mistral-small handles
 * this comfortably.
 */
export const VENICE_SAMSKARA_MODEL = 'mistral-small-3-2-24b-instruct';

/**
 * Model the `web_search` tool runs against for its sub-completion.
 * The task is "summarize Venice-provided search results into 2-4
 * sentences with ^N^ markers" - bounded synthesis, not reasoning. Fast
 * tier matches the rationale of the other internal-agent constants
 * above. Kept as a distinct constant so a future decision to pin web
 * search to a different tier (if a fast retune regresses citation
 * discipline) doesn't require editing tool internals.
 */
export const VENICE_WEB_SEARCH_MODEL = MODELS.fast.id;

/**
 * Venice's embeddings model. Single constant rather than a tier because
 * Venice only ships one embeddings model today. If Venice ever introduces
 * a second model, this string becomes the current default and the
 * `embedding_model` column on each row lets us locate rows stamped with
 * the older id (`where embedding_model <> VENICE_EMBEDDING_MODEL`) for
 * re-embedding.
 */
export const VENICE_EMBEDDING_MODEL = 'text-embedding-bge-m3';

/**
 * Native output dimension of VENICE_EMBEDDING_MODEL — the length of each
 * `embedding` array returned by `/embeddings`. bge-m3 emits 1024.
 */
export const VENICE_EMBEDDING_DIMS = 1024;

/**
 * Column dimension of `memories.embedding` in `supabase/schema.sql`. We
 * store wider than the current model emits so a future model rotation
 * (say Venice adding a 2048-dim model) doesn't force an `ALTER TYPE
 * vector(N)` on the column — ALTER TYPE on a pgvector column requires
 * every row either null or already the new dimension, which is a
 * painful migration step we'd rather skip.
 *
 * The gap is filled by zero-extension (see `padEmbeddingForStorage`).
 * Cosine similarity is invariant under zero-extension: dot(u_padded,
 * v_padded) = dot(u, v) and |u_padded| = |u|, so cos-sim over padded
 * vectors equals cos-sim over the native prefix. Euclidean distance is
 * similarly preserved.
 *
 * 2048 was picked as a compromise between forward room and seq-scan
 * latency — doubling cos-sim compute per row to cover a future model we
 * don't have yet. At memories-scale (hundreds of rows per user) the
 * extra cost is unobservable. If we ever need HNSW we'd switch to
 * `halfvec(2048)`, which pgvector indexes up to 4000 dims.
 */
export const EMBEDDING_STORAGE_DIMS = 2048;

/**
 * Zero-extend a Venice embedding to the storage dimension. Pure function,
 * safe to call on any length up to EMBEDDING_STORAGE_DIMS. A longer input
 * is a bug — either VENICE_EMBEDDING_DIMS is stale or the caller handed
 * us someone else's vector — so we throw rather than silently truncate,
 * which would look like a correctness bug dressed up as a performance
 * regression when searches started returning the wrong rows.
 */
export function padEmbeddingForStorage(embedding: readonly number[]): number[] {
  if (embedding.length > EMBEDDING_STORAGE_DIMS) {
    throw new Error(
      `embedding length ${embedding.length} exceeds storage dim ${EMBEDDING_STORAGE_DIMS}`
    );
  }
  if (embedding.length === EMBEDDING_STORAGE_DIMS) {
    // Fast path: already the right shape. Return a copy so callers can't
    // mutate the caller's buffer.
    return embedding.slice();
  }
  const padded = new Array<number>(EMBEDDING_STORAGE_DIMS);
  for (let i = 0; i < embedding.length; i++) padded[i] = embedding[i];
  for (let i = embedding.length; i < EMBEDDING_STORAGE_DIMS; i++) padded[i] = 0;
  return padded;
}

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
 * Resolve the reasoning effort to use for a given thread. Cascade:
 *
 *   per-thread override → tier default → user account default
 *
 * The tier default is the mechanism that lets Smart + Balanced
 * share one Venice model id and still feel different — Smart's
 * `defaultReasoningEffort: 'high'` and Balanced's `'low'` win over
 * the user's account default when the user hasn't explicitly set a
 * per-thread effort. The user's thread-level choice still wins over
 * everything, so anyone who prefers the account default can pin it
 * per thread and Nak won't override.
 *
 * Callers still have to gate on `MODELS[tier].supportsReasoning`
 * before putting the result on the wire — some providers 400 on a
 * `reasoning_effort` field they don't recognise.
 */
export function resolveReasoningEffort(
  threadEffort: ReasoningEffort | null,
  defaultEffort: ReasoningEffort,
  tierDefault?: ReasoningEffort | null
): ReasoningEffort {
  return threadEffort ?? tierDefault ?? defaultEffort;
}

/**
 * Resolve the verbosity level to use for a given thread. Same
 * "override wins over default" shape as resolveTier /
 * resolveReasoningEffort. Unlike reasoning_effort, we don't gate on
 * a `supportsVerbosity` capability flag — `text.verbosity` is a
 * plain OpenAI-shape field that providers either honor or silently
 * ignore. The caller is responsible for deciding whether to send it.
 */
export function resolveVerbosity(
  threadVerbosity: Verbosity | null,
  defaultVerbosity: Verbosity
): Verbosity {
  return threadVerbosity ?? defaultVerbosity;
}

/**
 * Reverse lookup: given a Venice model id (e.g. 'kimi-k2-5'), return the
 * ModelSpec whose `id` matches. Used by the per-message context-window
 * indicator — a message row stores the concrete id it was answered by,
 * and we need the id → contextWindow map to compute a percentage.
 *
 * Returns null when no tier matches, which happens on rows written under
 * a now-retired model id (we've retargeted the tier in the meantime but
 * old rows still carry the old id). Callers that need the window for
 * the ring should fall back to `findContextWindowById` rather than
 * inventing label/icon/description for an id we no longer front.
 */
export function findModelById(id: string | null | undefined): ModelSpec | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  for (const spec of Object.values(MODELS)) {
    if (spec.id === id) return spec;
  }
  return null;
}

/**
 * Context windows for model ids that used to front a tier but have
 * since been swapped out. Historical `messages.model` values still
 * carry these ids; without this map, every pre-swap assistant message
 * would silently lose its context-ring indicator the moment a tier
 * re-targeted, because findModelById correctly refuses to vend a spec
 * for an id we no longer advertise.
 *
 * Add an entry here whenever you change a tier's `id` in MODELS above,
 * pinning the window at whatever the retired id actually served. Do
 * not delete rows even once the swap feels old — removing one hides
 * the ring on every historical message answered by that id.
 */
const RETIRED_MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  // Retired Balanced-tier ids, in swap order (oldest first). Each
  // window is whatever Venice reported for that id at the moment we
  // stopped fronting it — pinned so a re-target doesn't silently
  // retroactively shrink the ring on historical messages.
  'arcee-trinity-large-thinking': 256_000,
  'gemma-4-uncensored': 198_000,
  'zai-org-glm-5': 198_000,
  'kimi-k2-5': 256_000,
  // Retired Smart-tier ids.
  'kimi-k2-6': 256_000,
  // Retired Fast-tier ids.
  'grok-41-fast': 1_000_000,
};

/**
 * Ring-only helper: resolves the context window for any model id the
 * app has ever fronted, falling back to RETIRED_MODEL_CONTEXT_WINDOWS
 * when findModelById returns null. The ring needs just the window —
 * not the full ModelSpec — so we keep this separate rather than
 * synthesizing a fake spec.
 */
export function findContextWindowById(id: string | null | undefined): number | null {
  const spec = findModelById(id);
  if (spec) return spec.contextWindow;
  if (typeof id !== 'string' || id.length === 0) return null;
  return RETIRED_MODEL_CONTEXT_WINDOWS[id] ?? null;
}

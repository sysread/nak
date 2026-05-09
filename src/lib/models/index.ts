/**
 * Model registry and helpers. Three concerns, one file:
 *
 *   1. MODELS - flat registry keyed by Venice id. Every model the app
 *      currently pins (whether from a tier or an agent role) lives here
 *      as a ModelSpec carrying the capability data every consumer reads
 *      (contextWindow, supportsReasoning, supportsVision,
 *      supportsResponseFormat).
 *
 *   2. TIERS - user-facing tier wrappers (Smart / Balanced / Fast). Each
 *      TierSpec carries a ModelSpec entry's capability data plus the UI
 *      fields the tier picker reads (label, icon, description) and an
 *      optional defaultReasoningEffort that lets two tiers fronting the
 *      same Venice id still feel different.
 *
 *   3. AGENT_MODELS - one-line-per-role mapping from background-agent
 *      roles (journal, reflection, intuition, ...) to a registered
 *      Venice id. Swapping an agent's model is a single edit; the
 *      rationale per slot lives in the docblock on AGENT_MODELS itself
 *      rather than scattered across the agent files.
 *
 * Retired ids - model strings that used to front a tier or an agent but
 * no longer do - live in ./legacy.ts. `findContextWindowById` reads
 * from both maps so the per-message context ring on historical
 * assistant rows keeps resolving long after a swap.
 *
 * Why the indirection: Venice (and AI providers generally) rotate model
 * names aggressively. If we stored a literal id like 'kimi-k2-5' on
 * every thread row, changing the Smart tier to a newer model would
 * orphan every existing thread. Storing the tier name on the row means
 * we can retarget by editing this file alone - the same thinking
 * applies to AGENT_MODELS for the background agents.
 */

import { LEGACY_MODELS, type LegacyModelSpec } from './legacy';

export { LEGACY_MODELS, type LegacyModelSpec };

// --- Reasoning / verbosity wire-config knobs -------------------------------

export type ModelTier = 'smart' | 'balanced' | 'fast';

/**
 * OpenAI-style reasoning_effort knob. Passed through verbatim in the
 * `reasoning_effort` body field on /chat/completions - Venice forwards
 * it to the underlying provider. Only meaningful on models whose
 * ModelSpec marks `supportsReasoning: true`; ignored on others (some
 * providers 400 on the unknown field, so we omit it entirely when the
 * resolved model can't reason).
 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

/**
 * Default when the user hasn't picked anything explicitly. `low` keeps
 * latency in the chat-turn ballpark - `medium` / `high` can stretch a
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
 * through on /chat/completions nested under `text` - i.e. body shape
 * `{text: {verbosity: '...'}}`. Controls how long the assistant's answers
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
 * the neutral middle - neither forcing terse single-line answers nor
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

// --- Model capability data -------------------------------------------------

/**
 * Pure capability data for a single Venice model id. Carries everything
 * a call site (or the UI) might need to know about the model itself
 * without committing to a tier or an agent role. Tier-specific UI
 * fields (label, icon, description) live on TierSpec; tier-default
 * reasoning effort lives there too because the same model can serve
 * two tiers with different defaults.
 */
export interface ModelSpec {
  readonly id: string;
  /** Context window in tokens. */
  readonly contextWindow: number;
  /**
   * True when the id accepts the OpenAI-style `reasoning_effort` body
   * field. Drives the per-thread reasoning picker (hidden when false)
   * and the chat-loop's decision to forward the field at all -
   * non-reasoning models 4xx on the unknown knob in many cases.
   */
  readonly supportsReasoning: boolean;
  /**
   * True when the model accepts OpenAI-compatible multimodal input
   * (`content` as `{type:'text'|'image_url', ...}` parts). Drives
   * src/lib/attachments.ts's pre-send routing: vision-capable models
   * inline images directly; everything else routes through
   * analyze_image() and gets a transcribed-description payload.
   */
  readonly supportsVision: boolean;
  /**
   * True when the id accepts `response_format: {type:'json_object'}`.
   * Background agents that pin structured output (journal, both recall
   * agents) gate on this when picking a model id - some Venice models
   * 4xx on the field (minimax-m25 was a real bug; see the docblock on
   * AGENT_MODELS.journal). Currently documentation only; no call site
   * reads it programmatically yet.
   */
  readonly supportsResponseFormat: boolean;
}

/**
 * Active model registry. Keyed by Venice id; every entry is something
 * Nak currently points at from a tier or an agent. Retired ids live
 * in ./legacy.ts.
 *
 * Declared `as const satisfies Record<string, ModelSpec>` so the keys
 * are literal-typed - that lets AGENT_MODELS below enforce at compile
 * time that every agent role points at a registered id. Don't lose
 * the `as const`: dropping it widens the keys to `string` and the
 * agent-table check becomes a no-op.
 */
export const MODELS = {
  'zai-org-glm-5-1': {
    id: 'zai-org-glm-5-1',
    contextWindow: 200_000,
    supportsReasoning: true,
    // GLM-5.1 is text-only on Venice - images route through analyze_image().
    supportsVision: false,
    supportsResponseFormat: true,
  },
  'zai-org-glm-5': {
    id: 'zai-org-glm-5',
    contextWindow: 198_000,
    supportsReasoning: true,
    // GLM-5 is text-only on Venice - images route through analyze_image().
    supportsVision: false,
    supportsResponseFormat: true,
  },
  'zai-org-glm-4.7': {
    id: 'zai-org-glm-4.7',
    contextWindow: 198_000,
    supportsReasoning: true,
    // GLM-4.7 is text-only on Venice - images route through analyze_image().
    supportsVision: false,
    supportsResponseFormat: true,
  },
  'deepseek-v4-flash': {
    id: 'deepseek-v4-flash',
    contextWindow: 1_000_000,
    supportsReasoning: true,
    supportsVision: false,
    supportsResponseFormat: true,
  },
  'mistral-small-3-2-24b-instruct': {
    id: 'mistral-small-3-2-24b-instruct',
    contextWindow: 256_000,
    // Venice's mistral-small does NOT accept reasoning_effort. Sending
    // the field returns a 4xx, so the agents pinned to this id
    // (intuition, summary, samskara) all omit it on the wire.
    supportsReasoning: false,
    supportsVision: false,
    supportsResponseFormat: true,
  },
  'qwen3-5-35b-a3b': {
    id: 'qwen3-5-35b-a3b',
    contextWindow: 256_000,
    supportsReasoning: true,
    supportsVision: false,
    supportsResponseFormat: true,
  },
  'e2ee-qwen3-5-122b-a10b': {
    id: 'e2ee-qwen3-5-122b-a10b',
    contextWindow: 128_000,
    supportsReasoning: true,
    // Vision-capable; this is the id the analyze_image tool uses for
    // its sub-completions. The `e2ee-` prefix is Venice's marker for
    // end-to-end-encrypted serving.
    supportsVision: true,
    supportsResponseFormat: true,
  },
} as const satisfies Record<string, ModelSpec>;

export type ModelId = keyof typeof MODELS;

// --- User-facing tier system -----------------------------------------------

/**
 * A tier is a Venice id wrapped with the UI fields the tier picker
 * needs (label, icon, description) plus an optional reasoning-effort
 * default that lets two tiers serving the same Venice id feel
 * different. Extends ModelSpec so consumers can read either UI fields
 * (`TIERS[tier].label`) or capability fields (`TIERS[tier].contextWindow`,
 * `TIERS[tier].supportsReasoning`) off the same struct.
 */
export interface TierSpec extends ModelSpec {
  readonly tier: ModelTier;
  readonly label: string;
  readonly icon: string;
  readonly description: string;
  /**
   * Tier-level reasoning_effort default. When set, wins over the user's
   * account-level default (but not the per-thread override). Used to
   * differentiate two tiers fronting the same Venice id - e.g. when
   * Smart and Balanced both ran kimi-k2-6, the tier labels were really
   * "same model, different thinking budgets" and this field is what
   * realised that contract. Absent means "no tier opinion - fall
   * through to the user default." Only consulted when the underlying
   * model's supportsReasoning is also true.
   */
  readonly defaultReasoningEffort?: ReasoningEffort;
}

export const TIERS: Readonly<Record<ModelTier, TierSpec>> = {
  smart: {
    ...MODELS['zai-org-glm-5-1'],
    tier: 'smart',
    label: 'Smart',
    icon: '🧠',
    description: 'GLM-5.1 with deep thinking. Best for hard problems.',
    defaultReasoningEffort: 'high',
  },
  balanced: {
    ...MODELS['zai-org-glm-5'],
    tier: 'balanced',
    label: 'Balanced',
    // U+262F YIN YANG + U+FE0F emoji presentation. Chosen over U+2696
    // SCALES because the scales glyph is all thin strokes in every
    // major emoji font, and it vanishes against the toggle background
    // in both themes; yin-yang is a solid bi-tonal disc that reads at
    // any size.
    icon: '\u262F\uFE0F',
    description: 'GLM-5 with light thinking. Good default for most turns.',
    defaultReasoningEffort: 'low',
  },
  fast: {
    ...MODELS['zai-org-glm-4.7'],
    tier: 'fast',
    label: 'Fast',
    icon: '\u26A1\uFE0F',
    description: 'GLM-4.7. Fast, 198k context.',
  },
};

/** Iteration order for the tier picker. Smart -> Balanced -> Fast. */
export const TIER_ORDER: readonly ModelTier[] = ['smart', 'balanced', 'fast'];

export const DEFAULT_TIER: ModelTier = 'balanced';

// --- Background-agent assignments ------------------------------------------

/**
 * Roles that have their own pinned Venice id, separate from the user-
 * facing tier system. Adding a role here is a three-step change: list
 * the role here, add the assignment in AGENT_MODELS below, switch the
 * call site to `agentModel('<role>').id`.
 */
export type AgentRole =
  | 'journal'
  | 'reflection'
  | 'wiki'
  | 'webSearch'
  | 'researchDocs'
  | 'intuition'
  | 'summary'
  | 'samskara'
  | 'recall'
  | 'conversationRecall'
  | 'visionAnalysis';

/**
 * Background-agent role -> Venice id. The right-hand side is checked
 * against `keyof typeof MODELS` at compile time so every assignment
 * has to point at a registered model spec; a typo or a missing
 * MODELS entry is a tsc error rather than a runtime "model not
 * found" 4xx.
 *
 * Per-slot rationale (kept here rather than at call sites so the
 * decision context lives next to the swap):
 *
 *   journal - deepseek-v4-flash. The journaler walks every settled
 *     conversation in the background, so capacity isolation from the
 *     foreground tiers and a wide context window matter more than
 *     per-call latency. The 1M-token window swallows even long
 *     threads without a summariser layer. Hard constraint on any
 *     pin: the id MUST accept `response_format: {type:
 *     'json_object'}` - the prompt's prose schema covers "right
 *     intent, wrong shape" but not "ignored the JSON instruction
 *     entirely."
 *
 *     Predecessors and why they were dropped:
 *       - The balanced profile (GLM-5) hit overload errors -
 *         foreground tier sharing capacity.
 *       - `nvidia-nemotron-cascade-2-30b-a3b` was tried twice.
 *         First pass produced visibly weak entries, but the agent
 *         at the time was carrying a tool loop with
 *         `reasoning_effort: 'medium'`, so the failure mode could
 *         plausibly have been small-model tool fumbling rather
 *         than baseline writing quality. The second pin under the
 *         no-tools, no-thinking shape was reverted before it
 *         gathered data.
 *       - `zai-org-glm-4.7-flash` overloaded under the background
 *         load, suggesting it shares capacity with the Fast tier
 *         in practice despite the lower price.
 *       - `minimax-m25` 4xx'd on the `response_format` field. The
 *         wire-level JSON pin is load-bearing.
 *       - `qwen3-235b-a22b-instruct-2507` with thinking disabled
 *         held the JSON shape fine but couldn't hold the prose-
 *         discipline constraints simultaneously - entries
 *         interpreted every utterance as load-bearing and padded
 *         philosophical framing with imported topical knowledge.
 *       - `qwen3-5-35b-a3b` with reasoning at 'low'. Smaller and
 *         cheaper, with a thinking budget for the dense constraint
 *         set, but the same Qwen failure modes persisted
 *         (attribution slips, context imports, over-
 *         interpretation). Three Qwen variants in a row failing
 *         the same way looked like Qwen's known constraint
 *         amnesia on long instruction stacks and motivated the
 *         family swap to Trinity.
 *       - `arcee-trinity-large-thinking` with `reasoning_effort:
 *         'low'`. Non-Qwen reasoning model, 256k context. Held the
 *         prose-discipline constraints the Qwen pins kept dropping,
 *         confirming the bottleneck was the model family rather
 *         than the prompt. Slower and more expensive than the
 *         deepseek-v4-flash trial that replaced it; revert here
 *         if deepseek's entry quality lags.
 *
 *     If overload errors return, the next move is yet another
 *     non-user-fronted id. Don't fall back to Smart / Balanced /
 *     Fast tier ids - the journaler walking every settled thread
 *     in order in the background should never fight foreground
 *     turns for capacity. If the prompt's dense constraint set
 *     defeats yet another model family, the next move is the
 *     two-stage architecture (separate clinical-analyst and
 *     narrative passes, each with a focused subset of the
 *     constraints) rather than another single-model swap.
 *
 *   reflection - deepseek-v4-flash. Same shape as journal: read the
 *     thread, make some judgments, call the memory tools. Big-window
 *     model is the win - the entire conversation is the context.
 *
 *   wiki - deepseek-v4-flash. Autonomous wiki agent: read a settled
 *     thread the day after, decide which topics warrant a new article
 *     or an update to an existing one, and dispatch wiki_search /
 *     wiki_create / wiki_update / wiki_delete tool calls. The same
 *     model also runs the synchronous "ask agent to update" flow
 *     from the per-article UI (single completion, response_format
 *     pinned to JSON, no tool loop). Same rationale as reflection -
 *     big window swallows the conversation, capacity isolation from
 *     foreground tiers, and the JSON pin works on the manual path.
 *
 *   webSearch - deepseek-v4-flash. The `web_search` tool's sub-
 *     completion summarises Venice-provided results into 2-4
 *     sentences with citation markers. Bounded synthesis; the call
 *     site forces disable_thinking so the model can't burn the
 *     output budget on a CoT preamble.
 *
 *   researchDocs - deepseek-v4-flash. The `research_docs` tool's
 *     sub-completion reads the bundled docs and answers in 2-5
 *     sentences. Same bounded-synthesis profile as webSearch.
 *
 *   intuition - mistral-small-3-2-24b-instruct. The pre-turn pulse
 *     fires before every assistant turn; latency is the primary
 *     constraint. Mistral-small is non-reasoning by spec, which
 *     matches the call site's disable_thinking pin and avoids any
 *     CoT overhead per call.
 *
 *   summary - mistral-small-3-2-24b-instruct. "Read the conversation,
 *     write 2-3 sentences" - cheap, bounded, output goes into a
 *     single embedding vector. No reasoning required.
 *
 *   samskara - mistral-small-3-2-24b-instruct. Five short JSON-out
 *     phases (assimilate, relate, mint, classify, compound summary)
 *     with maxTokens 200-500 per phase. Structured output on bounded
 *     context; mistral-small handles it comfortably.
 *
 *   recall - qwen3-5-35b-a3b. Memory-recall agent: read the live
 *     conversation, search memories, produce a short note. Bounded
 *     synthesis with a wire-level response_format pin. Distinct
 *     constant from conversationRecall so the two recall surfaces
 *     can be tuned independently if one regresses.
 *
 *   conversationRecall - qwen3-5-35b-a3b. Conversation-recall agent;
 *     same shape and rationale as recall.
 *
 *   visionAnalysis - e2ee-qwen3-5-122b-a10b. Vision sub-completion
 *     for the analyze_image tool. Decoupled from any user-facing
 *     tier so a tier retarget doesn't silently break image
 *     analysis. Switched here from mistral-small-2603 after that
 *     model consistently missed detail on dense or text-heavy
 *     images.
 */
export const AGENT_MODELS = {
  journal:            'deepseek-v4-flash',
  reflection:         'deepseek-v4-flash',
  wiki:               'deepseek-v4-flash',
  webSearch:          'deepseek-v4-flash',
  researchDocs:       'deepseek-v4-flash',
  intuition:          'mistral-small-3-2-24b-instruct',
  summary:            'mistral-small-3-2-24b-instruct',
  samskara:           'mistral-small-3-2-24b-instruct',
  recall:             'qwen3-5-35b-a3b',
  conversationRecall: 'qwen3-5-35b-a3b',
  visionAnalysis:     'e2ee-qwen3-5-122b-a10b',
} as const satisfies Record<AgentRole, ModelId>;

/**
 * Resolve the ModelSpec for a given background-agent role. Total
 * function (every role is checked at compile time to point at a
 * registered MODELS entry); never returns null.
 */
export function agentModel(role: AgentRole): ModelSpec {
  return MODELS[AGENT_MODELS[role]];
}

// --- Embeddings ------------------------------------------------------------

/**
 * Venice's embeddings model. Single constant rather than a tier because
 * Venice only ships one embeddings model today. If Venice ever
 * introduces a second model, this string becomes the current default
 * and the `embedding_model` column on each row lets us locate rows
 * stamped with the older id (`where embedding_model <> VENICE_EMBEDDING_MODEL`)
 * for re-embedding.
 */
export const VENICE_EMBEDDING_MODEL = 'text-embedding-bge-m3';

/**
 * Native output dimension of VENICE_EMBEDDING_MODEL - the length of each
 * `embedding` array returned by /embeddings. bge-m3 emits 1024.
 */
export const VENICE_EMBEDDING_DIMS = 1024;

/**
 * Column dimension of `memories.embedding` in `supabase/schema.sql`. We
 * store wider than the current model emits so a future model rotation
 * (say Venice adding a 2048-dim model) doesn't force an `ALTER TYPE
 * vector(N)` on the column - ALTER TYPE on a pgvector column requires
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
 * latency - doubling cos-sim compute per row to cover a future model we
 * don't have yet. At memories-scale (hundreds of rows per user) the
 * extra cost is unobservable. If we ever need HNSW we'd switch to
 * `halfvec(2048)`, which pgvector indexes up to 4000 dims.
 */
export const EMBEDDING_STORAGE_DIMS = 2048;

/**
 * Zero-extend a Venice embedding to the storage dimension. Pure function,
 * safe to call on any length up to EMBEDDING_STORAGE_DIMS. A longer input
 * is a bug - either VENICE_EMBEDDING_DIMS is stale or the caller handed
 * us someone else's vector - so we throw rather than silently truncate,
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

// --- Helpers ---------------------------------------------------------------

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
 *   per-thread override -> tier default -> user account default
 *
 * The tier default is the mechanism that lets Smart + Balanced share
 * one Venice model id and still feel different - Smart's
 * `defaultReasoningEffort: 'high'` and Balanced's `'low'` win over the
 * user's account default when the user hasn't explicitly set a per-
 * thread effort. The user's thread-level choice still wins over
 * everything, so anyone who prefers the account default can pin it
 * per thread and Nak won't override.
 *
 * Callers still have to gate on `TIERS[tier].supportsReasoning` (or
 * the agent's spec from `agentModel(role)`) before putting the result
 * on the wire - some providers 400 on a `reasoning_effort` field they
 * don't recognise.
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
 * a `supportsVerbosity` capability flag - `text.verbosity` is a
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
 * Reverse lookup: given a Venice model id, return the active ModelSpec
 * keyed under it. Only resolves currently-active ids; returns null for
 * retired ids (use `findContextWindowById` for the ring's broader
 * lookup that includes the legacy registry).
 *
 * Used by callers that need capability flags - the ring just needs
 * the window and reads `findContextWindowById` directly.
 */
export function findModelById(id: string | null | undefined): ModelSpec | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  return (MODELS as Readonly<Record<string, ModelSpec>>)[id] ?? null;
}

/**
 * Ring helper: returns the context window for any model id Nak has
 * ever pinned. Falls back to the legacy registry when the id isn't
 * active. Used by AssistantBody.svelte's per-message context-window
 * indicator on assistant rows whose `model` column references either
 * a current id or a retired one.
 */
export function findContextWindowById(id: string | null | undefined): number | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  const active = (MODELS as Readonly<Record<string, ModelSpec>>)[id];
  if (active) return active.contextWindow;
  return LEGACY_MODELS[id]?.contextWindow ?? null;
}

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
 *      optional defaultThinking level (including 'off') that lets tiers
 *      feel different in their default reasoning budget.
 *
 *   3. AGENT_MODELS - one-line-per-role mapping from background-agent
 *      roles (reflection, wiki, intuition, ...) to a registered
 *      Venice id. Swapping an agent's model is a single edit; the
 *      rationale per slot lives in the docblock on AGENT_MODELS itself
 *      rather than scattered across the agent files.
 *
 * There is no retired-id registry. Threads store a tier, not a concrete
 * id (see below), so a model leaving Venice never orphans a thread - the
 * tier just resolves to its current backing model. The per-message
 * context ring measures each row against the thread's CURRENT model
 * window (passed in by the caller), not the window of whatever model
 * historically answered it, so no historical-id lookup is needed either.
 *
 * Why the indirection: Venice (and AI providers generally) rotate model
 * names aggressively. If we stored a literal id like 'kimi-k2-5' on
 * every thread row, changing the Smart tier to a newer model would
 * orphan every existing thread. Storing the tier name on the row means
 * we can retarget by editing this file alone - the same thinking
 * applies to AGENT_MODELS for the background agents.
 */

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
 * The composer reasoning picker's domain: the three reasoning_effort
 * levels plus an explicit 'off'. Kept separate from ReasoningEffort on
 * purpose - ReasoningEffort is wire-faithful to the `reasoning_effort`
 * body field (Venice 400s on anything outside low/medium/high), whereas
 * 'off' is not a reasoning_effort value at all: it maps to the distinct
 * `venice_parameters.disable_thinking` knob. The two wire knobs are
 * mutually exclusive (off wins), so the picker offers a single 4-way
 * choice and `thinkingToWire` splits it back into whichever knob the
 * level implies. The Settings account-default picker deliberately does
 * NOT use this domain - an account-wide "off" doesn't make sense, so it
 * stays on REASONING_EFFORTS (low/medium/high only).
 */
export type ThinkingLevel = 'off' | ReasoningEffort;

export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high'];

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return v === 'off' || isReasoningEffort(v);
}

/** Display labels for the picker. 'Off' reads as "no thinking pass." */
export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: 'Off',
  ...REASONING_EFFORT_LABELS,
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
   * Background agents that pin structured output (the three recall
   * agents) gate on this when picking a model id - some Venice models
   * 4xx on the field (minimax-m25 was a real bug). Currently
   * documentation only; no call site reads it programmatically yet.
   */
  readonly supportsResponseFormat: boolean;
  /**
   * True when this model is known to leak its own special tokens into
   * the content stream - opening a reply with the literal text of a
   * control token (and usually a burst of unrelated code) instead of
   * answering. Arms the client-side special-token-leak guard for the
   * model (see `streamGuardsFor` in ../stream-guards.ts), which detects
   * the leak by the token's opening delimiter and re-rolls.
   *
   * DeepSeek-family models on Venice sometimes open with their own
   * `<｜begin▁of▁sentence｜>` token. We deliberately do NOT also send a
   * server-side `stop` / `stop_token_ids`: `stop` matches anywhere in
   * the output, so it would truncate a legitimate reply that mentions
   * one of these sequences mid-stream (a real case for nak, whose users
   * discuss these tokens), and we have no verified token ids for the
   * model. The client guard is anchored to the opening, so it only
   * fires on the actual failure mode.
   */
  readonly leaksSpecialTokens?: boolean;
}

/**
 * Active model registry. Keyed by Venice id; every entry is something
 * Nak currently points at from a tier or an agent - this is the small
 * curated seed that makes chat and the background agents work
 * synchronously and offline. The live Venice catalog (./catalog.ts)
 * supplies capability data for every OTHER model, but only in the
 * Settings model picker; the hot path never reaches for it.
 *
 * Declared `as const satisfies Record<string, ModelSpec>` so the keys
 * are literal-typed - that lets AGENT_MODELS below enforce at compile
 * time that every agent role points at a registered id. Don't lose
 * the `as const`: dropping it widens the keys to `string` and the
 * agent-table check becomes a no-op.
 */
export const MODELS = {
  'qwen-3-7-plus': {
    id: 'qwen-3-7-plus',
    contextWindow: 1_000_000,
    supportsReasoning: true,
    // Native vision: image_url parts can be inlined directly without
    // routing through the analyze_image tool.
    supportsVision: true,
    supportsResponseFormat: true,
  },
  'deepseek-v4-flash': {
    id: 'deepseek-v4-flash',
    contextWindow: 1_000_000,
    supportsReasoning: true,
    supportsVision: false,
    supportsResponseFormat: true,
    // This model occasionally leaks `<｜begin▁of▁sentence｜>` at the
    // head of a reply; arm the client-side special-token-leak guard.
    // See ModelSpec.leaksSpecialTokens.
    leaksSpecialTokens: true,
  },
  'tencent-hy3-preview': {
    id: 'tencent-hy3-preview',
    // 295B-param MoE (21B active) from Tencent Hy. Backs the web_search
    // tool's sub-completion. Beta model on Venice (model_spec.betaModel),
    // so expect occasional churn in availability.
    contextWindow: 256_000,
    // Reasoning-capable: reasoning_effort options are none/low/high
    // (default high). The web_search sub-call zeroes the CoT via
    // disable_thinking so the budget goes to answer text, not reasoning.
    supportsReasoning: true,
    supportsVision: false,
    supportsResponseFormat: true,
  },
  'mistral-small-3-2-24b-instruct': {
    id: 'mistral-small-3-2-24b-instruct',
    contextWindow: 256_000,
    // Venice's mistral-small does NOT accept reasoning_effort. Sending
    // the field returns a 4xx, so every agent pinned to this id
    // (intuition browser-side; samskara and bias server-side) omits
    // it on the wire.
    supportsReasoning: false,
    supportsVision: false,
    supportsResponseFormat: true,
  },
  'e2ee-qwen3-vl-30b-a3b-p': {
    id: 'e2ee-qwen3-vl-30b-a3b-p',
    contextWindow: 128_000,
    // Not a reasoning model: it has no chain-of-thought pass, so the
    // analyze_image call must not send `reasoning_effort` (Venice 4xxs
    // on the field for non-reasoning ids). The call site omits it
    // anyway - it never sets reasoningEffort - so the wire payload
    // stays clean. See buildChatBody in venice.ts (reasoning_effort is
    // only forwarded when the caller opts in).
    supportsReasoning: false,
    // Vision-capable. analyze_image's primary vision sub-call uses this
    // id; that tool runs server-side (supabase/functions/venice/tools/
    // analyze_image.ts) and falls back to venice-uncensored-1-2 when
    // this model fails. Listed here as a known Venice model and to back
    // the supportsVision contract; the edge tool holds the id directly
    // (it can't import from src/lib). The `e2ee-` prefix is Venice's
    // marker for end-to-end-encrypted serving.
    supportsVision: true,
    supportsResponseFormat: true,
  },
  'venice-uncensored-1-2': {
    id: 'venice-uncensored-1-2',
    contextWindow: 128_000,
    // Non-reasoning vision model: analyze_image's permissive fallback,
    // tried when the primary vision sub-call fails - e.g. a spurious
    // content-safety block on an innocuous photo. That tool runs
    // server-side (supabase/functions/venice/tools/analyze_image.ts)
    // and holds this id directly; listed here as a known Venice model
    // and to back the supportsVision contract.
    supportsReasoning: false,
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
   * Tier-level default thinking level - the picker position a thread
   * starts at before the user touches it. Sits in the resolution
   * cascade between the per-thread override (wins) and the user's
   * account-level reasoning default (loses): see resolveThinking. The
   * value can be 'off', which is how a tier ships with thinking
   * disabled - 'off' resolves to `venice_parameters.disable_thinking`
   * rather than a `reasoning_effort` value (reasoning_effort: 'low'
   * shrinks the CoT but doesn't zero it; only disable_thinking does).
   * Smart defaults to 'medium', Balanced and Fast to 'off'. Absent
   * means "no tier opinion - fall through to the user default." Only
   * consulted when the underlying model's supportsReasoning is true.
   *
   * Note this is a DEFAULT, not a lock: the composer reasoning picker
   * stays visible on every reasoning-capable tier, so a user can move
   * an 'off'-defaulted thread up to low/medium/high (or vice versa)
   * for that one conversation.
   */
  readonly defaultThinking?: ThinkingLevel;
}

export const TIERS: Readonly<Record<ModelTier, TierSpec>> = {
  smart: {
    ...MODELS['qwen-3-7-plus'],
    tier: 'smart',
    label: 'Smart',
    icon: '🧠',
    description: 'Qwen 3.7 Plus with medium thinking. 1M context, native vision. Best for hard problems.',
    defaultThinking: 'medium',
  },
  balanced: {
    ...MODELS['deepseek-v4-flash'],
    tier: 'balanced',
    label: 'Balanced',
    // U+262F YIN YANG + U+FE0F emoji presentation. Chosen over U+2696
    // SCALES because the scales glyph is all thin strokes in every
    // major emoji font, and it vanishes against the toggle background
    // in both themes; yin-yang is a solid bi-tonal disc that reads at
    // any size.
    icon: '\u262F\uFE0F',
    description: 'DeepSeek V4 Flash with light thinking. Good default for most turns.',
    // Light thinking by default - 'low' keeps a short CoT pass that
    // catches obvious slips without paying a long-think latency tax
    // on every turn. Balanced and Fast both front deepseek-v4-flash;
    // the only difference is this default ('low' vs 'off'). A user
    // can bump per thread via the composer picker either way.
    defaultThinking: 'low',
  },
  fast: {
    ...MODELS['deepseek-v4-flash'],
    tier: 'fast',
    label: 'Fast',
    icon: '\u26A1\uFE0F',
    description: 'DeepSeek V4 Flash with thinking off. Quickest replies.',
    // Defaulting to 'off' is what makes the Fast tier feel fast even
    // though it fronts a reasoning-capable model - without it the model
    // would burn its default thinking budget on CoT before writing any
    // user-visible text. A user can still bump a single thread back to
    // low/medium/high via the composer picker.
    defaultThinking: 'off',
  },
};

/** Iteration order for the tier picker. Smart -> Balanced -> Fast. */
export const TIER_ORDER: readonly ModelTier[] = ['smart', 'balanced', 'fast'];

export const DEFAULT_TIER: ModelTier = 'balanced';

// --- User-configurable tier overrides --------------------------------------

/**
 * A user's chosen backing for one tier, persisted in
 * `profiles.settings.tierModels`. The Settings AI pane lets the user
 * point a tier at any model the Venice catalog advertises and set that
 * tier's default reasoning effort; this is the snapshot that records the
 * choice.
 *
 * Why a capability snapshot rather than just `{ modelId, thinking }`:
 * the live catalog (./catalog.ts) is fetched lazily - only when the
 * Settings pane opens. Chat resolution runs synchronously on every send
 * and cannot wait on (or assume the presence of) an async catalog fetch.
 * So the capability fields the send path needs - context window, whether
 * to forward `reasoning_effort`, whether images can be inlined - are
 * captured here at pick time from the catalog and read back without a
 * network round trip. The trade-off is staleness: if Venice later
 * changes a model's capabilities the snapshot lags until the user
 * re-picks. Capabilities for a fixed id rarely change, so this is
 * acceptable.
 *
 * Note the curated safety flags (leaksSpecialTokens) are deliberately
 * NOT snapshotted - those keep living in MODELS keyed by concrete id, so
 * `modelLeaksSpecialTokens(snapshot.modelId)` still arms the slop guard
 * for a user who points a tier at a known-leaky model. The catalog can't
 * supply that flag, so there's nothing to snapshot.
 */
export interface TierModelConfig {
  readonly modelId: string;
  /** Tier-level default reasoning level; may be 'off'. */
  readonly thinking: ThinkingLevel;
  readonly contextWindow: number;
  /** Whether to forward `reasoning_effort` on this tier's requests. */
  readonly supportsReasoning: boolean;
  readonly supportsVision: boolean;
  readonly supportsResponseFormat: boolean;
  /** Catalog display name captured at pick time, for the picker summary. */
  readonly label: string;
}

/** Per-tier override map. Absent tiers fall back to the built-in TierSpec. */
export type TierModels = Partial<Record<ModelTier, TierModelConfig>>;

/**
 * Validate one persisted tier-config blob. Total + defensive: returns
 * null on any shape mismatch so a corrupt settings entry degrades to the
 * built-in tier default rather than poisoning resolution. Used by
 * coerceSettings in supabase.ts on read.
 */
export function coerceTierModelConfig(raw: unknown): TierModelConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.modelId !== 'string' || r.modelId.length === 0) return null;
  if (!isThinkingLevel(r.thinking)) return null;
  if (typeof r.contextWindow !== 'number' || !Number.isFinite(r.contextWindow)) {
    return null;
  }
  if (typeof r.supportsReasoning !== 'boolean') return null;
  if (typeof r.supportsVision !== 'boolean') return null;
  if (typeof r.supportsResponseFormat !== 'boolean') return null;
  const label =
    typeof r.label === 'string' && r.label.length > 0 ? r.label : r.modelId;
  return {
    modelId: r.modelId,
    thinking: r.thinking,
    contextWindow: r.contextWindow,
    supportsReasoning: r.supportsReasoning,
    supportsVision: r.supportsVision,
    supportsResponseFormat: r.supportsResponseFormat,
    label,
  };
}

/**
 * Coerce the whole `tierModels` map: keep only well-formed entries under
 * a real tier key. Returns undefined when nothing survives so the stored
 * blob and the in-memory state both treat "no overrides" as absence.
 */
export function coerceTierModels(raw: unknown): TierModels | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: TierModels = {};
  for (const tier of TIER_ORDER) {
    const config = coerceTierModelConfig(r[tier]);
    if (config) out[tier] = config;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolve the effective TierSpec for a tier, folding any user override on
 * top of the built-in default. The tier's identity (label, icon) is
 * always the built-in one - Smart stays Smart - but the backing model,
 * its capabilities, and the default reasoning level come from the
 * snapshot when the user has configured this tier. Pure and synchronous:
 * the snapshot carries everything resolution needs, so no catalog lookup
 * happens here.
 *
 * The description is regenerated from the override so a stale built-in
 * blurb ("Qwen 3.7 Plus with medium thinking") never contradicts the
 * model the user actually picked.
 */
export function effectiveTierSpec(tier: ModelTier, tierModels?: TierModels): TierSpec {
  const base = TIERS[tier];
  const override = tierModels?.[tier];
  if (!override) return base;
  return {
    ...base,
    id: override.modelId,
    contextWindow: override.contextWindow,
    supportsReasoning: override.supportsReasoning,
    supportsVision: override.supportsVision,
    supportsResponseFormat: override.supportsResponseFormat,
    defaultThinking: override.thinking,
    description: `${override.label} - ${THINKING_LEVEL_LABELS[override.thinking].toLowerCase()} thinking.`,
  };
}

// --- Background-agent assignments ------------------------------------------

/**
 * Roles that have their own pinned Venice id, separate from the user-
 * facing tier system. Adding a role here is a three-step change: list
 * the role here, add the assignment in AGENT_MODELS below, switch the
 * call site to `agentModel('<role>').id`.
 */
export type AgentRole =
  | 'reflection'
  | 'wiki'
  | 'wikiLibrarian'
  | 'deepSleep'
  | 'rem'
  | 'webSearch'
  | 'researchDocs'
  | 'intuition'
  | 'recall'
  | 'conversationRecall'
  | 'wikiRecall';

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
 *   reflection - deepseek-v4-flash. Read the thread, make some
 *     judgments, call the memory tools. Big-window model is the win -
 *     the entire conversation is the context.
 *
 *     NOTE on capacity: the Balanced and Fast foreground tiers ALSO
 *     front this id (Smart is on qwen-3-7-plus). The
 *     earlier policy of "background agents must not share capacity
 *     with foreground tiers" has been deliberately relaxed. If
 *     overload errors return under the shared-capacity shape, the
 *     next move is repointing the background agents (reflection,
 *     wiki, wikiLibrarian, webSearch, researchDocs, recall,
 *     conversationRecall, wikiRecall) to a non-foreground id, NOT
 *     downgrading the foreground tiers.
 *
 *   wiki - deepseek-v4-flash. Autonomous wiki agent: read a settled
 *     thread the day after, decide which topics warrant a new article
 *     or an update to an existing one, and dispatch wiki_search /
 *     wiki_create / wiki_update / wiki_delete tool calls. The same
 *     model also runs the synchronous "ask agent to update" flow
 *     from the per-article UI (single completion, response_format
 *     pinned to JSON, no tool loop). Same rationale as reflection -
 *     big window swallows the conversation and the JSON pin works
 *     on the manual path. See the reflection entry above for the
 *     shared-capacity-with-foreground note.
 *
 *   deepSleep - deepseek-v4-flash. Memory librarian's slow-wave
 *     consolidation pass: every ~12h, picks a longest-unvisited
 *     seed memory, fetches its top-k similarity neighbors above the
 *     medium threshold, and decides consolidate-vs-relate-vs-leave
 *     for each pair. Needs the big window so the batch + the
 *     consolidated body fit alongside any conversation_search /
 *     memory_search results the agent pulls for fact-checking.
 *     Pinned to the same id as the other librarian-tier agents so
 *     a future swap flows through all of them.
 *
 *   rem - deepseek-v4-flash. Memory librarian's associative-
 *     integration pass: every ~12h, picks the oldest eligible
 *     conversation from memory_conversation and looks at the batch
 *     of memories the recall agent surfaced on that conversation.
 *     Primary mode is memory_relate (drawing graph edges); rare
 *     consolidation handled via the same RPC. Same model rationale
 *     as deepSleep.
 *
 *   wikiLibrarian - deepseek-v4-flash. The wiki agent's bigger
 *     sibling: every ~12 hours it reads the full alphabetical list
 *     of articles, fact-checks individual claims via
 *     conversation_search, and consolidates duplicates / updates
 *     stale info via wiki_update / wiki_delete. The librarian needs
 *     the same big context window the per-conversation wiki agent
 *     uses (the article list + several full articles can run wide)
 *     and the same response shape (tool-driven, no structured
 *     final output). Pinned to the same id as `wiki` so a future
 *     swap of the wiki family flows through both surfaces.
 *
 *   webSearch - tencent-hy3-preview. The `web_search` tool's sub-
 *     completion summarises Venice-provided results into 2-4
 *     sentences with citation markers. Bounded synthesis; the call
 *     site forces disable_thinking so the model can't burn the
 *     output budget on a CoT preamble. Distinct id from the recall/
 *     wiki family so the search agent can be retuned without
 *     dragging the deepseek-backed agents along.
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
 *
 *   recall - deepseek-v4-flash. Memory-recall agent: read the live
 *     conversation, search memories, produce a short JSON note.
 *     Pinned to the same id as reflection / wiki / webSearch /
 *     researchDocs because grounded recall over a real DB surface
 *     (memory_search) is sensitive to model-side fabrication - small
 *     MoE models under json_object pressure will confabulate
 *     plausible-shaped notes rather than emit the empty signal. A
 *     dense reasoning model with the large window is the cheapest
 *     fix; the cost is that recall now shares capacity with the
 *     foreground Balanced/Fast tiers. Distinct constant from
 *     conversationRecall so the two recall surfaces can be retuned
 *     independently if one regresses.
 *
 *   conversationRecall - deepseek-v4-flash. Conversation-recall
 *     agent; same shape and rationale as recall.
 *
 *   wikiRecall - deepseek-v4-flash. Wiki-recall agent: read the live
 *     conversation, search the user's wiki articles, produce a short
 *     first-person note. Same bounded-synthesis JSON-out shape and
 *     fabrication-sensitivity profile as recall / conversationRecall;
 *     distinct slot so the three recall surfaces can be retuned
 *     independently if one regresses.
 *
 * The five curation agents (auto-title, summary, thread topics,
 * memory topics, recipe topics), the bias pipeline, and the samskara
 * formation agents have no slots here: they run server-side in the
 * venice edge function (supabase/functions/venice/agents/), which
 * holds their model ids directly - it cannot import from src/lib.
 */
export const AGENT_MODELS = {
  reflection:         'deepseek-v4-flash',
  wiki:               'deepseek-v4-flash',
  wikiLibrarian:      'deepseek-v4-flash',
  deepSleep:          'deepseek-v4-flash',
  rem:                'deepseek-v4-flash',
  webSearch:          'tencent-hy3-preview',
  researchDocs:       'deepseek-v4-flash',
  intuition:          'mistral-small-3-2-24b-instruct',
  recall:             'deepseek-v4-flash',
  conversationRecall: 'deepseek-v4-flash',
  wikiRecall:         'deepseek-v4-flash',
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
 * Resolve the thinking level to use for a given thread. Cascade:
 *
 *   per-thread override -> tier default -> user account default
 *
 * The tier default is the mechanism that lets the three tiers feel
 * different - Smart's `defaultThinking: 'medium'` and Balanced/Fast's
 * `'off'` win over the user's account default when the user hasn't
 * explicitly set a per-thread level. The user's thread-level choice
 * still wins over everything, so anyone who wants thinking back on (or
 * off) for one conversation can pin it per thread and Nak won't
 * override.
 *
 * Returns a ThinkingLevel, which may be 'off'. The account default is
 * a ReasoningEffort (never 'off'), so 'off' only enters the result via
 * a tier default or an explicit per-thread pick. Use `thinkingToWire`
 * to turn the result into the actual wire knobs, and gate on
 * `TIERS[tier].supportsReasoning` first - some providers 400 on a
 * `reasoning_effort` field they don't recognise.
 */
export function resolveThinking(
  threadLevel: ThinkingLevel | null,
  defaultEffort: ReasoningEffort,
  tierDefault?: ThinkingLevel | null
): ThinkingLevel {
  return threadLevel ?? tierDefault ?? defaultEffort;
}

/**
 * Split a resolved thinking level into the two mutually-exclusive wire
 * knobs. 'off' maps to `venice_parameters.disable_thinking: true` (and
 * no `reasoning_effort`); the three effort levels map to
 * `reasoning_effort` (and no disable_thinking). Centralised so the
 * off<->wire mapping lives in one place rather than re-derived at each
 * send site. Kept internal - the composer goes through
 * `thinkingWireForTier`, which also applies the supportsReasoning gate.
 */
function thinkingToWire(level: ThinkingLevel): {
  reasoningEffort?: ReasoningEffort;
  disableThinking: boolean;
} {
  return level === 'off'
    ? { disableThinking: true }
    : { reasoningEffort: level, disableThinking: false };
}

/**
 * Composer send-path convenience: resolve a thread's thinking level
 * against a tier and split it into wire knobs in one step. Non-
 * reasoning models get neither field (some providers 400 on a
 * `reasoning_effort` they don't recognise, and disable_thinking is
 * meaningless without a thinking pass to disable). Collapses what was
 * five copies of the same resolve-then-gate dance at the call sites.
 */
export function thinkingWireForTier(
  tier: TierSpec,
  threadLevel: ThinkingLevel | null,
  defaultEffort: ReasoningEffort
): { reasoningEffort?: ReasoningEffort; disableThinking: boolean } {
  if (!tier.supportsReasoning) return { disableThinking: false };
  return thinkingToWire(resolveThinking(threadLevel, defaultEffort, tier.defaultThinking));
}

/**
 * Resolve the verbosity level to use for a given thread. Same
 * "override wins over default" shape as resolveTier /
 * resolveThinking. Unlike reasoning_effort, we don't gate on
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
 * True when the model is known to leak its own special tokens into the
 * content stream, which arms the client-side special-token-leak guard
 * for it (see `streamGuardsFor`). False for unconfigured ids - including
 * retired ids, which don't carry the flag.
 */
export function modelLeaksSpecialTokens(id: string | null | undefined): boolean {
  if (typeof id !== 'string' || id.length === 0) return false;
  return (MODELS as Readonly<Record<string, ModelSpec>>)[id]?.leaksSpecialTokens === true;
}

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
  'qwen-3-6-plus': {
    id: 'qwen-3-6-plus',
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
    // Vision-capable; this is the id the analyze_image tool uses for
    // its sub-completions. The `e2ee-` prefix is Venice's marker for
    // end-to-end-encrypted serving.
    supportsVision: true,
    supportsResponseFormat: true,
  },
  'e2ee-gpt-oss-20b-p': {
    id: 'e2ee-gpt-oss-20b-p',
    contextWindow: 128_000,
    // The reasoning model is available but the auto-title call site
    // sets `disableThinking: true` so the model emits the title
    // directly rather than burning the budget on chain-of-thought.
    supportsReasoning: true,
    supportsVision: false,
    // No function-calling support; the auto-title call is a single-shot
    // text completion with no tools.
    supportsResponseFormat: true,
  },
  'venice-uncensored-1-2': {
    id: 'venice-uncensored-1-2',
    contextWindow: 128_000,
    // Non-reasoning vision model used by the analyze_image tool (see
    // AGENT_MODELS.visionAnalysis below). The analyze_image call site
    // never sends reasoning_effort, so the missing CoT pass costs
    // nothing on the wire.
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
    ...MODELS['qwen-3-6-plus'],
    tier: 'smart',
    label: 'Smart',
    icon: '🧠',
    description: 'Qwen 3.6 Plus with medium thinking. 1M context, native vision. Best for hard problems.',
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
    // helps on most turns without the latency of medium/high. Balanced
    // and Fast front the same DeepSeek model and differ only in default
    // thinking budget (low vs off); the composer picker lets a user
    // override either per thread.
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
  | 'autoTitle'
  | 'intuition'
  | 'summary'
  | 'topics'
  | 'memoryTopics'
  | 'recipeTopics'
  | 'samskara'
  | 'bias'
  | 'recall'
  | 'conversationRecall'
  | 'wikiRecall'
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
 *   reflection - deepseek-v4-flash. Read the thread, make some
 *     judgments, call the memory tools. Big-window model is the win -
 *     the entire conversation is the context.
 *
 *     NOTE on capacity: the Balanced and Fast foreground tiers ALSO
 *     front this id (Smart was moved off to qwen-3-6-plus). The
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
 *   topics - mistral-small-3-2-24b-instruct. "Read the conversation,
 *     pick 1-4 short topic tags from this existing vocabulary if any
 *     fit, otherwise mint new ones." Bounded JSON output, same
 *     reasoning profile as summary. No tools.
 *
 *   memoryTopics - mistral-small-3-2-24b-instruct. Sibling of `topics`
 *     but the input is a single memory (label+data) rather than a
 *     conversation. Same JSON-out / no-tools profile. Pinned to the
 *     same id as `topics` so a future tier swap of either flows
 *     through both.
 *
 *   recipeTopics - mistral-small-3-2-24b-instruct. Sibling of
 *     memoryTopics targeting one `recipes` row (title + cooklang).
 *     Picks 1-6 tags spanning primary ingredients, cuisine, course,
 *     and technique. Same JSON-out / no-tools profile; same model id
 *     as the other topic taggers so a swap flows through all three.
 *
 *   samskara - mistral-small-3-2-24b-instruct. Five short JSON-out
 *     phases (assimilate, relate, mint, classify, compound summary)
 *     with maxTokens 200-500 per phase. Structured output on bounded
 *     context; mistral-small handles it comfortably.
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
 *   visionAnalysis - venice-uncensored-1-2. Vision sub-completion
 *     for the analyze_image tool. Decoupled from any user-facing
 *     tier so a tier retarget doesn't silently break image
 *     analysis. 128k context, native vision, supports tool calling,
 *     non-reasoning; the call site never sends reasoning_effort, so
 *     the missing CoT pass costs nothing on the wire. Swapped in
 *     over the prior e2ee-qwen3 vision model because uncensored
 *     gives the model latitude on prompts that the original was
 *     reluctant on, without any change to the wire shape this tool
 *     uses.
 *
 *   autoTitle - e2ee-gpt-oss-20b-p. Background title-generation
 *     completion that fires from Chat.svelte in parallel with the
 *     main chat-loop on the opening user turn. Single-shot text
 *     completion with a tiny system prompt and the user's typed
 *     text as the prompt; no tools, no priming, no history. Pinned
 *     to a cheap small model because the task is bounded ("3-6
 *     word title for this message") and the call runs on every
 *     fresh thread. The reasoning capability is suppressed on the
 *     wire with `disableThinking: true` so the model emits the
 *     title directly rather than burning the budget on chain-of-
 *     thought. The 128k context is overkill for the task but
 *     matches the e2ee-served capacity tier.
 */
export const AGENT_MODELS = {
  reflection:         'deepseek-v4-flash',
  wiki:               'deepseek-v4-flash',
  wikiLibrarian:      'deepseek-v4-flash',
  deepSleep:          'deepseek-v4-flash',
  rem:                'deepseek-v4-flash',
  webSearch:          'deepseek-v4-flash',
  researchDocs:       'deepseek-v4-flash',
  intuition:          'mistral-small-3-2-24b-instruct',
  summary:            'mistral-small-3-2-24b-instruct',
  topics:             'mistral-small-3-2-24b-instruct',
  memoryTopics:       'mistral-small-3-2-24b-instruct',
  recipeTopics:       'mistral-small-3-2-24b-instruct',
  samskara:           'mistral-small-3-2-24b-instruct',
  bias:               'mistral-small-3-2-24b-instruct',
  recall:             'deepseek-v4-flash',
  conversationRecall: 'deepseek-v4-flash',
  wikiRecall:         'deepseek-v4-flash',
  visionAnalysis:     'venice-uncensored-1-2',
  autoTitle:          'e2ee-gpt-oss-20b-p',
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
 * Venice's default text-to-image model for the generate_image tool. A
 * standalone constant rather than an AGENT_MODELS entry because an
 * image model isn't a chat ModelSpec - it has no context window, no
 * token-based capabilities, and `agentModel()` (which indexes MODELS)
 * would type-error on it. Same shape as VENICE_EMBEDDING_MODEL above:
 * one non-chat Venice model id, swappable here in one place.
 *
 * venice-sd35 is pixel-dimensioned (width/height up to 1280px), which
 * is why the tool maps aspect ratios to width/height pairs rather than
 * sending an `aspect_ratio` field - swapping to an aspect-ratio-native
 * model means revisiting that mapping in generate_image.ts.
 */
export const VENICE_IMAGE_MODEL = 'venice-sd35';

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

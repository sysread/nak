/**
 * Model registry and helpers. Three concerns, one file:
 *
 *   1. MODELS - flat registry keyed by Venice id. Every model the app
 *      currently pins from an agent role (plus the seed profile's
 *      backing model) lives here as a ModelSpec carrying the capability
 *      data every consumer reads (contextWindow, supportsReasoning,
 *      supportsVision, supportsResponseFormat).
 *
 *   2. ModelProfile - the user-defined, named model configurations the
 *      chat surface runs on (name + Venice id + default reasoning +
 *      default verbosity + a capability snapshot). Users create, edit,
 *      reorder, and delete them in Settings -> Model profiles; exactly
 *      one is the default for new conversations. The type, its
 *      coercion, the seed profile, and the send-path resolution helpers
 *      all live here.
 *
 *   3. AGENT_MODELS - one-line-per-role mapping from background-agent
 *      roles (reflection, wiki, intuition, ...) to a registered
 *      Venice id. Swapping an agent's model is a single edit; the
 *      rationale per slot lives in the docblock on AGENT_MODELS itself
 *      rather than scattered across the agent files.
 *
 * There is no retired-id registry. Threads store a profile id, not a
 * concrete Venice id (see ModelProfile below), so renaming or re-
 * pointing a profile never orphans a thread - the thread resolves
 * through the profile to whatever model it currently carries. The
 * per-message context ring measures each row against the thread's
 * CURRENT model window (passed in by the caller), not the window of
 * whatever model historically answered it, so no historical-id lookup
 * is needed either.
 */

// --- Reasoning / verbosity wire-config knobs -------------------------------

/**
 * OpenAI-style reasoning_effort knob. Passed through verbatim in the
 * `reasoning_effort` body field on /chat/completions - Venice forwards
 * it to the underlying provider. Only meaningful on models whose
 * ModelSpec marks `supportsReasoning: true`; ignored on others (some
 * providers 400 on the unknown field, so we omit it entirely when the
 * resolved model can't reason).
 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return v === 'low' || v === 'medium' || v === 'high';
}

/**
 * The reasoning picker's domain: the three reasoning_effort levels plus
 * an explicit 'off'. Kept separate from ReasoningEffort on purpose -
 * ReasoningEffort is wire-faithful to the `reasoning_effort` body field
 * (Venice 400s on anything outside low/medium/high), whereas 'off' is
 * not a reasoning_effort value at all: it maps to the distinct
 * `venice_parameters.disable_thinking` knob. The two wire knobs are
 * mutually exclusive (off wins), so the picker offers a single 4-way
 * choice and `thinkingToWire` splits it back into whichever knob the
 * level implies. A model profile's default reasoning uses this domain
 * too, so a profile can ship with thinking disabled (the old Fast-tier
 * behavior, now user-composable).
 */
export type ThinkingLevel = 'off' | ReasoningEffort;

export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high'];

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return v === 'off' || isReasoningEffort(v);
}

/** Display labels for the picker. 'Off' reads as "no thinking pass." */
export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: 'Off',
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
   * answering. The server-side special-token-leak guard (in
   * supabase/functions/venice/stream-guards.ts) detects the leak by
   * the token's opening delimiter and re-rolls.
   *
   * DeepSeek-family models on Venice sometimes open with their own
   * `<｜begin▁of▁sentence｜>` token. We deliberately do NOT also send a
   * server-side `stop` / `stop_token_ids`: `stop` matches anywhere in
   * the output, so it would truncate a legitimate reply that mentions
   * one of these sequences mid-stream (a real case for nak, whose users
   * discuss these tokens), and we have no verified token ids for the
   * model. The guard is anchored to the opening, so it only
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
    // No tier or agent points here anymore, but the entry stays
    // registered: persisted user profiles created before the GLM
    // default still resolve to this id, and this curated entry is
    // what arms the special-token-leak guard for them - the live
    // catalog cannot know the leak flag.
    contextWindow: 1_000_000,
    supportsReasoning: true,
    supportsVision: false,
    supportsResponseFormat: true,
    // This model occasionally leaks `<｜begin▁of▁sentence｜>` at the
    // head of a reply; arm the client-side special-token-leak guard.
    // See ModelSpec.leaksSpecialTokens.
    leaksSpecialTokens: true,
  },
  'z-ai-glm-5-3-flash': {
    id: 'z-ai-glm-5-3-flash',
    // Z.ai's flash-tier GLM 5.3: cheap, fast, privately served by
    // Venice, and unusually broad for the price - tool calls, vision,
    // a 1M window, and an optional reasoning pass. Backs the seed chat
    // profile, every background-agent slot (see AGENT_MODELS below),
    // and the analyze_image / analyze_pdf_page vision primary (id held
    // directly in supabase/functions/venice/tools/_vision.ts).
    contextWindow: 1_048_576,
    // Accepts reasoning_effort, and its serving DEFAULT effort is
    // high - so every consumer must pin the thinking pass explicitly
    // (disable_thinking or a low effort). See the AGENT_MODELS
    // docblock for the per-slot discipline.
    supportsReasoning: true,
    supportsVision: true,
    supportsResponseFormat: true,
  },
  'deepseek-v4-flash-0731-fast': {
    id: 'deepseek-v4-flash-0731-fast',
    // DeepSeek V4 Flash 0731 on Venice's fast serving path. 1M context
    // window, reasoning-capable (default effort HIGH - callers must pin
    // the thinking pass). Registered for the intuition perception stage,
    // which reads the entire untrimmed thread transcript and needs the
    // full window a long thread can fill. The rest of the intuition
    // pipeline (drives + synthesis) rides the smaller mistral slot.
    // Same model family as deepseek-v4-flash, which leaked
    // `<｜begin▁of▁sentence｜>` at the head of replies - the flag stays
    // on as a precaution, though the streaming guard it arms does not
    // run on the non-streaming calls the intuition pipeline makes.
    contextWindow: 1_000_000,
    supportsReasoning: true,
    supportsVision: false,
    supportsResponseFormat: true,
    leaksSpecialTokens: true,
  },
  'mistral-small-3-2-24b-instruct': {
    id: 'mistral-small-3-2-24b-instruct',
    // Dense 24B non-reasoning instruct, privately served by Venice.
    // Registered for the intuition background-agent slot (the only one
    // pointing here): the pulse is a gut read, not a reasoned take, so
    // a non-reasoning model is the right shape - same rationale that
    // moved the second-thoughts reviewer off a reasoning id. Also the
    // cheapest private per-token id on the list, and 256k of context
    // covers the perception stage's full-transcript read for any
    // realistic thread.
    contextWindow: 256_000,
    supportsReasoning: false,
    supportsVision: false,
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

// --- User-defined model profiles ---------------------------------------------

/**
 * A user-defined model profile: a named pairing of a Venice model with
 * the default reasoning level and verbosity conversations start at.
 * Profiles replace the old fixed Smart/Balanced/Fast tiers - the user
 * creates, renames, reorders, and deletes them freely in Settings ->
 * Model profiles, and exactly one is flagged the default for new
 * conversations. Persisted wholesale as
 * `profiles.settings.modelProfiles`; array order is display order in
 * both the Settings list and the composer's profile menu.
 *
 * Threads reference a profile by `id` (`threads.model` holds the
 * profile id, or null for "track the default profile"). Ids are
 * client-minted UUIDs - except the seed profile's well-known
 * SEED_MODEL_PROFILE_ID - and stay stable across renames, so renaming
 * or re-pointing a profile never orphans a thread. A thread whose
 * profile was deleted resolves back to the default profile (see
 * resolveModelProfile).
 *
 * Why a capability snapshot rides along (contextWindow / supports*):
 * the live Venice catalog (./catalog.ts) is fetched lazily - only while
 * the Settings pane is open. Chat resolution runs synchronously on
 * every send and cannot wait on (or assume the presence of) an async
 * catalog fetch, so the capability fields the send path needs - the
 * context window for the ring, whether to forward `reasoning_effort`,
 * whether images can be inlined - are captured at pick time from the
 * catalog and read back without a network round trip. The trade-off is
 * staleness: if Venice later changes the model's capabilities the
 * snapshot lags until the user re-picks. Capabilities for a fixed id
 * rarely change, so this is acceptable.
 *
 * Note the curated safety flags (leaksSpecialTokens) are deliberately
 * NOT snapshotted - those keep living in MODELS keyed by concrete id,
 * so the server-side slop guard arms for a profile pointed at a
 * known-leaky model. The catalog can't supply that flag, so there's
 * nothing to snapshot.
 */
export interface ModelProfile {
  /** Stable identity threads reference; survives renames. */
  readonly id: string;
  /** User-facing label; unique across the user's profiles. */
  readonly name: string;
  /** Concrete Venice model id this profile's requests go out with. */
  readonly modelId: string;
  /** Default reasoning level for threads on this profile; may be 'off'. */
  readonly thinking: ThinkingLevel;
  /** Default text.verbosity for threads on this profile. */
  readonly verbosity: Verbosity;
  /** True on exactly one profile - the one new conversations start on. */
  readonly isDefault: boolean;
  readonly contextWindow: number;
  /** Whether to forward `reasoning_effort` on this profile's requests. */
  readonly supportsReasoning: boolean;
  readonly supportsVision: boolean;
  readonly supportsResponseFormat: boolean;
  /** Catalog display name captured at pick time, for the Settings strip. */
  readonly modelLabel: string;
}

/**
 * Id of the starter profile seeded for accounts with no stored
 * profiles (new users, or accounts predating the profile system). A
 * fixed sentinel rather than a random UUID so the seed is stable
 * across sessions and devices before it is ever persisted - a thread
 * pinned to it on one device resolves to the same profile everywhere.
 */
export const SEED_MODEL_PROFILE_ID = 'default';

/**
 * The starter profile list: one profile named "Default" on
 * z-ai-glm-5-3-flash with medium reasoning and low verbosity.
 * Capabilities come from the curated MODELS entry so the snapshot is
 * born accurate. Returns a fresh array per call - callers hand it to
 * reactive state and to list transforms that treat arrays as mutable.
 *
 * The seed only materializes for accounts with NO stored profiles.
 * Existing accounts keep whatever their persisted Default profile
 * points at; re-pointing the seed here does not migrate them.
 */
export function seedModelProfiles(): ModelProfile[] {
  const spec = MODELS['z-ai-glm-5-3-flash'];
  return [
    {
      id: SEED_MODEL_PROFILE_ID,
      name: 'Default',
      modelId: spec.id,
      thinking: 'medium',
      verbosity: 'low',
      isDefault: true,
      contextWindow: spec.contextWindow,
      supportsReasoning: spec.supportsReasoning,
      supportsVision: spec.supportsVision,
      supportsResponseFormat: spec.supportsResponseFormat,
      modelLabel: 'GLM 5.3 Flash',
    },
  ];
}

/**
 * Re-establish the exactly-one-default invariant over a profile list:
 * the first flagged profile keeps the flag (extras are cleared), and a
 * list with no flag at all promotes its first entry. Entries are only
 * copied when their flag actually changes so an already-normal list
 * passes through with its object identities intact. Empty input
 * returns empty - the caller decides whether that means "seed".
 */
export function normalizeDefaultProfile(
  profiles: readonly ModelProfile[]
): ModelProfile[] {
  const defaultId = (profiles.find((p) => p.isDefault) ?? profiles[0])?.id;
  return profiles.map((p) =>
    p.isDefault === (p.id === defaultId) ? p : { ...p, isDefault: p.id === defaultId }
  );
}

/**
 * Validate one persisted profile blob. Total + defensive: returns null
 * on any shape mismatch so a corrupt entry is dropped rather than
 * poisoning resolution. Used by coerceModelProfiles on every read.
 */
export function coerceModelProfile(raw: unknown): ModelProfile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;
  if (typeof r.name !== 'string' || r.name.trim().length === 0) return null;
  if (typeof r.modelId !== 'string' || r.modelId.length === 0) return null;
  if (!isThinkingLevel(r.thinking)) return null;
  if (!isVerbosity(r.verbosity)) return null;
  if (typeof r.contextWindow !== 'number' || !Number.isFinite(r.contextWindow)) {
    return null;
  }
  if (typeof r.supportsReasoning !== 'boolean') return null;
  if (typeof r.supportsVision !== 'boolean') return null;
  if (typeof r.supportsResponseFormat !== 'boolean') return null;
  const modelLabel =
    typeof r.modelLabel === 'string' && r.modelLabel.length > 0
      ? r.modelLabel
      : r.modelId;
  return {
    id: r.id,
    name: r.name,
    modelId: r.modelId,
    thinking: r.thinking,
    verbosity: r.verbosity,
    isDefault: r.isDefault === true,
    contextWindow: r.contextWindow,
    supportsReasoning: r.supportsReasoning,
    supportsVision: r.supportsVision,
    supportsResponseFormat: r.supportsResponseFormat,
    modelLabel,
  };
}

/**
 * Coerce a persisted `modelProfiles` array: drop malformed entries and
 * duplicate ids (first occurrence wins), then normalize the default
 * flag to exactly one. Returns undefined when nothing survives so the
 * stored blob and the in-memory state both treat "no profiles" as
 * absence - the caller substitutes seedModelProfiles().
 */
export function coerceModelProfiles(raw: unknown): ModelProfile[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: ModelProfile[] = [];
  for (const item of raw) {
    const p = coerceModelProfile(item);
    if (p === null || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out.length > 0 ? normalizeDefaultProfile(out) : undefined;
}

/**
 * The profile new conversations start on. Total even over an empty
 * list (falls back to a fresh seed profile) so a transient empty state
 * can never crash the composer; in practice the app state is always
 * seeded non-empty.
 */
export function defaultModelProfile(profiles: readonly ModelProfile[]): ModelProfile {
  return profiles.find((p) => p.isDefault) ?? profiles[0] ?? seedModelProfiles()[0];
}

/**
 * Resolve the effective profile for a thread. A thread pins a profile
 * by id in `threads.model`; null means "track the default profile". An
 * id with no matching profile also resolves to the default - that
 * covers a profile the user deleted, and legacy rows that still carry
 * a pre-profile tier name ('smart' | 'balanced' | 'fast') from before
 * the profile system existed.
 */
export function resolveModelProfile(
  profiles: readonly ModelProfile[],
  threadProfileId: string | null
): ModelProfile {
  if (threadProfileId !== null) {
    const hit = profiles.find((p) => p.id === threadProfileId);
    if (hit) return hit;
  }
  return defaultModelProfile(profiles);
}

/**
 * Project a profile's capability snapshot back into the ModelSpec shape
 * for consumers that read specs rather than profiles (the attachments
 * vision-routing helpers). The spec's `id` is the concrete Venice model
 * id, not the profile id.
 */
export function profileModelSpec(profile: ModelProfile): ModelSpec {
  return {
    id: profile.modelId,
    contextWindow: profile.contextWindow,
    supportsReasoning: profile.supportsReasoning,
    supportsVision: profile.supportsVision,
    supportsResponseFormat: profile.supportsResponseFormat,
  };
}

// --- Background-agent assignments ------------------------------------------

/**
 * Roles that have their own pinned Venice id, separate from the user-
 * facing profile system. Adding a role here is a three-step change: list
 * the role here, add the assignment in AGENT_MODELS below, switch the
 * call site to `agentModel('<role>').id`.
 */
export type AgentRole =
  | 'reflection'
  | 'wiki'
  | 'wikiRecords'
  | 'wikiLibrarian'
  | 'deepSleep'
  | 'rem'
  | 'webSearch'
  | 'researchDocs'
  | 'intuition'
  | 'intuitionPerception'
  | 'recall'
  | 'conversationRecall'
  | 'wikiRecall'
  | 'grocerySection';

/**
 * Background-agent role -> Venice id. The right-hand side is checked
 * against `keyof typeof MODELS` at compile time so every assignment
 * has to point at a registered model spec; a typo or a missing
 * MODELS entry is a tsc error rather than a runtime "model not
 * found" 4xx.
 *
 * Every slot except intuition points at z-ai-glm-5-3-flash. One id
 * fits all of them because it covers each slot's binding constraint at
 * once:
 *
 *   - 1M-token context window - the thread-reading agents
 *     (reflection, the wiki family, the recall trio) slice whole
 *     conversations or article sets with no char-budget trim, so the
 *     window is their hard requirement.
 *   - PRIVATE serving - Venice hosts the weights itself, so prompt
 *     bodies (the user's own conversations and memories) never leave
 *     its infrastructure. This is an upgrade over an 'anonymized' id,
 *     where the prompt is proxied upstream with metadata stripped.
 *   - Cheap and fast - the latency-bound slots (webSearch,
 *     grocerySection) sit on or near the live turn's critical path.
 *   - Reasoning-capable but SUPPRESSIBLE - and this is the standing
 *     obligation the single-id setup carries: the id's serving
 *     default effort is HIGH, so every call site must pin the
 *     thinking pass explicitly. Synthesis/judgment agents pin
 *     reasoningEffort 'low'; classification/extraction and
 *     latency-bound slots pin disable_thinking outright. An unpinned
 *     call rides the high default - latency plus the output-budget
 *     truncation trap CLAUDE.md's Venice sub-completions section
 *     records. When adding a slot, pin one or the other at the call
 *     site.
 *
 * intuition is the first exception: it points at
 * mistral-small-3-2-24b-instruct. It is awaited on the pre-turn
 * critical path, so latency is its only constraint, and the pulse is a
 * gut read, not a reasoned take - a dense non-reasoning id skips the
 * thinking-pass discipline entirely (the intuition pipeline's
 * disable_thinking flag is accepted but moot on it) and is the
 * cheapest private id per token. The mistral id backs the drive
 * reactions (stage 2) and synthesis (stage 3), whose inputs are the
 * short perception text plus five short reactions - well under
 * mistral's 256k window.
 *
 * intuitionPerception is the second exception: it points at
 * deepseek-v4-flash-0731-fast (1M window, fast serving path,
 * reasoning-capable so the thinking pin is load-bearing again). Stage
 * 1 of the intuition pipeline - perception - reads the ENTIRE
 * untrimmed thread transcript, and a long thread on the 1M-window chat
 * model can fill a context mistral cannot hold. The split keeps the
 * cheap non-reasoning id on the small-input stages and reserves the
 * big-window id for the one stage that needs it. If perception
 * regresses on deepseek, mistral-small is the fallback (accepting the
 * 256k ceiling on very long threads).
 *
 * Slot-shape notes that survive any future re-split:
 *
 *   - webSearch and the recall surfaces are FAITHFULNESS-critical: a
 *     confabulated summary of live results, or a recall note that
 *     invents a memory, is worse than an empty one. Small MoE models
 *     under json_object pressure have confabulated plausible-shaped
 *     recall notes rather than emit the empty signal; if that returns,
 *     mistral-small-3-2-24b-instruct (webSearch) and a dense
 *     big-window reasoning id (recall trio) are the known-good
 *     fallbacks.
 *   - Slots stay distinct constants (not one shared constant) so any
 *     single surface can be retuned independently when it regresses.
 * The seed chat profile fronts the same id, so foreground chat and
 * the background fleet share serving capacity. That sharing is a
 * known, accepted trade (it has been relaxed and re-tightened
 * before); if overload errors arrive under the shared-capacity
 * shape, the move is repointing the background slots to a
 * non-foreground id, not downgrading the chat default.
 *
 * The five curation agents (auto-title, summary, thread topics,
 * memory topics, recipe topics), the bias pipeline, and the samskara
 * formation agents have no slots here: they run server-side in the
 * venice edge function, whose ids live in
 * supabase/functions/_shared/agent-models.ts - it cannot import from
 * src/lib. That file's base constants point at the same id; keep the
 * two in sync when swapping.
 */
export const AGENT_MODELS = {
  reflection:         'z-ai-glm-5-3-flash',
  wiki:               'z-ai-glm-5-3-flash',
  wikiRecords:        'z-ai-glm-5-3-flash',
  wikiLibrarian:      'z-ai-glm-5-3-flash',
  deepSleep:          'z-ai-glm-5-3-flash',
  rem:                'z-ai-glm-5-3-flash',
  webSearch:          'z-ai-glm-5-3-flash',
  researchDocs:       'z-ai-glm-5-3-flash',
  intuition:          'mistral-small-3-2-24b-instruct',
  intuitionPerception:'deepseek-v4-flash-0731-fast',
  recall:             'z-ai-glm-5-3-flash',
  conversationRecall: 'z-ai-glm-5-3-flash',
  wikiRecall:         'z-ai-glm-5-3-flash',
  grocerySection:     'z-ai-glm-5-3-flash',
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
 * Identifier of the embedding model in use. Sent in the request body to
 * the venice edge function's /embed route (the server ignores it - the
 * model is fixed by Supabase.ai.Session - but the field stays for
 * backward compat). Also recorded in each row's `embedding_model` column
 * so a future model rotation can locate rows stamped with the older id
 * (`where embedding_model <> EMBEDDING_MODEL`) for re-embedding.
 *
 * gte-small is a 33M-param English text embedding model (384 dims, MTEB
 * 61.36) pre-bundled in the Supabase edge-runtime Docker image. Inference
 * runs locally on the edge function worker via Supabase.ai.Session - no
 * external API call, no Venice dependency.
 *
 * Mirrors EMBEDDING_MODEL in supabase/functions/_shared/backfill.ts -
 * kept in sync by hand because the Deno island does not import from the
 * Vite app.
 */
export const VENICE_EMBEDDING_MODEL = 'gte-small';

// ROTATING THE EMBEDDING MODEL INVALIDATES MORE THAN THIS STRING.
// Transcript chunking is sized against this specific model's input
// ceiling and its tokenizer's characters-per-token behaviour, both
// measured empirically. Those constants -
// EMBEDDING_MAX_INPUT_TOKENS, EMBEDDING_CHARS_PER_TOKEN,
// EMBEDDING_INPUT_SAFETY_MARGIN, EMBEDDING_MAX_INPUT_CHARS - live in
// supabase/functions/_shared/backfill.ts beside the Deno island's
// mirror of this id, because that is where they are consumed. Read the
// measurement table on EMBEDDING_CHARS_PER_TOKEN there and re-measure
// before changing the model here: every number in it is specific to
// the model's tokenizer, and a model with a different ceiling will
// size chunks wrongly in silence.

// --- Image generation ------------------------------------------------------

/**
 * Default text-to-image model for the generate_image tool. A single
 * constant rather than a tier because image generation has no
 * smart/balanced/fast axis - it's one backend the user can repoint.
 *
 * The user's choice lives in `profiles.settings.imageModel`; the
 * generate_image tool (server-side) reads that and falls back to this id
 * when unset. This is also the value the Settings image picker shows as
 * the effective selection before the user picks anything. The edge tool
 * keeps its own mirrored copy of this string (it can't import from
 * src/lib) - keep the two in sync.
 */
export const VENICE_DEFAULT_IMAGE_MODEL = 'venice-sd35';

/**
 * Native output dimension of VENICE_EMBEDDING_MODEL - the length of each
 * `embedding` array returned by the edge function's /embed route.
 * gte-small emits 384.
 */
export const VENICE_EMBEDDING_DIMS = 384;

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

/**
 * Split a resolved thinking level into the two mutually-exclusive wire
 * knobs. 'off' maps to `venice_parameters.disable_thinking: true` (and
 * no `reasoning_effort`); the three effort levels map to
 * `reasoning_effort` (and no disable_thinking). Centralised so the
 * off<->wire mapping lives in one place rather than re-derived at each
 * send site. Kept internal - the composer goes through
 * `thinkingWireForProfile`, which also applies the supportsReasoning
 * gate.
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
 * against its profile and split it into wire knobs in one step. The
 * per-thread override wins; otherwise the profile's default applies.
 * Non-reasoning models get neither field (some providers 400 on a
 * `reasoning_effort` they don't recognise, and disable_thinking is
 * meaningless without a thinking pass to disable).
 */
export function thinkingWireForProfile(
  profile: ModelProfile,
  threadLevel: ThinkingLevel | null
): { reasoningEffort?: ReasoningEffort; disableThinking: boolean } {
  if (!profile.supportsReasoning) return { disableThinking: false };
  return thinkingToWire(threadLevel ?? profile.thinking);
}

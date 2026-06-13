// Samskara formation pipeline: assimilate chat rounds into substrate,
// relate and cluster them into tier-1 predictive claims, compound
// co-firing claims into tier-2, classify the user's reactions to fired
// cohorts, collapse redundancy, and keep the per-user compound summary
// prose fresh. docs/dev/samskara.md is the design doc.
//
// Two exported drivers, matching the fleet's dual-driver shape:
//
//   - samskaraOnTurnTail(admin, userId) - rides getStreamingResponse's
//     waitUntil tail between curation and reflection. Runs the
//     session-responsive phases: reaction-classify FIRST (a fired
//     cohort's resolution window is 1-10 minutes and the resolving
//     evidence IS the next user message, so the tail of turn N+1 lands
//     exactly when turn N's cohort becomes classifiable), then a capped
//     assimilate drain, then one pair-relate probe, then one mint-tier1
//     probe (the in-session toast surface).
//
//   - runSamskaraSweepTick(admin) - the hourly nak-samskara-sweep cron
//     (route /venice/samskara-sweep via sweepHandler). Catch-up for the
//     assimilate queue across users, plus the heavy timing-insensitive
//     phases (mint-tier2, dedup, compound-regen) for every user with
//     recent samskara activity. These three are cron-only on purpose:
//     the tier-2 detection self-join is the heaviest query in the
//     feature, dedup is population maintenance, and the compound
//     summary tolerates a day of staleness in the priming block.
//
// No per-phase throttles: one trigger runs one rotation, so the
// trigger cadence (turn or tick) IS the rate limit - nothing here
// rotates continuously.
//
// Mint toasts: the INSERT into `samskaras` is itself the notification.
// The table is in the supabase_realtime publication and Chat.svelte
// relays user-filtered INSERT events into the notifySamskaraMint
// path. Dedup-reinforce hits update an existing row and therefore
// stay silent, which is the intended toast semantics.
//
// The fire path, substrate stub recording, priming format, and the
// compound-summary read are chat-scoped and live browser-side
// (src/lib/samskara/).
import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger, type EdgeLogger } from '../../_shared/edge-log.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { toolComplete } from '../tools/_venice_complete.ts';
import { veniceEmbed, VeniceError } from '../../_shared/venice.ts';
import {
  VENICE_EMBEDDING_MODEL,
  padEmbeddingForStorage,
} from '../../_shared/backfill.ts';

/**
 * Model for every formation phase: five short JSON-out calls plus one
 * prose paragraph, all comfortably fast-tier work. Mistral-small does
 * not accept reasoning_effort, so no call here sends it.
 */
const SAMSKARA_MODEL = 'mistral-small-3-2-24b-instruct';

/**
 * Per-row claim TTL for the assimilate queue, seconds. Generous - one
 * LLM call against two messages. The per-row claim columns on
 * samskara_substrate are the mutual exclusion between the turn tail
 * and the hourly sweep.
 */
const ASSIMILATE_CLAIM_TTL_SECONDS = 600;

/** Compound-regen claim TTL, seconds - one LLM call per regen. */
const REGEN_CLAIM_TTL_SECONDS = 180;

/**
 * Assimilate drain caps. The tail keeps its cap small so the chain
 * never delays reflection behind it; the sweep cap matches the other
 * fleets' per-tick queue caps. Cap hits are logged - no silent
 * truncation; the next trigger continues the drain.
 */
const TAIL_ASSIMILATE_CAP = 3;
const SWEEP_ASSIMILATE_CAP = 10;

/**
 * Cosine-similarity threshold above which a proposed mint is treated
 * as a near-duplicate of an existing samskara. Tuned on observed
 * corpus behaviour (April 2026): genuine paraphrases of the same
 * underlying claim clustered well above 0.9 on Venice's large
 * embedder, so 0.85 leaves a margin while still collapsing
 * near-clones a real conversation surfaces within minutes. MINT-only
 * on purpose - the fire path has no similarity filter, so
 * weak-but-related samskaras still reach the priming block.
 */
const MINT_DEDUP_COSINE = 0.85;

/**
 * Health nudge applied to a reinforced samskara on a dedup hit. Small
 * by design - re-observing a similar claim is a weak positive signal
 * (the user didn't actively confirm it); the main confidence swing
 * comes from reaction-classify. The RPC caps health at 1.0.
 */
const MINT_DEDUP_HEALTH_BUMP = 0.02;

/**
 * Topical-cluster tuning for mint-tier1. Seed on the most-recent
 * substrate row and keep only rows whose situation embedding is close
 * to it, so the minter input and the recorded provenance are one
 * coherent topic rather than a recency window fused across unrelated
 * turns.
 *
 * MINT_CLUSTER_COSINE_FLOOR is empirical: random substrate pairs in
 * this corpus already average ~0.50 cosine (one user's chat turns is
 * a compressed space) while same-topic runs measure ~0.6-0.75; 0.6
 * sits at the random p90. MINT_CLUSTER_MAX caps the minter sample
 * and provenance batch; MINT_CLUSTER_MIN requires a real cluster
 * before a one-off exchange can crystallize into an instinct.
 */
const MINT_CLUSTER_COSINE_FLOOR = 0.6;
const MINT_CLUSTER_MAX = 5;
const MINT_CLUSTER_MIN = 3;

/**
 * Substrate windows the exploratory probes read: pair-relate scans
 * wide for the best neighbour; mint-tier1 reads just enough to seed
 * one topical cluster.
 */
const PAIR_RELATE_WINDOW = 40;
const MINT_WINDOW = 8;

/**
 * Reaction-classify resolution window, minutes after the fire. The
 * floor avoids racing a turn that's still in flight; fires older than
 * the ceiling age out via decay rather than being force-classified by
 * stale next-turn signal (see docs/dev/samskara.md).
 */
const CLASSIFY_FLOOR_MS = 60 * 1000;
const CLASSIFY_CEILING_MS = 10 * 60 * 1000;

/**
 * Lookback for the sweep's per-user phase fan-out: users with
 * substrate or fires inside this window get the exploratory and
 * maintenance probes. One tick plus slack for a missed tick;
 * compound-regen's own predicate and dedup's population cap keep the
 * probes self-limiting for users the window over-includes.
 */
const SWEEP_USER_WINDOW_HOURS = 2;

// --- Prompts ---------------------------------------------------------------
//
// Each phase drives one prompt via a single non-streaming completion.
// Output is always a JSON object (except the compound summary, which
// is bare prose); the prompt names the required fields explicitly so
// structured-output behaviour is consistent across providers. Kept
// short on purpose: the fast tier pays tokens for inputs, not
// instructions. The Deno suite pins the structural markers each
// parser depends on.

/**
 * Assimilator prompt. Reads one user/assistant exchange and returns
 * the structured substrate fields. The model never sees the eventual
 * samskara use of this output - it just describes what happened.
 */
const ASSIMILATOR_PROMPT = `You are summarising one round of a conversation between a user and
an AI assistant. Read the user message and the assistant response,
then describe what happened in a way another AI could later cluster
with similar rounds.

Reply with a single JSON object, no prose, no markdown fence:

{
  "situation": "third-person observation of what the user asked and the surrounding context",
  "outcome": "what the assistant did and how the situation appeared to land",
  "valence": <number from -1.0 to 1.0 capturing emotional charge: negative for tense / frustrated / corrective, positive for warm / satisfied / curious, 0 for neutral>
}

Keep \`situation\` under 240 chars. Keep \`outcome\` under 240 chars.
Be concrete: name what was asked, the topic, any constraints the
user mentioned. Do not editorialise about the user or the assistant.
Do not include a name or pronoun for the assistant - "the assistant"
is fine.`;

/**
 * Relator prompt. Reads two substrate situations and labels the
 * relation between them, or returns kind='orthogonal' if there isn't
 * one worth recording. The caller discards orthogonal verdicts.
 */
const RELATOR_PROMPT = `You are comparing two snapshots of past conversations. Each snapshot
has a \`situation\` and an \`outcome\`. Decide whether there is a
meaningful relation between them.

Reply with a single JSON object, no prose, no markdown fence:

{
  "kind": "pattern" | "contrast" | "prerequisite" | "consequence" | "orthogonal",
  "label": "short phrase, <= 12 words, capturing the relation"
}

Kinds:
- "pattern": both snapshots show a similar tendency (same mood, same
  approach, same kind of ask).
- "contrast": one is a clear inverse of the other.
- "prerequisite": A leads naturally to B.
- "consequence": B is a downstream effect of an A-like situation.
- "orthogonal": no meaningful relation. When you pick this, set
  \`label\` to an empty string.

Bias toward orthogonal when in doubt. A relation worth recording
should suggest something predictive about the user.`;

/**
 * Minter prompt. Reads a cluster of related substrate snippets and
 * produces a samskara - a one-line predictive claim about the user.
 * Returns confirm:false to refuse weak clusters.
 */
const MINTER_PROMPT = `You are minting a "samskara" - a short, predictive claim about a
user, derived from a cluster of past observations. The samskara
should be the kind of thing a future you could read at the start
of a conversation and act on instinctively.

Reply with a single JSON object, no prose, no markdown fence:

{
  "confirm": true | false,
  "prediction": "one or two sentences in the form: in situations like X, this user tends to Y",
  "inner_voice": "optional silent self-talk, <= 80 chars, like an internal post-it note. Empty string if not useful.",
  "valence": <-1.0 to 1.0, the emotional flavour of the tendency>,
  "confidence": <0.0 to 1.0, your initial confidence in the claim>
}

Set confirm:false when:
- the cluster is too noisy to support a single prediction,
- the prediction would be obvious or vapid,
- you would need to invent details to make it specific.

When you set confirm:false, you may leave the other fields as
empty strings or zeros - they will be discarded.

When you set confirm:true, the prediction should be specific to the
user. "User asks about coding" is too vague. "User pushes back on
flowery responses to terse technical questions" is the right shape.

Two prediction shapes are equally welcome:
- positive ("user tends to do Y in situations like X"),
- negative ("user tends to NOT do Y in situations like X" - useful
  when the cluster surfaces a contrast or aversion).
Predictions about the assistant's behaviour are also valid:
"this user expects the assistant to ask before suggesting code"
reads as a samskara just as cleanly as "this user prefers terse
replies." Lean into whichever framing the cluster actually supports.

You may also receive "sample_labels": short relations a prior
analysis already articulated between pairs of the observations
(e.g. "both show the user seeking the mechanism behind a
behaviour"). When present, treat them as pre-digested hints about
what ties the cluster together - stronger signal than the raw
situations alone. When "sample_labels" is empty, work from the
situations directly.`;

/**
 * Tier-2 (compound) minter prompt. Reads a set of EXISTING tier-1
 * predictive claims that reliably fire together, and names the
 * higher-order disposition behind them - or refuses. Distinct from
 * MINTER_PROMPT: the input is finished claims, not raw situations, and
 * the task is generalization rather than first-order observation. The
 * output shape is identical so the mint path stays uniform.
 */
const TIER2_MINTER_PROMPT = `You are minting a "compound" - a higher-order predictive claim about a
user, derived from a set of more specific claims that already fire
together whenever a certain kind of situation recurs.

You will receive an array of \`children\`, each a {prediction, valence}
the system has already formed about this user. They co-activate, so
they likely share one underlying disposition. Your job is to name THAT
- the pattern behind the patterns - in a single claim that is strictly
more general than any one child.

Reply with a single JSON object, no prose, no markdown fence:

{
  "confirm": true | false,
  "prediction": "one or two sentences in the form: in situations like X, this user tends to Y",
  "inner_voice": "optional silent self-talk, <= 80 chars. Empty string if not useful.",
  "valence": <-1.0 to 1.0, the emotional flavour of the compound>,
  "confidence": <0.0 to 1.0, your initial confidence in the compound>
}

Set confirm:false when:
- the children only coincidentally co-fire and share no real
  super-pattern,
- the only honest summary would be a list or conjunction of the
  children ("the user does A and B and C"),
- the generalization would be vapid ("the user has preferences").

When you set confirm:false, the other fields are discarded - leave
them empty or zero.

When you set confirm:true, the prediction must GENERALIZE, not
enumerate. Do not restate or concatenate the children. If three
children are "pushes back on flowery prose", "wants code without
preamble", and "corrects over-explanation", the compound is something
like "in technical exchanges this user runs on an efficiency instinct
and treats anything beyond the answer as friction" - one disposition,
not three bullets. Keep it in the same "in situations like X, this
user tends to Y" shape so it embeds and fires like any other claim.`;

/**
 * Reaction-classifier prompt. Reads a cohort of samskaras that fired
 * on the previous turn plus the user's response to that turn, and
 * partitions the cohort into confirm / disconfirm / neutral buckets.
 */
const REACTION_PROMPT = `You are scoring how a user reacted to an AI assistant turn that was
shaped by a set of "samskaras" - predictive claims about the user.

You will receive:
- the cohort that shaped the previous turn, as an array of {id, prediction},
- the assistant message that was sent,
- the user message that came next.

For each samskara in the cohort, decide whether the new user
message confirms the prediction (the user behaved as the samskara
expected), disconfirms it (the user did the opposite), or is
neutral (the user message was about something unrelated, or did
not speak to the prediction either way).

Reply with a single JSON object, no prose, no markdown fence:

{
  "confirm": [<id>, ...],
  "disconfirm": [<id>, ...],
  "neutral": [<id>, ...]
}

Every id from the cohort must appear in exactly one bucket. Bias
toward neutral when the signal is ambiguous - false confidence in
either direction skews future priming more than missing a real
signal.`;

/**
 * Compound-summary prompt. Reads the top live samskaras and produces
 * a prose paragraph the chat loop appends to every system prompt as
 * the always-on calibration block.
 */
const COMPOUND_SUMMARY_PROMPT = `You will receive a list of samskaras - short predictive claims a
previous AI assistant has formed about a user across many
conversations. Each carries a \`prediction\`, an optional
\`inner_voice\`, a \`valence\` in [-1, 1], a \`confidence\` in [0, 1],
and a \`health\` in [0, 1]. Stronger samskaras (high health *
confidence) are listed first.

Compose a single prose paragraph (4-8 sentences) that reads as the
"current best model of who this user is and how to engage with
them." The paragraph will be appended to a future assistant's
system prompt as always-on context, so write in the third person
about the user (not in the second person addressing them).

Lean into the signal from the strongest samskaras; let weaker ones
colour the paragraph rather than name themselves. Where samskaras
tension or contradict each other, surface the tension rather than
collapsing it. Do not enumerate or list. Do not mention the word
"samskara". Do not include numbers or bullet points.

Reply with the paragraph only - no headings, no JSON, no prose
about your task.`;

// --- Agent calls (one non-streaming completion per phase) ----------------

interface AssimilationResult {
  situation: string;
  outcome: string;
  valence: number;
}

interface RelatorResult {
  kind: 'pattern' | 'contrast' | 'prerequisite' | 'consequence' | 'orthogonal';
  label: string;
}

interface MintResult {
  prediction: string;
  innerVoice: string;
  valence: number;
  confidence: number;
}

interface ReactionResult {
  confirm: string[];
  disconfirm: string[];
  neutral: string[];
}

/**
 * Strip a leading/trailing ```json fence if the model added one
 * despite the "no markdown fence" instruction - cheap insurance for
 * fast models whose default wrapping survives the prompt.
 */
function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    return trimmed
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim();
  }
  return trimmed;
}

/**
 * Best-effort JSON parse. Null means the model emitted something
 * unparseable - callers treat it like any other agent failure (a
 * claimed row TTLs out and gets retried; a probe just yields nothing
 * this rotation).
 */
function tryParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(stripJsonFence(raw)) as T;
  } catch {
    return null;
  }
}

/**
 * One non-streaming completion. Venice rate-limits re-throw so the
 * drivers can abandon the rest of the rotation (the next turn or tick
 * retries); every other failure returns null and the phase folds it
 * into its no-result path.
 */
async function callOnce(
  apiKey: string,
  systemPrompt: string,
  userPayload: string,
): Promise<string | null> {
  try {
    const result = await toolComplete({
      apiKey,
      model: SAMSKARA_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPayload },
      ],
      // The outputs are small JSON objects or one paragraph; 2048 is
      // generous headroom for every phase.
      maxTokens: 2048,
    });
    return result.text;
  } catch (err) {
    if (err instanceof VeniceError && err.kind === 'rate_limit') throw err;
    return null;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

async function agentAssimilate(
  apiKey: string,
  userMessage: string,
  assistantMessage: string,
): Promise<AssimilationResult | null> {
  const raw = await callOnce(
    apiKey,
    ASSIMILATOR_PROMPT,
    JSON.stringify({ user_message: userMessage, assistant_message: assistantMessage }),
  );
  if (raw === null) return null;
  const parsed = tryParseJson<{ situation?: unknown; outcome?: unknown; valence?: unknown }>(
    raw,
  );
  if (!parsed || typeof parsed.situation !== 'string' || parsed.situation.length === 0) {
    return null;
  }
  return {
    situation: parsed.situation,
    outcome: typeof parsed.outcome === 'string' ? parsed.outcome : '',
    valence: typeof parsed.valence === 'number' ? clamp(parsed.valence, -1, 1) : 0,
  };
}

async function agentRelate(
  apiKey: string,
  a: { situation: string | null; outcome: string | null },
  b: { situation: string | null; outcome: string | null },
): Promise<RelatorResult | null> {
  const raw = await callOnce(apiKey, RELATOR_PROMPT, JSON.stringify({ a, b }));
  if (raw === null) return null;
  const parsed = tryParseJson<{ kind?: unknown; label?: unknown }>(raw);
  if (!parsed || typeof parsed.kind !== 'string') return null;
  const allowed = ['pattern', 'contrast', 'prerequisite', 'consequence', 'orthogonal'];
  if (!allowed.includes(parsed.kind)) return null;
  return {
    kind: parsed.kind as RelatorResult['kind'],
    label: typeof parsed.label === 'string' ? parsed.label : '',
  };
}

/**
 * Shared parse for both minter prompts - the output contract is
 * identical; only the prompt and payload differ. Three outcomes the
 * caller CAN distinguish, because the association-mint path must:
 *   - MintResult  : confirm:true with a usable prediction -> mint.
 *   - 'declined'  : a clean confirm:false verdict -> a real judgment
 *                   that this cluster supports no claim. The
 *                   association path stamps the edges as consumed on
 *                   this; re-asking the same immutable cluster would
 *                   only burn calls.
 *   - null        : NO verdict - transport failure, unparseable body,
 *                   or a contradictory confirm:true-without-prediction.
 *                   The association path must NOT stamp on this; the
 *                   evidence is intact and a later sweep retries.
 * The recency mint path treats 'declined' and null identically (it
 * stamps nothing), so it just checks for a MintResult.
 */
async function agentMint(
  apiKey: string,
  systemPrompt: string,
  payload: string,
): Promise<MintResult | 'declined' | null> {
  const raw = await callOnce(apiKey, systemPrompt, payload);
  if (raw === null) return null;
  const parsed = tryParseJson<{
    confirm?: unknown;
    prediction?: unknown;
    inner_voice?: unknown;
    valence?: unknown;
    confidence?: unknown;
  }>(raw);
  if (!parsed) return null;
  if (parsed.confirm !== true) return 'declined';
  if (typeof parsed.prediction !== 'string' || parsed.prediction.length === 0) return null;
  return {
    prediction: parsed.prediction,
    innerVoice: typeof parsed.inner_voice === 'string' ? parsed.inner_voice : '',
    valence: typeof parsed.valence === 'number' ? clamp(parsed.valence, -1, 1) : 0,
    confidence:
      typeof parsed.confidence === 'number' ? clamp(parsed.confidence, 0, 1) : 0.5,
  };
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  for (const item of v) if (typeof item !== 'string') return null;
  return v as string[];
}

async function agentClassifyReaction(
  apiKey: string,
  cohort: { id: string; prediction: string }[],
  assistantMessage: string,
  nextUserMessage: string,
): Promise<ReactionResult | null> {
  const raw = await callOnce(
    apiKey,
    REACTION_PROMPT,
    JSON.stringify({
      cohort,
      assistant_message: assistantMessage,
      user_message: nextUserMessage,
    }),
  );
  if (raw === null) return null;
  const parsed = tryParseJson<{ confirm?: unknown; disconfirm?: unknown; neutral?: unknown }>(
    raw,
  );
  if (!parsed) return null;
  const confirm = asStringArray(parsed.confirm);
  const disconfirm = asStringArray(parsed.disconfirm);
  const neutral = asStringArray(parsed.neutral);
  if (!confirm || !disconfirm || !neutral) return null;
  return { confirm, disconfirm, neutral };
}

async function agentSummarizeCompound(
  apiKey: string,
  samskaras: {
    prediction: string;
    inner_voice: string | null;
    valence: number | null;
    confidence: number;
    health: number;
  }[],
): Promise<string | null> {
  const raw = await callOnce(apiKey, COMPOUND_SUMMARY_PROMPT, JSON.stringify({ samskaras }));
  if (raw === null) return null;
  const trimmed = raw.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

// --- Math helpers (ported from the browser loop) --------------------------

/**
 * Cosine similarity between two equal-length vectors. Returns -1 on a
 * zero-norm input - the signal that a substrate embedding failed to
 * parse (an empty array) and shouldn't join a cluster or pair.
 */
function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface SubstrateRow {
  id: string;
  situation: string | null;
  outcome: string | null;
  embedding: number[];
}

/**
 * Seed-topical cluster for mint-tier1: the most-recent row plus the
 * later rows whose situation embedding sits within
 * MINT_CLUSTER_COSINE_FLOOR of it, capped at MINT_CLUSTER_MAX,
 * preserving recency order. A seed with no usable embedding yields a
 * lone-seed cluster the caller rejects against MINT_CLUSTER_MIN.
 */
function buildTopicalCluster(recent: SubstrateRow[]): SubstrateRow[] {
  const seed = recent[0];
  const cluster: SubstrateRow[] = [seed];
  for (let i = 1; i < recent.length && cluster.length < MINT_CLUSTER_MAX; i++) {
    const emb = recent[i].embedding;
    if (emb.length === 0) continue;
    if (cosine(seed.embedding, emb) >= MINT_CLUSTER_COSINE_FLOOR) {
      cluster.push(recent[i]);
    }
  }
  return cluster;
}

/**
 * PostgREST returns pgvector columns as their text form ('[0.1,...]'),
 * which is valid JSON. A parse failure yields an empty array - the
 * cosine helpers treat that as "not clusterable" rather than erroring.
 */
function parseVector(v: unknown): number[] {
  if (Array.isArray(v)) return v as number[];
  if (typeof v !== 'string') return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? (parsed as number[]) : [];
  } catch {
    return [];
  }
}

/** Truncate a string for inline log details. */
function shorten(s: string, max = 80): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}...`;
}

// --- DB plumbing -----------------------------------------------------------

/**
 * Embed a freshly minted prediction so it can fire by cosine like any
 * samskara. Same model and pad-to-storage-width path the embed
 * backfill uses for substrate. Null on any failure - the caller skips
 * the mint rather than inserting an unfireable row.
 */
async function embedPrediction(apiKey: string, prediction: string): Promise<number[] | null> {
  try {
    const resp = await veniceEmbed({
      apiKey,
      model: VENICE_EMBEDDING_MODEL,
      input: prediction,
    });
    const raw = resp.data[0]?.embedding;
    if (!raw || raw.length === 0) return null;
    return padEmbeddingForStorage(raw);
  } catch (err) {
    if (err instanceof VeniceError && err.kind === 'rate_limit') throw err;
    return null;
  }
}

/**
 * The recent embedded-substrate window both exploratory probes read.
 * Direct table read (the browser wrapper was too); explicit user
 * scoping because the admin client sees every row.
 */
async function recentEmbeddedSubstrate(
  admin: SupabaseClient,
  userId: string,
  limit: number,
): Promise<SubstrateRow[]> {
  const { data, error } = await admin
    .from('samskara_substrate')
    .select('id, situation, outcome, situation_embedding')
    .eq('user_id', userId)
    .not('situation_embedding', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`substrate read failed: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    situation: (r.situation as string | null) ?? null,
    outcome: (r.outcome as string | null) ?? null,
    embedding: parseVector(r.situation_embedding),
  }));
}

/**
 * Insert a minted samskara plus its provenance batch. user_id is
 * explicit on every row: the column default is auth.uid(), which is
 * NULL under the service role. Returns the new id, or null on error.
 */
async function insertMint(
  admin: SupabaseClient,
  userId: string,
  log: EdgeLogger,
  tier: 1 | 2,
  minted: MintResult,
  predEmbedding: number[],
  provenance: { kind: 'substrate' | 'samskara' | 'association'; refId: string; weight: number }[],
): Promise<string | null> {
  const { data, error } = await admin
    .from('samskaras')
    .insert({
      user_id: userId,
      tier,
      prediction: minted.prediction,
      prediction_embedding: predEmbedding,
      inner_voice: minted.innerVoice.length > 0 ? minted.innerVoice : null,
      valence: minted.valence,
      confidence: minted.confidence,
    })
    .select('id')
    .single();
  if (error || !data) {
    log.debug(`mint-tier${tier}: samskaras insert failed`, {
      error: error?.message ?? 'no row',
    });
    return null;
  }
  const provRows = provenance.map((p) => ({
    samskara_id: data.id as string,
    user_id: userId,
    kind: p.kind,
    ref_id: p.refId,
    weight: p.weight,
  }));
  const { error: provErr } = await admin
    .from('samskara_provenance')
    .upsert(provRows, { onConflict: 'samskara_id,kind,ref_id', ignoreDuplicates: true });
  if (provErr) {
    // The samskara row itself landed and will fire; missing provenance
    // only degrades the diagnostics drill-down, so log and keep it.
    log.debug(`mint-tier${tier}: provenance upsert failed`, { error: provErr.message });
  }
  return data.id as string;
}

// --- Phases ----------------------------------------------------------------

/**
 * Assimilate one already-claimed substrate stub: fetch the two
 * messages it anchors, run the assimilator, save under the claim
 * guard. A vanished user message gets a placeholder save so the row
 * stops re-surfacing in the queue.
 */
async function assimilateClaimed(
  admin: SupabaseClient,
  userId: string,
  log: EdgeLogger,
  apiKey: string,
  holderId: string,
  claim: {
    id: string;
    threadId: string;
    userMessageId: string;
    assistantMessageId: string | null;
  },
): Promise<void> {
  log.info(`assimilate: claimed substrate ${claim.id} (thread ${claim.threadId})`);

  const wantedIds = [claim.userMessageId, claim.assistantMessageId].filter(
    (id): id is string => typeof id === 'string',
  );
  let userMsg = '';
  let assistantMsg = '';
  // Ownership scoping rides thread_id: `messages` has no user_id
  // column (ownership routes through threads.user_id), and the claim
  // RPC already proved the substrate row - and therefore its thread -
  // belongs to this user.
  const { data: messages, error: msgErr } = await admin
    .from('messages')
    .select('id, content')
    .eq('thread_id', claim.threadId)
    .in('id', wantedIds);
  if (msgErr) throw new Error(`assimilate: message read failed: ${msgErr.message}`);
  for (const m of messages ?? []) {
    if (m.id === claim.userMessageId) userMsg = (m.content as string | null) ?? '';
    if (m.id === claim.assistantMessageId) assistantMsg = (m.content as string | null) ?? '';
  }

  if (userMsg.length === 0) {
    // The user message disappeared (thread deleted, message edit). We
    // can't assimilate without it; a placeholder save drains the row.
    await admin.rpc('samskara_save_assimilation_if_claimed', {
      p_id: claim.id,
      p_holder_id: holderId,
      p_situation: '(source message unavailable)',
      p_outcome: '',
      p_valence: 0,
      p_user_id: userId,
    });
    return;
  }

  const result = await agentAssimilate(apiKey, userMsg, assistantMsg);
  if (!result) {
    log.debug('assimilate: agent returned null', { substrateId: claim.id });
    return;
  }
  const { data: saved, error: saveErr } = await admin.rpc(
    'samskara_save_assimilation_if_claimed',
    {
      p_id: claim.id,
      p_holder_id: holderId,
      p_situation: result.situation,
      p_outcome: result.outcome,
      p_valence: result.valence,
      p_user_id: userId,
    },
  );
  if (saveErr) throw new Error(`assimilate: save failed: ${saveErr.message}`);
  if (saved === true) {
    log.info(`assimilate: saved substrate ${claim.id}`);
  } else {
    log.debug('assimilate: save rejected (claim expired?)', { substrateId: claim.id });
  }
}

/**
 * Drain the per-user assimilate queue up to a cap (turn-tail driver).
 * Returns the number of rows assimilated.
 */
async function assimilateDrainForUser(
  admin: SupabaseClient,
  userId: string,
  log: EdgeLogger,
  apiKey: string,
  cap: number,
): Promise<number> {
  let drained = 0;
  while (drained < cap) {
    const holderId = crypto.randomUUID();
    const { data, error } = await admin.rpc('samskara_claim_next_assimilate', {
      p_holder_id: holderId,
      p_ttl_seconds: ASSIMILATE_CLAIM_TTL_SECONDS,
      p_user_id: userId,
    });
    if (error) throw new Error(`assimilate claim failed: ${error.message}`);
    const claim = Array.isArray(data) ? data[0] : data;
    if (!claim || typeof claim.id !== 'string') break;
    await assimilateClaimed(admin, userId, log, apiKey, holderId, {
      id: claim.id,
      threadId: claim.thread_id as string,
      userMessageId: claim.user_message_id as string,
      assistantMessageId: (claim.assistant_message_id as string | null) ?? null,
    });
    drained++;
  }
  if (drained >= cap) {
    log.debug(`assimilate: tail cap hit (${cap}); sweep continues the drain`);
  }
  return drained;
}

/**
 * Cosine floor for pair-relate candidates. Same floor the browser
 * loop used: below 0.3 the "closest pair" is noise in this compressed
 * embedding space, not a relation.
 */
const PAIR_RELATE_COSINE_FLOOR = 0.3;

/**
 * Rank the seed's potential partners by cosine, best first, dropping
 * rows below the floor and rows whose embedding failed to parse.
 * Pure so the Deno suite can pin the ordering and floor behaviour.
 */
function rankPairCandidates(
  seed: SubstrateRow,
  recent: SubstrateRow[],
): { row: SubstrateRow; sim: number }[] {
  const out: { row: SubstrateRow; sim: number }[] = [];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].embedding.length === 0) continue;
    const sim = cosine(seed.embedding, recent[i].embedding);
    if (sim >= PAIR_RELATE_COSINE_FLOOR) out.push({ row: recent[i], sim });
  }
  out.sort((x, y) => y.sim - x.sim);
  return out;
}

/**
 * Partner ids the relator has already ruled on for this seed, in
 * either direction: accepted pairs live in samskara_associations,
 * declined pairs in samskara_pair_declines. Substrate content is
 * immutable after assimilation, so a past verdict is permanent and
 * re-asking the agent about an adjudicated pair learns nothing.
 */
async function adjudicatedPartners(
  admin: SupabaseClient,
  userId: string,
  seedId: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const table of ['samskara_associations', 'samskara_pair_declines']) {
    const { data, error } = await admin
      .from(table)
      .select('a_id, b_id')
      .eq('user_id', userId)
      .or(`a_id.eq.${seedId},b_id.eq.${seedId}`);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    for (const r of data ?? []) {
      out.add(r.a_id === seedId ? (r.b_id as string) : (r.a_id as string));
    }
  }
  return out;
}

/**
 * Pair-relate probe: read the recent embedded window, walk the seed's
 * partners best-cosine-first to the closest pair the relator has not
 * already ruled on, ask the relator once, and persist the verdict
 * either way - associations via the samskara_associate RPC (whose
 * conflict clause increments reinforcement atomically), declines into
 * the samskara_pair_declines ledger. Recording declines is what lets
 * a quiet corpus go fully silent: once every pair in the window is
 * adjudicated, the probe returns before spending a Venice call.
 * One pair per probe keeps the LLM call rate bounded.
 */
async function pairRelateProbe(
  admin: SupabaseClient,
  userId: string,
  log: EdgeLogger,
  apiKey: string,
): Promise<void> {
  const recent = await recentEmbeddedSubstrate(admin, userId, PAIR_RELATE_WINDOW);
  if (recent.length < 2) return;
  const seed = recent[0];
  if (seed.embedding.length === 0) return;
  const ranked = rankPairCandidates(seed, recent);
  if (ranked.length === 0) return;

  const adjudicated = await adjudicatedPartners(admin, userId, seed.id);
  const pick = ranked.find((c) => !adjudicated.has(c.row.id));
  if (!pick) {
    log.trace('pair-relate: every candidate pair already adjudicated', {
      candidates: ranked.length,
    });
    return;
  }

  const partner = pick.row;
  log.info(
    `pair-relate: selected pair ${seed.id} <> ${partner.id} (cosine ${pick.sim.toFixed(3)})`,
  );
  const result = await agentRelate(
    apiKey,
    { situation: seed.situation, outcome: seed.outcome },
    { situation: partner.situation, outcome: partner.outcome },
  );
  if (!result) {
    // Transport/parse failure, not a verdict - leave the pair
    // unadjudicated so a later probe can retry it.
    log.debug('pair-relate: agent returned null');
    return;
  }

  // Canonical pair ordering, same convention as the table columns.
  const aId = seed.id < partner.id ? seed.id : partner.id;
  const bId = seed.id < partner.id ? partner.id : seed.id;

  if (result.kind === 'orthogonal' || result.label.length === 0) {
    log.debug('pair-relate: agent declined', { kind: result.kind });
    // Direct table write under the service role (user_id explicit -
    // the admin client has no auth.uid()), same documented pattern as
    // the mint inserts. ignoreDuplicates: a concurrent probe may have
    // recorded the same decline; nothing to update on a re-decline.
    const { error } = await admin.from('samskara_pair_declines').upsert(
      { user_id: userId, a_id: aId, b_id: bId },
      { onConflict: 'user_id,a_id,b_id', ignoreDuplicates: true },
    );
    if (error) log.debug('pair-relate: decline write error', { error: error.message });
    return;
  }

  const { data, error } = await admin.rpc('samskara_associate', {
    p_user_id: userId,
    p_a_id: aId,
    p_b_id: bId,
    p_label: result.label,
    p_kind: result.kind,
  });
  if (error) {
    log.debug('pair-relate: associate error', { error: error.message });
    return;
  }
  const reinforcement = typeof data === 'number' ? data : 1;
  log.info(
    `pair-relate: associated ${aId} <> ${bId} (${result.kind}: ${shorten(result.label)}, reinforcement ${reinforcement})`,
  );
}

/**
 * Mint-tier1 probe: build a topical cluster from the recent window,
 * ask the minter, embed, dedup-guard against the existing corpus,
 * insert with provenance. The INSERT doubles as the toast signal via
 * the realtime relay.
 */
async function mintTier1Probe(
  admin: SupabaseClient,
  userId: string,
  log: EdgeLogger,
  apiKey: string,
): Promise<void> {
  const recent = await recentEmbeddedSubstrate(admin, userId, MINT_WINDOW);
  if (recent.length < MINT_CLUSTER_MIN) return;
  const clusterRows = buildTopicalCluster(recent);
  if (clusterRows.length < MINT_CLUSTER_MIN) {
    log.trace('mint-tier1: no coherent cluster', {
      fetched: recent.length,
      coherent: clusterRows.length,
    });
    return;
  }

  const minted = await agentMint(
    apiKey,
    MINTER_PROMPT,
    JSON.stringify({
      sample_labels: [],
      sample_situations: clusterRows.map((r) => r.situation),
      reinforcement: clusterRows.length,
    }),
  );
  // Recency path stamps nothing, so a decline and a failure are the
  // same non-event here.
  if (minted === null || minted === 'declined') {
    log.trace('mint-tier1: agent declined');
    return;
  }

  const predEmbedding = await embedPrediction(apiKey, minted.prediction);
  if (!predEmbedding) return;

  // Dedup guard: the minter only sees the cluster and cheerfully
  // rewords claims the corpus already holds. A near-duplicate gets a
  // health bump instead of a twin. A failure of the check itself is
  // non-fatal - better a possible twin than a dropped signal; the
  // collapse RPC is the cleanup lane.
  try {
    const { data: nearest } = await admin.rpc('samskara_nearest_by_prediction', {
      p_query_embedding: predEmbedding,
      p_k_max: 1,
      p_user_id: userId,
    });
    const top = Array.isArray(nearest) ? nearest[0] : null;
    if (top && typeof top.cosine === 'number' && top.cosine >= MINT_DEDUP_COSINE) {
      await admin.rpc('samskara_reinforce_existing', {
        p_samskara_id: top.id,
        p_health_bump: MINT_DEDUP_HEALTH_BUMP,
        p_user_id: userId,
      });
      log.debug('mint-tier1: dedup-reinforced existing', {
        id: top.id,
        cosine: top.cosine,
        candidate: shorten(minted.prediction),
      });
      return;
    }
  } catch (err) {
    if (err instanceof VeniceError) throw err;
    log.debug('mint-tier1: dedup check failed, proceeding with mint', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const id = await insertMint(
    admin,
    userId,
    log,
    1,
    minted,
    predEmbedding,
    clusterRows.map((r) => ({ kind: 'substrate' as const, refId: r.id, weight: 1.0 })),
  );
  if (id) {
    log.info('mint-tier1: minted samskara', {
      id,
      prediction: shorten(minted.prediction),
      valence: minted.valence,
      confidence: minted.confidence,
    });
  }
}

/** One row of the samskara_association_cluster RPC result. */
interface AssociationEdgeRow {
  association_id: string;
  label: string;
  kind: string;
  reinforcement: number;
  hub_id: string;
  hub_situation: string;
  partner_id: string;
  partner_situation: string;
}

/** The assembled association cluster fed to the minter + provenance. */
interface AssociationCluster {
  /** Hub situation first, then each distinct partner's situation. */
  situations: string[];
  /** Every edge label (one per edge, partner-duplicates kept). */
  labels: string[];
  /** Summed reinforcement across the edges - the minter's strength hint. */
  reinforcementSum: number;
  /** Substrate ids of the member rows (hub + distinct partners) for provenance. */
  memberIds: string[];
}

/**
 * Fold the RPC's edge rows into one cluster. The hub (identical across
 * every row) is the first member; each distinct partner adds one more.
 * The RPC already returns one representative edge per partner, so in
 * practice every row has a distinct partner; the partner-id dedup here
 * is defensive (any repeat keeps both labels but adds the partner once).
 * Pure so the Deno suite can pin the member-dedup and label-collection
 * behaviour.
 */
function buildAssociationCluster(edges: AssociationEdgeRow[]): AssociationCluster {
  const hub = edges[0];
  const memberIds = [hub.hub_id];
  const situations = [hub.hub_situation];
  const seen = new Set<string>([hub.hub_id]);
  for (const e of edges) {
    if (seen.has(e.partner_id)) continue;
    seen.add(e.partner_id);
    memberIds.push(e.partner_id);
    situations.push(e.partner_situation);
  }
  return {
    situations,
    labels: edges.map((e) => e.label),
    reinforcementSum: edges.reduce((sum, e) => sum + e.reinforcement, 0),
    memberIds,
  };
}

/**
 * Stamp a batch of association edges consumed. Best-effort: a failure
 * here only means the edges get re-fed next sweep (the minter will
 * dedup onto whatever this pass minted), so log and move on rather than
 * unwinding a landed mint.
 */
async function stampConsumed(
  admin: SupabaseClient,
  userId: string,
  edgeIds: string[],
  log: EdgeLogger,
): Promise<void> {
  if (edgeIds.length === 0) return;
  const { error } = await admin
    .from('samskara_associations')
    .update({ minted_at: new Date().toISOString() })
    .eq('user_id', userId)
    .in('id', edgeIds);
  if (error) {
    log.debug('mint-tier1-assoc: consumption stamp failed', { error: error.message });
  }
}

/**
 * Association-mint probe (SWEEP ONLY): mint a tier-1 samskara from the
 * relation graph rather than the recency window. Where mintTier1Probe
 * sees only the 8 most-recent substrate rows, this reads a hub of
 * unconsumed associations - cross-session recurrence the recency window
 * structurally cannot co-locate - and feeds the hub's cluster, WITH the
 * edge labels in the long-empty sample_labels slot, to the same minter.
 *
 * Self-quenching by the same logic pair-relate uses: every minter
 * verdict (mint, dedup-hit, OR decline) stamps the fed edges consumed,
 * so a stable graph spends one minter call then goes quiet. Only a
 * non-verdict (transport/parse failure, embed failure, or a failed
 * insert) leaves the edges unstamped for a later retry - never stamp
 * evidence we didn't actually adjudicate. New corroboration re-opens
 * the hub as fresh unstamped edges.
 */
async function mintTier1FromAssociationsProbe(
  admin: SupabaseClient,
  userId: string,
  log: EdgeLogger,
  apiKey: string,
): Promise<void> {
  const { data, error } = await admin.rpc('samskara_association_cluster', {
    p_user_id: userId,
  });
  if (error) throw new Error(`mint-tier1-assoc: cluster RPC failed: ${error.message}`);
  const edges = (Array.isArray(data) ? data : []) as AssociationEdgeRow[];
  if (edges.length === 0) {
    log.trace('mint-tier1-assoc: no hub with unconsumed evidence');
    return;
  }

  const cluster = buildAssociationCluster(edges);
  const edgeIds = edges.map((e) => e.association_id);

  const minted = await agentMint(
    apiKey,
    MINTER_PROMPT,
    JSON.stringify({
      sample_labels: cluster.labels,
      sample_situations: cluster.situations,
      reinforcement: cluster.reinforcementSum,
    }),
  );

  // No verdict: leave the edges unconsumed so a later sweep retries.
  if (minted === null) {
    log.debug('mint-tier1-assoc: no verdict, leaving edges unconsumed', {
      edges: edgeIds.length,
    });
    return;
  }

  // Clean refusal: the cluster supports no claim. The evidence is
  // immutable, so consume it - re-asking learns nothing.
  if (minted === 'declined') {
    await stampConsumed(admin, userId, edgeIds, log);
    log.trace('mint-tier1-assoc: minter declined the cluster', { edges: edgeIds.length });
    return;
  }

  const predEmbedding = await embedPrediction(apiKey, minted.prediction);
  if (!predEmbedding) {
    // Reached a mint decision but couldn't embed it (transient). Leave
    // unconsumed; the retry re-mints and embeds.
    log.debug('mint-tier1-assoc: prediction embed failed, leaving edges unconsumed');
    return;
  }

  // Dedup guard, identical to the recency path: a near-duplicate of an
  // existing samskara gets a health bump instead of a twin. Either way
  // the cluster's evidence is spent, so stamp.
  try {
    const { data: nearest } = await admin.rpc('samskara_nearest_by_prediction', {
      p_query_embedding: predEmbedding,
      p_k_max: 1,
      p_user_id: userId,
    });
    const top = Array.isArray(nearest) ? nearest[0] : null;
    if (top && typeof top.cosine === 'number' && top.cosine >= MINT_DEDUP_COSINE) {
      await admin.rpc('samskara_reinforce_existing', {
        p_samskara_id: top.id,
        p_health_bump: MINT_DEDUP_HEALTH_BUMP,
        p_user_id: userId,
      });
      await stampConsumed(admin, userId, edgeIds, log);
      log.debug('mint-tier1-assoc: dedup-reinforced existing', {
        id: top.id,
        cosine: top.cosine,
        candidate: shorten(minted.prediction),
      });
      return;
    }
  } catch (err) {
    if (err instanceof VeniceError) throw err;
    log.debug('mint-tier1-assoc: dedup check failed, proceeding with mint', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Provenance: the member substrate rows (weight 1.0) plus the
  // consumed edges as 'association' kind, weight = reinforcement
  // snapshot at consumption time.
  const provenance = [
    ...cluster.memberIds.map((refId) => ({
      kind: 'substrate' as const,
      refId,
      weight: 1.0,
    })),
    ...edges.map((e) => ({
      kind: 'association' as const,
      refId: e.association_id,
      weight: e.reinforcement,
    })),
  ];
  const id = await insertMint(admin, userId, log, 1, minted, predEmbedding, provenance);
  // Stamp only when the samskara row actually landed: a failed insert
  // leaves the edges unconsumed so the next sweep retries cleanly.
  if (id) {
    await stampConsumed(admin, userId, edgeIds, log);
    log.info('mint-tier1-assoc: minted samskara', {
      id,
      prediction: shorten(minted.prediction),
      edges: edgeIds.length,
    });
  }
}

/**
 * Mint-tier2 probe: ask the detection RPC for a co-fire constellation,
 * generalize it with the tier-2 minter, embed, dedup against existing
 * tier-2s only, insert with samskara-kind provenance. Two dedup nets:
 * the RPC's child-set overlap skip catches the same constellation; the
 * embedding guard catches a different child set that synthesized into
 * the same claim text.
 */
async function mintTier2Probe(
  admin: SupabaseClient,
  userId: string,
  log: EdgeLogger,
  apiKey: string,
): Promise<void> {
  const { data, error } = await admin.rpc('samskara_tier2_candidate', {
    p_user_id: userId,
  });
  if (error) throw new Error(`mint-tier2: candidate RPC failed: ${error.message}`);
  const candidate = (Array.isArray(data) ? data : []) as {
    samskara_id: string;
    prediction: string;
    valence: number | null;
    cofire_weight: number;
  }[];
  if (candidate.length < 3) return;
  log.info(`mint-tier2: candidate group of ${candidate.length} tier-1 samskaras`);

  const minted = await agentMint(
    apiKey,
    TIER2_MINTER_PROMPT,
    JSON.stringify({
      children: candidate.map((c) => ({ prediction: c.prediction, valence: c.valence })),
    }),
  );
  if (minted === null || minted === 'declined') {
    log.trace('mint-tier2: agent declined');
    return;
  }

  const predEmbedding = await embedPrediction(apiKey, minted.prediction);
  if (!predEmbedding) return;

  try {
    const { data: nearest } = await admin.rpc('samskara_nearest_by_prediction', {
      p_query_embedding: predEmbedding,
      p_k_max: 1,
      p_tier: 2,
      p_user_id: userId,
    });
    const top = Array.isArray(nearest) ? nearest[0] : null;
    if (top && typeof top.cosine === 'number' && top.cosine >= MINT_DEDUP_COSINE) {
      await admin.rpc('samskara_reinforce_existing', {
        p_samskara_id: top.id,
        p_health_bump: MINT_DEDUP_HEALTH_BUMP,
        p_user_id: userId,
      });
      log.debug('mint-tier2: dedup-reinforced existing compound', {
        id: top.id,
        cosine: top.cosine,
        candidate: shorten(minted.prediction),
      });
      return;
    }
  } catch (err) {
    if (err instanceof VeniceError) throw err;
    log.debug('mint-tier2: dedup check failed, proceeding with mint', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const id = await insertMint(
    admin,
    userId,
    log,
    2,
    minted,
    predEmbedding,
    candidate.map((c) => ({
      kind: 'samskara' as const,
      refId: c.samskara_id,
      weight: c.cofire_weight,
    })),
  );
  if (id) {
    log.info('mint-tier2: minted compound samskara', {
      id,
      children: candidate.length,
      prediction: shorten(minted.prediction),
      valence: minted.valence,
      confidence: minted.confidence,
    });
  }
}

/**
 * Reaction-classify probe: find the oldest unresolved cohort inside
 * the resolution window, pair it with the assistant message that was
 * sent and the user message that came next, classify, apply.
 */
async function reactionClassifyProbe(
  admin: SupabaseClient,
  userId: string,
  log: EdgeLogger,
  apiKey: string,
): Promise<void> {
  const now = Date.now();
  const minAge = new Date(now - CLASSIFY_CEILING_MS).toISOString();
  const maxAge = new Date(now - CLASSIFY_FLOOR_MS).toISOString();
  const { data: candRows, error: candErr } = await admin
    .from('samskara_fires')
    .select('cohort_id, thread_id, fired_at')
    .eq('user_id', userId)
    .is('was_confirmed', null)
    .gte('fired_at', minAge)
    .lte('fired_at', maxAge)
    .order('fired_at', { ascending: true })
    .limit(1);
  if (candErr) throw new Error(`reaction-classify: candidate query failed: ${candErr.message}`);
  const candidate = candRows?.[0];
  if (!candidate) return;
  log.debug('reaction-classify: candidate cohort', {
    cohortId: candidate.cohort_id,
    threadId: candidate.thread_id,
    firedAt: candidate.fired_at,
  });

  const { data: cohortRows, error: cohortErr } = await admin
    .from('samskara_fires')
    .select('samskara_id')
    .eq('user_id', userId)
    .eq('cohort_id', candidate.cohort_id);
  if (cohortErr) throw new Error(`reaction-classify: cohort read failed: ${cohortErr.message}`);
  const cohortIds = (cohortRows ?? []).map((r) => r.samskara_id as string);
  if (cohortIds.length === 0) return;

  const { data: samskaraRows, error: samErr } = await admin
    .from('samskaras')
    .select('id, prediction')
    .eq('user_id', userId)
    .in('id', cohortIds);
  if (samErr) throw new Error(`reaction-classify: samskara read failed: ${samErr.message}`);
  const cohort = (samskaraRows ?? []).map((r) => ({
    id: r.id as string,
    prediction: r.prediction as string,
  }));
  if (cohort.length === 0) return;

  // The assistant message sent after the fire (no tool_calls, real
  // content), then the user message that followed it. thread_id is
  // the ownership scope - `messages` has no user_id column, and the
  // fire row this candidate came from is anchored to the user's own
  // thread.
  const { data: messages, error: msgErr } = await admin
    .from('messages')
    .select('role, content, tool_calls, created_at')
    .eq('thread_id', candidate.thread_id)
    .gte('created_at', candidate.fired_at)
    .order('created_at', { ascending: true });
  if (msgErr) throw new Error(`reaction-classify: message read failed: ${msgErr.message}`);
  let assistantMsg = '';
  let nextUserMsg = '';
  for (const m of messages ?? []) {
    const content = (m.content as string | null) ?? '';
    if (assistantMsg.length === 0) {
      const toolCalls = m.tool_calls as unknown[] | null;
      if (m.role === 'assistant' && (!toolCalls || toolCalls.length === 0) && content.length > 0) {
        assistantMsg = content;
      }
    } else if (m.role === 'user') {
      nextUserMsg = content;
      break;
    }
  }
  if (assistantMsg.length === 0 || nextUserMsg.length === 0) {
    // The user hasn't replied yet (or the thread shape doesn't fit).
    // Leave the cohort unresolved; decay handles it past the window.
    return;
  }

  const result = await agentClassifyReaction(apiKey, cohort, assistantMsg, nextUserMsg);
  if (!result) {
    log.debug('reaction-classify: agent returned null');
    return;
  }

  const { error: applyErr } = await admin.rpc('samskara_apply_reaction', {
    p_cohort_id: candidate.cohort_id,
    p_confirm_ids: result.confirm,
    p_disconfirm_ids: result.disconfirm,
    p_neutral_ids: result.neutral,
    p_user_id: userId,
  });
  if (applyErr) throw new Error(`reaction-classify: apply RPC failed: ${applyErr.message}`);
  log.info('reaction-classify: applied', {
    cohortId: candidate.cohort_id,
    cohortSize: cohort.length,
    confirm: result.confirm.length,
    disconfirm: result.disconfirm.length,
    neutral: result.neutral.length,
  });
}

/**
 * Dedup probe: one collapse-by-cofiring pass. SQL-only; the RPC caps
 * itself at 20 collapses per call so an over-populated pool drains
 * across ticks rather than one giant transaction.
 */
async function dedupProbe(
  admin: SupabaseClient,
  userId: string,
  log: EdgeLogger,
): Promise<void> {
  const { data, error } = await admin.rpc('samskara_collapse_by_cofiring', {
    p_user_id: userId,
  });
  if (error) throw new Error(`dedup: RPC failed: ${error.message}`);
  const collapsed = typeof data === 'number' ? data : 0;
  if (collapsed > 0) log.debug('dedup: collapsed samskaras', { collapsed });
}

/**
 * Compound-regen probe: cheap should-regen predicate, claim, read the
 * log10-capped top sample, synthesize, save under the claim guard.
 */
async function compoundRegenProbe(
  admin: SupabaseClient,
  userId: string,
  log: EdgeLogger,
  apiKey: string,
): Promise<void> {
  const { data: decisionData, error: decErr } = await admin.rpc(
    'samskara_should_regen_compound',
    { p_user_id: userId },
  );
  if (decErr) throw new Error(`compound-regen: shouldRegen RPC failed: ${decErr.message}`);
  const decision = Array.isArray(decisionData) ? decisionData[0] : decisionData;
  if (!decision || decision.should_regen !== true) return;
  const samskaraCount =
    typeof decision.samskara_count === 'number' ? decision.samskara_count : 0;

  const holderId = crypto.randomUUID();
  const { data: claimed, error: claimErr } = await admin.rpc('samskara_claim_compound_regen', {
    p_holder_id: holderId,
    p_ttl_seconds: REGEN_CLAIM_TTL_SECONDS,
    p_user_id: userId,
  });
  if (claimErr) throw new Error(`compound-regen: claim RPC failed: ${claimErr.message}`);
  if (claimed !== true) return;

  // Read up to a log10-capped count for the summary input, floored at
  // 8 so even a tiny corpus produces a coherent paragraph. (JS
  // Math.log10 here; the SQL threshold in should_regen uses Postgres
  // log(), which is also base 10 - they agree.)
  const cap = Math.max(8, Math.ceil(5.0 * Math.log10(samskaraCount + 10)));
  // Direct table read (the browser wrapper was too - no RPC exists);
  // strongest rows first so the prompt's "stronger samskaras are
  // listed first" contract holds.
  const { data: rowsData, error: rowsErr } = await admin
    .from('samskaras')
    .select('prediction, inner_voice, valence, confidence, health')
    .eq('user_id', userId)
    .order('health', { ascending: false })
    .order('confidence', { ascending: false })
    .limit(cap);
  if (rowsErr) throw new Error(`compound-regen: top-for-summary read failed: ${rowsErr.message}`);
  const rows = (rowsData ?? []) as {
    prediction: string;
    inner_voice: string | null;
    valence: number | null;
    confidence: number;
    health: number;
  }[];
  if (rows.length === 0) return;
  log.info(`compound-regen: synthesizing summary from ${rows.length} sample row(s) (cap ${cap})`);

  const summary = await agentSummarizeCompound(apiKey, rows);
  if (!summary) {
    log.debug('compound-regen: agent returned null');
    return;
  }

  const { data: saved, error: saveErr } = await admin.rpc(
    'samskara_save_compound_summary_if_claimed',
    {
      p_holder_id: holderId,
      p_summary: summary,
      p_samskara_count: samskaraCount,
      p_user_id: userId,
    },
  );
  if (saveErr) throw new Error(`compound-regen: save failed: ${saveErr.message}`);
  if (saved === true) {
    log.info('compound-regen: saved summary', { samskaraCount, chars: summary.length });
  } else {
    log.debug('compound-regen: save rejected (claim expired?)');
  }
}

// --- Drivers ---------------------------------------------------------------

/**
 * Run one phase non-fatally: a single phase's failure logs and yields
 * to the next phase rather than killing the rotation. Venice
 * rate-limits re-throw so the caller can abandon the whole rotation -
 * the next turn or tick retries with fresh budget.
 */
async function runPhase(
  log: EdgeLogger,
  name: string,
  phase: () => Promise<unknown>,
): Promise<void> {
  try {
    await phase();
  } catch (err) {
    if (err instanceof VeniceError && err.kind === 'rate_limit') throw err;
    log.warn(`${name} failed`, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Turn-tail driver. Fired from getStreamingResponse's waitUntil tail
 * between curation and reflection on completed turns. Non-throwing -
 * a samskara failure never disturbs the committed turn.
 *
 * Phase order is load-bearing: reaction-classify first (the resolution
 * window is the only hard timing in the loop), then the assimilate
 * drain (new substrate feeds everything else), then the exploratory
 * probes. The stub this very turn produced is usually NOT visible yet
 * - the browser records it at roughly the same moment this tail runs -
 * so the drain works one turn behind, by construction.
 */
export async function samskaraOnTurnTail(
  adminClient: SupabaseClient,
  userId: string,
): Promise<void> {
  const log = createEdgeLogger(userId, 'samskara');
  try {
    const apiKey = await readVeniceKey(adminClient);
    if (!apiKey) {
      log.warn('tail: no Venice key configured; skipping');
      return;
    }
    await runPhase(log, 'reaction-classify', () =>
      reactionClassifyProbe(adminClient, userId, log, apiKey),
    );
    await runPhase(log, 'assimilate', () =>
      assimilateDrainForUser(adminClient, userId, log, apiKey, TAIL_ASSIMILATE_CAP),
    );
    await runPhase(log, 'pair-relate', () =>
      pairRelateProbe(adminClient, userId, log, apiKey),
    );
    await runPhase(log, 'mint-tier1', () => mintTier1Probe(adminClient, userId, log, apiKey));
  } catch (err) {
    // Rate-limit (re-thrown by runPhase) or key plumbing: drop the
    // rest of the rotation. The hourly sweep is the backstop.
    log.warn('tail: rotation abandoned', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await log.flush();
  }
}

export interface SamskaraSweepSummary {
  assimilated: number;
  usersSwept: number;
}

/**
 * Hourly sweep driver for the samskara-sweep route. Drains the
 * cross-user assimilate queue, then runs the per-user maintenance
 * rotation (pair-relate, mint-tier1, mint-tier1-assoc, mint-tier2,
 * dedup, compound-regen) for every user with recent samskara activity.
 * Reaction-classify is deliberately absent: classification needs the
 * next user message, which implies a turn, which implies the tail
 * already ran at the right moment - an hourly tick misses the 10
 * minute window by construction.
 */
export async function runSamskaraSweepTick(
  adminClient: SupabaseClient,
): Promise<SamskaraSweepSummary> {
  const summary: SamskaraSweepSummary = { assimilated: 0, usersSwept: 0 };
  const apiKey = await readVeniceKey(adminClient);
  if (!apiKey) {
    console.warn('[samskara-sweep] no Venice key configured; skipping tick');
    return summary;
  }

  // Phase 1: drain the global assimilate queue. Per-claim loggers so
  // each drawer line lands with its owner.
  const touched = new Set<string>();
  while (summary.assimilated < SWEEP_ASSIMILATE_CAP) {
    const holderId = crypto.randomUUID();
    let claim:
      | {
          id?: unknown;
          thread_id?: unknown;
          user_message_id?: unknown;
          assistant_message_id?: unknown;
          user_id?: unknown;
        }
      | null;
    try {
      const { data, error } = await adminClient.rpc('samskara_claim_next_assimilate_for_sweep', {
        p_holder_id: holderId,
        p_ttl_seconds: ASSIMILATE_CLAIM_TTL_SECONDS,
      });
      if (error) throw new Error(error.message);
      claim = Array.isArray(data) ? data[0] : data;
    } catch (err) {
      console.error(
        '[samskara-sweep] assimilate claim failed:',
        err instanceof Error ? err.message : String(err),
      );
      break;
    }
    if (!claim || typeof claim.id !== 'string' || typeof claim.user_id !== 'string') break;
    const userId = claim.user_id;
    const log = createEdgeLogger(userId, 'samskara');
    try {
      await assimilateClaimed(adminClient, userId, log, apiKey, holderId, {
        id: claim.id,
        threadId: claim.thread_id as string,
        userMessageId: claim.user_message_id as string,
        assistantMessageId: (claim.assistant_message_id as string | null) ?? null,
      });
      summary.assimilated++;
      touched.add(userId);
    } catch (err) {
      if (err instanceof VeniceError && err.kind === 'rate_limit') {
        log.warn('assimilate: rate-limited; abandoning tick');
        await log.flush();
        return summary;
      }
      log.warn('assimilate failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      await log.flush();
      break;
    }
    await log.flush();
  }
  if (summary.assimilated >= SWEEP_ASSIMILATE_CAP) {
    console.warn(
      `[samskara-sweep] assimilate cap hit (${SWEEP_ASSIMILATE_CAP}); queue continues next tick`,
    );
  }

  // Phase 2: per-user maintenance rotation for users with recent
  // activity (plus everyone this tick's drain touched).
  let users: string[];
  try {
    const { data, error } = await adminClient.rpc('samskara_sweep_users', {
      p_window_hours: SWEEP_USER_WINDOW_HOURS,
    });
    if (error) throw new Error(error.message);
    users = (Array.isArray(data) ? data : [])
      .map((r: { user_id?: unknown }) => r.user_id)
      .filter((u): u is string => typeof u === 'string');
  } catch (err) {
    console.error(
      '[samskara-sweep] sweep-users RPC failed:',
      err instanceof Error ? err.message : String(err),
    );
    users = [];
  }
  for (const u of touched) if (!users.includes(u)) users.push(u);

  for (const userId of users) {
    const log = createEdgeLogger(userId, 'samskara');
    try {
      await runPhase(log, 'pair-relate', () =>
        pairRelateProbe(adminClient, userId, log, apiKey),
      );
      await runPhase(log, 'mint-tier1', () => mintTier1Probe(adminClient, userId, log, apiKey));
      // Sweep-only: cross-session consolidation from the association
      // graph. Absent from the turn tail on purpose - it isn't
      // latency-sensitive and keeps per-turn Venice spend flat.
      await runPhase(log, 'mint-tier1-assoc', () =>
        mintTier1FromAssociationsProbe(adminClient, userId, log, apiKey),
      );
      await runPhase(log, 'mint-tier2', () => mintTier2Probe(adminClient, userId, log, apiKey));
      await runPhase(log, 'dedup', () => dedupProbe(adminClient, userId, log));
      await runPhase(log, 'compound-regen', () =>
        compoundRegenProbe(adminClient, userId, log, apiKey),
      );
      summary.usersSwept++;
    } catch (err) {
      // Rate-limit: stop sweeping users entirely; the next tick
      // picks the remainder up.
      log.warn('sweep: rotation abandoned', {
        error: err instanceof Error ? err.message : String(err),
      });
      await log.flush();
      break;
    }
    await log.flush();
  }

  console.log(
    `[samskara-sweep] tick done: assimilated=${summary.assimilated} usersSwept=${summary.usersSwept}`,
  );
  return summary;
}

// Test-only surface. The prompts are pinned by the Deno suite (drift
// from the deleted browser copies is behaviour drift); the cluster
// helper and caps get direct unit coverage.
export const __test = {
  ASSIMILATOR_PROMPT,
  RELATOR_PROMPT,
  MINTER_PROMPT,
  TIER2_MINTER_PROMPT,
  REACTION_PROMPT,
  COMPOUND_SUMMARY_PROMPT,
  SAMSKARA_MODEL,
  TAIL_ASSIMILATE_CAP,
  SWEEP_ASSIMILATE_CAP,
  MINT_DEDUP_COSINE,
  MINT_CLUSTER_COSINE_FLOOR,
  MINT_CLUSTER_MAX,
  MINT_CLUSTER_MIN,
  PAIR_RELATE_COSINE_FLOOR,
  buildTopicalCluster,
  buildAssociationCluster,
  cosine,
  parseVector,
  rankPairCandidates,
  stripJsonFence,
};

// Samskara formation pipeline: assimilate chat rounds into substrate,
// relate and cluster them into tier-1 predictive claims, compound
// co-firing claims into tier-2, collapse redundancy, and keep the
// per-user compound summary prose fresh. docs/dev/samskara.md is the
// design doc. (Scoring the user's reactions to fired cohorts moved to
// the next-day evaluation sweep - see agents/samskara_evaluation.ts.)
//
// Two exported drivers, matching the fleet's dual-driver shape:
//
//   - samskaraOnTurnTail(admin, userId) - rides getStreamingResponse's
//     waitUntil tail between curation and reflection. Runs the
//     session-responsive phases: a capped assimilate drain, then one
//     pair-relate probe, then one mint-tier1 probe (the in-session
//     toast surface). Reaction scoring used to run first here; it moved
//     to the next-day evaluation sweep (agents/samskara_evaluation.ts).
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
// Mint toasts: insertMint publishes a samskara-mint Broadcast event on
// the user's private topic, which Chat.svelte relays into the
// notifySamskaraMint path. insertMint is the sole INSERT path into
// `samskaras`, so this reproduces the old INSERT-only toast semantics:
// dedup-reinforce hits update an existing row (never insertMint) and
// therefore stay silent. Broadcast rather than a postgres_changes echo
// keeps `samskaras` out of the realtime publication - see
// _shared/samskara-mint.ts for why its UPDATE churn made that decode
// the single largest database-time consumer.
//
// The fire path, substrate stub recording, priming format, and the
// compound-summary read are chat-scoped and live browser-side
// (src/lib/samskara/).
import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger, type EdgeLogger } from '../../_shared/edge-log.ts';
import { publishSamskaraMint } from '../../_shared/samskara-mint.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { toolComplete } from '../tools/_venice_complete.ts';
import { VeniceError } from '../../_shared/venice.ts';
import { localEmbed } from '../../_shared/local-embed.ts';
import { EMBEDDING_MODEL } from '../../_shared/backfill.ts';
import {
  padEmbeddingForStorage,
} from '../../_shared/backfill.ts';
import { SAMSKARA_MODEL } from '../../_shared/agent-models.ts';

/**
 * Model for every formation phase: five short JSON-out calls plus one
 * prose paragraph, all comfortably fast-tier work. Mistral-small does
 * not accept reasoning_effort, so no call here sends it.
 */

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
 * Centered-cosine threshold above which a proposed mint is treated as
 * a near-duplicate of an existing samskara. "Centered" = both vectors
 * have the user's corpus mean subtracted before the cosine (see the
 * samskara_centering table in schema.sql): raw gte-small cosine
 * occupies [0.67, 1.0] for any two of this user's texts, so the old
 * raw-scale 0.85 bar read as "everything is a duplicate" and shut
 * minting off entirely.
 *
 * 0.50 comes from the 2026-09-05 labeled probe set (80 pairs, scored
 * under CLAIM-mean centering - the scale
 * `samskara_nearest_by_prediction` applies, see its cold-start gate):
 * true rewordings measure 0.21-0.60 centered, same-topic siblings
 * 0.11-0.53, and the embedding cannot separate those two classes
 * (AUC 0.53). The bar therefore sits at the top of the overlap zone
 * to catch clear rewordings while tolerating an occasional twin -
 * the co-fire collapse pass reaps those behaviourally. Absorbing a
 * same-topic sibling is the costlier error (irreversible), so the
 * bar prefers letting a twin through over absorbing a sibling.
 * Below 8 claims the RPC returns no rows (cold-start skip) and every
 * mint proceeds undeduplicated until the claim mean is ready.
 */
const MINT_DEDUP_COSINE = 0.5;

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
 * MINT_CLUSTER_COSINE_FLOOR is on the CENTERED scale (see
 * MINT_DEDUP_COSINE): centered substrate pairs span [-0.39, 1.0] with
 * median ~0.0, so 0.05 reads "more related than the typical pair" -
 * the rank position the old raw 0.60 occupied under bge-m3 (mean 0.575
 * + a margin). Substrate space has no labeled pairs, so this is
 * offset-mapped rather than probe-solved; the minter's decline path
 * is the safety net for incoherent clusters.
 * MINT_CLUSTER_MAX caps the minter sample
 * and provenance batch; MINT_CLUSTER_MIN requires a real cluster
 * before a one-off exchange can crystallize into an instinct.
 */
const MINT_CLUSTER_COSINE_FLOOR = 0.05;
const MINT_CLUSTER_MAX = 5;
const MINT_CLUSTER_MIN = 3;

/**
 * Tier-1 population carrying capacity. Both tier-1 mint probes skip
 * (before any Venice spend) while the user's tier-1 count is at or
 * above this, so new claims enter only as the reaper or the Hebbian
 * dedup pass makes room. Without the gate, minting at cap forces the
 * collapse RPC's overflow pass to greedy-merge two DISTINCT existing
 * claims (cosine floor 0.60 - the "related but distinct" band tier-2
 * detection owns) for every new mint: a 2026-07 prod audit measured
 * 49 mints/week churning through exactly that treadmill. MUST mirror
 * `p_target_count` on `samskara_collapse_by_cofiring` in
 * supabase/schema.sql - if the two drift, either the gate never opens
 * (cap here lower) or the treadmill quietly resumes (cap here higher).
 */
const TIER1_POPULATION_CAP = 150;

/**
 * Hubs the association-mint probe adjudicates per sweep tick. One per
 * tick drained the unconsumed-edge backlog at ~4 edges/hour best case
 * - a 2026-08 audit measured 747 reachable edges across 409 eligible
 * hubs against that rate, months of latency for evidence that already
 * exists. Three per tick caps the extra spend at two easy-task-tier
 * calls per hour (sweep-only) while cutting the drain to weeks. Each
 * iteration re-checks headroom, and a declined hub does not fill the
 * slot its eviction freed, so one victim can fund several
 * adjudications in a single tick.
 */
const ASSOC_HUBS_PER_TICK = 3;

/**
 * mint-tier1 reads just enough recent substrate to seed one topical
 * cluster (it is deliberately recency-seeded). pair-relate no longer
 * reads a recency window - it seeds corpus-wide via
 * samskara_pair_probe_candidates and asks for this many ranked partner
 * candidates per probe, of which it relates the best.
 */
const MINT_WINDOW = 8;
const PAIR_RELATE_K = 8;

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
is fine.

The input MAY carry \`assistant_second_thoughts\`: the assistant's own
automatic post-response review, present only when it flagged a
misgiving about this very response ("hedge" = sounded more certain
than warranted, "reframe" = may have answered a different question
than the user meant, "correct" = suspects a factual error;
\`acted: true\` means the user asked the assistant to take another
pass). Treat it as part of how the round landed: name the misgiving
in \`outcome\`, and weigh it when judging \`valence\` - a flagged
round usually landed worse than the reply text alone suggests, more
so when the user acted on it. It is a one-round gut check, not a
verified fact; do not restate it as a truth about the user.`;

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

/**
 * The second-thoughts doubt handed to the assimilator alongside the
 * exchange - the emergent-loop seam between the two features: a
 * doubt verdict is an embarrassment event, the signal class substrate
 * exists to capture, so it colours the round's outcome/valence and
 * can eventually mint claims about when the assistant's answers miss
 * for this user.
 */
interface AssimilationDoubt {
  disposition: 'hedge' | 'reframe' | 'correct';
  note: string;
  acted: boolean;
}

/**
 * Project a `messages.second_thoughts` jsonb into the assimilator's
 * doubt payload, or null when absent / malformed / a conviction.
 * Conviction is the ~95% base-rate "nothing nagged" verdict - feeding
 * it through would pay prompt tokens to say "no misgiving" on nearly
 * every round, so only real doubts flow. Defensive by the same rule
 * as the browser coercer (src/lib/ui/second-thoughts.ts): a drifting
 * shape reads as "no doubt", never a throw.
 */
function doubtForAssimilation(raw: unknown): AssimilationDoubt | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.v !== 1) return null;
  const d = obj.disposition;
  if (d !== 'hedge' && d !== 'reframe' && d !== 'correct') return null;
  return {
    disposition: d,
    // The reviewer already caps notes at 800 chars; re-cap here so a
    // hand-edited row can't balloon the assimilator payload.
    note: typeof obj.note === 'string' ? obj.note.slice(0, 800).trim() : '',
    acted: obj.acted === true,
  };
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
      // Classification/extraction over evidence already in context - a
      // thinking pass is pure latency and budget burn. The model can
      // reason, so this suppression is load-bearing, not a no-op.
      disableThinking: true,
      // Background curation agent: ride out a transient 429 rather than
      // failing the assimilation on one "model overloaded".
      retryRateLimit: true,
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
  secondThoughts: AssimilationDoubt | null = null,
): Promise<AssimilationResult | null> {
  const payload: Record<string, unknown> = {
    user_message: userMessage,
    assistant_message: assistantMessage,
  };
  // Only doubts ride along (see doubtForAssimilation); the field is
  // omitted, not nulled, so the common no-doubt round pays zero tokens
  // for it.
  if (secondThoughts !== null) payload.assistant_second_thoughts = secondThoughts;
  const raw = await callOnce(apiKey, ASSIMILATOR_PROMPT, JSON.stringify(payload));
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

/**
 * Shape guard for the compound summary - the one agent output stored
 * verbatim as free prose. Every other phase parses JSON, so channel
 * contamination there fails the parse and the claim TTL retries; here
 * the raw content IS the artifact. Venice's GLM serving intermittently
 * routes the model's thinking transcript into the content channel even
 * when disable_thinking is set (observed 2026-09-04: a stored summary
 * arrived as full deliberation followed by the final paragraph). A
 * clean summary is exactly one prose paragraph in the third person;
 * anything else is a leak the caller should retry away, never store.
 */
export function isCleanSummaryParagraph(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // Multiple blank-line-separated blocks = deliberation steps
  // interleaved with drafts (the shape the 2026-09-04 leak took).
  if (/\n\s*\n/.test(trimmed)) return false;
  // A thinking preamble glued to the answer with no blank line. The
  // prompt demands third person, so a first-person opener is never a
  // legitimate summary start.
  if (/^(?:let me|i'll|i will|okay|sure|first,)\b/i.test(trimmed)) return false;
  // Numbered or dashed list lines inside a single block: prose
  // paragraphs don't contain them; planning transcripts do.
  if (/^\s*(?:\d+[.)]\s|-\s)/m.test(trimmed)) return false;
  return true;
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
  log: EdgeLogger,
): Promise<string | null> {
  // Two attempts: a channel-leak response is a serving-backend fault,
  // not a prompt problem, but the backend routes across replicas
  // per-request, so an immediate retry lands somewhere honest roughly
  // half the time. A second failure yields null and the regen probe's
  // claim TTL retries on a later sweep tick, as with any other agent
  // failure.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await callOnce(apiKey, COMPOUND_SUMMARY_PROMPT, JSON.stringify({ samskaras }));
    if (raw === null) return null;
    const trimmed = raw.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
    if (trimmed.length > 0 && isCleanSummaryParagraph(trimmed)) return trimmed;
    // Loud on purpose: the silent-null path is what let the 2026-09-04
    // leak sit in prod for ~24h with no trace outside the stored row.
    log.warn('compound-regen: summary failed shape guard (likely reasoning-channel leak)', {
      attempt,
      chars: trimmed.length,
      head: trimmed.slice(0, 200),
    });
  }
  return null;
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
 *
 * `mean` is the user's stored corpus mean (samskara_centering table):
 * both sides are centered before the cosine so the floor's centered
 * scale applies. Null mean (fresh user) compares raw - the documented
 * fallback that only exists while the corpus is too small to have
 * claims.
 */
function buildTopicalCluster(
  recent: SubstrateRow[],
  mean: number[] | null,
): SubstrateRow[] {
  const seed = recent[0];
  const cluster: SubstrateRow[] = [seed];
  const seedC = mean ? subtractVector(seed.embedding, mean) : seed.embedding;
  for (let i = 1; i < recent.length && cluster.length < MINT_CLUSTER_MAX; i++) {
    const emb = mean ? subtractVector(recent[i].embedding, mean) : recent[i].embedding;
    if (emb.length === 0) continue;
    if (cosine(seedC, emb) >= MINT_CLUSTER_COSINE_FLOOR) {
      cluster.push(recent[i]);
    }
  }
  return cluster;
}

/** Element-wise vector subtraction; returns `a` unchanged on length mismatch. */
function subtractVector(a: number[], b: number[]): number[] {
  if (b.length === 0 || a.length !== b.length) return a;
  return a.map((x, i) => x - b[i]);
}

/**
 * Read one of the user's stored centering means (samskara_centering
 * table in schema.sql). Two registers, and they are NOT
 * interchangeable: claims share a prompt template that observations
 * don't, so each register carries a different shared component -
 * centering claims with the substrate mean leaves a residual that
 * puts 85% of the corpus above the dedup bar (measured 2026-09-05).
 * 'claim' = claim-vs-claim comparisons (mint dedup, collapse, tier-2);
 * 'substrate' = observation-vs-observation (mint clustering, pair
 * probes) and message-vs-claim (fire).
 *
 * Null when absent or below its floor: substrate below 32 rows, or
 * fewer than 8 claims. The mint-dedup caller treats a null claim mean
 * as "skip the dedup guard" (correct cold start - the raw-cosine
 * fallback would read the dedup bar as "everything is a duplicate");
 * the cluster builder falls back to raw for the recency window and
 * lets the minter judge coherence.
 */
async function fetchCenteringMean(
  admin: SupabaseClient,
  userId: string,
  register: 'substrate' | 'claim',
): Promise<number[] | null> {
  const column = register === 'claim' ? 'claim_mean_embedding' : 'mean_embedding';
  const { data, error } = await admin
    .from('samskara_centering')
    .select(column)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return null;
  const raw = (data as Record<string, unknown> | null)?.[column];
  if (raw == null) return null;
  const parsed = parseVector(raw);
  return parsed.length > 0 ? parsed : null;
}

/**
 * Recompute the user's register means (substrate + claim) via the
 * samskara_refresh_centering RPC. One call per user per hourly tick -
 * deliberately not on the fire hot path. Failure is non-fatal: the
 * stored means (if any) keep serving.
 */
async function refreshCentering(
  admin: SupabaseClient,
  userId: string,
  log: EdgeLogger,
): Promise<void> {
  const { error } = await admin.rpc('samskara_refresh_centering', {
    p_user_id: userId,
  });
  if (error) {
    log.warn('centering: refresh failed', { error: error.message });
  }
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
async function embedPrediction(prediction: string): Promise<number[] | null> {
  try {
    const raw = await localEmbed(prediction);
    if (raw.length === 0) return null;
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
 *
 * `predEmbedding` is stamped with the writing model's id: the deploy-
 * time repair block in schema.sql keys its null-stamp half on
 * `embedding_model is null`, and the rotation audit groups by this
 * column - an unstamped mint is invisible to both until its vector
 * happens to be re-embedded. Must stay in sync with the model the
 * caller actually embedded with (EMBEDDING_MODEL).
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
      embedding_model: EMBEDDING_MODEL,
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
  // Pop the mood-pill toast in any open client. Broadcast on the user's
  // private samskaras topic, not a postgres_changes echo (the table is
  // deliberately out of the realtime publication - see samskara-mint.ts).
  // Best-effort and awaited so the POST settles before this tick returns.
  await publishSamskaraMint(userId, {
    tier,
    valence: minted.valence,
    confidence: minted.confidence,
  });
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
  log.trace(`assimilate: claimed substrate ${claim.id} (thread ${claim.threadId})`);

  const wantedIds = [claim.userMessageId, claim.assistantMessageId].filter(
    (id): id is string => typeof id === 'string',
  );
  let userMsg = '';
  let assistantMsg = '';
  let doubt: AssimilationDoubt | null = null;
  // Ownership scoping rides thread_id: `messages` has no user_id
  // column (ownership routes through threads.user_id), and the claim
  // RPC already proved the substrate row - and therefore its thread -
  // belongs to this user.
  const { data: messages, error: msgErr } = await admin
    .from('messages')
    .select('id, content, second_thoughts')
    .eq('thread_id', claim.threadId)
    .in('id', wantedIds);
  if (msgErr) throw new Error(`assimilate: message read failed: ${msgErr.message}`);
  for (const m of messages ?? []) {
    if (m.id === claim.userMessageId) userMsg = (m.content as string | null) ?? '';
    if (m.id === claim.assistantMessageId) {
      assistantMsg = (m.content as string | null) ?? '';
      // The reviewer's doubt verdict, when one landed on this answer.
      // Timing is forgiving by construction: the reviewer writes
      // seconds after the turn while assimilation waits for a later
      // tail or the hourly sweep, so the verdict is normally present;
      // `acted` may still lag a user who refines much later. Either
      // absence just degrades to the doubt-free payload.
      doubt = doubtForAssimilation(m.second_thoughts);
    }
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

  // Drawer breadcrumb for the doubt feed: the payload field is
  // otherwise invisible (the agent call is not logged verbatim), and
  // the QA doubt-variant check needs a positive signal beyond "the
  // outcome prose mentions it".
  if (doubt !== null) {
    log.debug('assimilate: doubt verdict attached', {
      substrateId: claim.id,
      disposition: doubt.disposition,
      acted: doubt.acted,
    });
  }
  const result = await agentAssimilate(apiKey, userMsg, assistantMsg, doubt);
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
    log.trace(`assimilate: saved substrate ${claim.id}`);
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
 * CENTERED-cosine floor for pair-relate candidates (see
 * MINT_DEDUP_COSINE for the centering contract). Deliberately loose,
 * below the corpus median: the floor only bounds which substrate
 * pairs reach the relator LLM, which makes the real accept/decline
 * judgment. The old raw 0.30 sat ~0.28 below the bge-m3 pairwise
 * mean; the centered floor keeps the same looseness.
 */
const PAIR_RELATE_COSINE_FLOOR = -0.2;

/**
 * Pair-relate probe: seed on the longest-unseeded embedded observation
 * (corpus-wide round-robin via samskara_pair_probe_candidates, NOT the
 * recency frontier - an earlier version seeded only on the newest row and
 * ranked partners within just the 40 newest, so associations among older
 * observations went permanently unexplored), take the seed's closest
 * still-unadjudicated partner, ask the relator once, and persist the
 * verdict either way - associations via the samskara_associate RPC (whose
 * conflict clause increments reinforcement atomically), declines into the
 * samskara_pair_declines ledger. The RPC excludes already-adjudicated
 * pairs in SQL, so once a seed's neighbourhood is fully ruled on it yields
 * no candidate and the probe returns before spending a Venice call - what
 * lets a quiet corpus go fully silent. One pair per probe keeps the LLM
 * call rate bounded.
 */
async function pairRelateProbe(
  admin: SupabaseClient,
  userId: string,
  log: EdgeLogger,
  apiKey: string,
): Promise<void> {
  const { data: candData, error: candErr } = await admin.rpc('samskara_pair_probe_candidates', {
    p_user_id: userId,
    p_k: PAIR_RELATE_K,
    p_floor: PAIR_RELATE_COSINE_FLOOR,
  });
  if (candErr) throw new Error(`pair-relate: candidate RPC failed: ${candErr.message}`);
  const rows = (Array.isArray(candData) ? candData : []) as {
    seed_id: string;
    seed_situation: string | null;
    seed_outcome: string | null;
    partner_id: string;
    partner_situation: string | null;
    partner_outcome: string | null;
    cosine: number;
  }[];
  if (rows.length === 0) {
    // No embedded row to seed on, or the seeded observation has no
    // unadjudicated partner above the floor - the probe's quench. The
    // seed was still stamped, so the next probe advances to another row.
    log.trace('pair-relate: no unadjudicated pair for the seeded observation');
    return;
  }

  // The RPC ranked by cosine and already excluded adjudicated pairs, so
  // the first row is the closest partner left to rule on for this seed.
  const pick = rows[0];
  log.info(
    `pair-relate: selected pair ${pick.seed_id} <> ${pick.partner_id} (cosine ${pick.cosine.toFixed(3)})`,
  );
  const result = await agentRelate(
    apiKey,
    { situation: pick.seed_situation, outcome: pick.seed_outcome },
    { situation: pick.partner_situation, outcome: pick.partner_outcome },
  );
  if (!result) {
    // Transport/parse failure, not a verdict - leave the pair
    // unadjudicated so a later probe can retry it.
    log.debug('pair-relate: agent returned null');
    return;
  }

  // Canonical pair ordering, same convention as the table columns (and
  // as the RPC's adjudication-exclusion test).
  const aId = pick.seed_id < pick.partner_id ? pick.seed_id : pick.partner_id;
  const bId = pick.seed_id < pick.partner_id ? pick.partner_id : pick.seed_id;

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
  log.debug(
    `pair-relate: associated ${aId} <> ${bId} (${result.kind}: ${shorten(result.label)}, reinforcement ${reinforcement})`,
  );
}

/**
 * Population-headroom gate shared by the two tier-1 mint probes. True
 * when the user's tier-1 count sits at or above TIER1_POPULATION_CAP.
 * Fails open on a count error: a transient RPC blip should not silence
 * minting, and the collapse RPC's overflow pass still bounds the
 * population if one mint slips through at cap.
 */
async function tier1AtCap(
  admin: SupabaseClient,
  userId: string,
  log: EdgeLogger,
): Promise<boolean> {
  const { count, error } = await admin
    .from('samskaras')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('tier', 1);
  if (error) {
    log.debug('mint gate: tier-1 count failed, proceeding', { error: error.message });
    return false;
  }
  return (count ?? 0) >= TIER1_POPULATION_CAP;
}

/**
 * Cap-or-evict gate shared by BOTH tier-1 mint probes. Returns true
 * when the probe may proceed: the corpus is below cap, or cap-pressure
 * eviction (samskara_evict_for_mint, see the decay section of the dev
 * doc) freed a slot. Shared on purpose: entry to a capped corpus is
 * decided by whether a qualified eviction victim exists, NOT by probe
 * order. When only the recency probe could evict, it ran first in the
 * sweep and refilled every slot it freed, so the association probe -
 * gated on the same cap - starved permanently behind an
 * ever-growing unconsumed-edge backlog (1,082 edges at the 2026-08
 * audit). Eviction errors and no-victim both return false (the probe
 * skips, evidence intact); the next cap-hit retries.
 */
async function ensureTier1Headroom(
  admin: SupabaseClient,
  userId: string,
  log: EdgeLogger,
  probeTag: string,
): Promise<boolean> {
  if (!(await tier1AtCap(admin, userId, log))) return true;
  const { data: evicted, error: evictErr } = await admin.rpc('samskara_evict_for_mint', {
    p_user_id: userId,
  });
  if (evictErr || !evicted) {
    if (evictErr) {
      log.debug(`${probeTag}: eviction RPC failed; skipping mint`, { error: evictErr.message });
    } else {
      log.trace(`${probeTag}: tier-1 at cap, nothing evictable; skipping`);
    }
    return false;
  }
  log.info(`${probeTag}: evicted samskara to free a capped slot`, {
    evictedId: evicted as string,
  });
  return true;
}

/**
 * Mint-tier1 probe: build a topical cluster from the recent window,
 * ask the minter, embed, dedup-guard against the existing corpus,
 * insert with provenance. The INSERT doubles as the toast signal via
 * the realtime relay.
 *
 * Register split inside this probe: the cluster builder compares
 * OBSERVATIONS (substrate mean), the dedup guard compares a minted
 * CLAIM against existing claims (claim mean, centered server-side by
 * samskara_nearest_by_prediction). The two registers carry different
 * shared components; see fetchCenteringMean.
 */
async function mintTier1Probe(
  admin: SupabaseClient,
  userId: string,
  log: EdgeLogger,
  apiKey: string,
): Promise<void> {
  if (!(await ensureTier1Headroom(admin, userId, log, 'mint-tier1'))) return;
  const recent = await recentEmbeddedSubstrate(admin, userId, MINT_WINDOW);
  if (recent.length < MINT_CLUSTER_MIN) return;
  const mean = await fetchCenteringMean(admin, userId, 'substrate');
  const clusterRows = buildTopicalCluster(recent, mean);
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

  const predEmbedding = await embedPrediction(minted.prediction);
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
 *
 * The probe adjudicates up to ASSOC_HUBS_PER_TICK hubs per run. A
 * verdict stamps the fed hub's edges, so the next cluster read returns
 * a DIFFERENT hub; any other outcome breaks the loop - no-headroom and
 * no-hub are terminal for the tick, and a non-verdict must not re-ask
 * the same unchanged hub within it.
 */
async function mintTier1FromAssociationsProbe(
  admin: SupabaseClient,
  userId: string,
  log: EdgeLogger,
  apiKey: string,
): Promise<void> {
  for (let i = 0; i < ASSOC_HUBS_PER_TICK; i++) {
    const outcome = await assocHubOnce(admin, userId, log, apiKey);
    if (outcome !== 'verdict') break;
  }
}

/**
 * Adjudicate one association hub: gate, read the top cluster, ask the
 * minter, apply the verdict. Returns 'verdict' when the hub's edges
 * were stamped (mint, dedup-hit, or decline) so the caller may safely
 * loop to the next hub.
 */
async function assocHubOnce(
  admin: SupabaseClient,
  userId: string,
  log: EdgeLogger,
  apiKey: string,
): Promise<'no-headroom' | 'no-hub' | 'no-verdict' | 'verdict'> {
  // Gate (and, at cap, evict) BEFORE reading the cluster: a skip is a
  // non-verdict, so the hub's edges stay unstamped and the evidence is
  // intact for the sweep that runs once headroom opens or a victim
  // qualifies. A declined hub does not fill the slot its eviction
  // freed, so one victim can fund several adjudications in a tick.
  if (!(await ensureTier1Headroom(admin, userId, log, 'mint-tier1-assoc'))) {
    return 'no-headroom';
  }
  const { data, error } = await admin.rpc('samskara_association_cluster', {
    p_user_id: userId,
  });
  if (error) throw new Error(`mint-tier1-assoc: cluster RPC failed: ${error.message}`);
  const edges = (Array.isArray(data) ? data : []) as AssociationEdgeRow[];
  if (edges.length === 0) {
    log.trace('mint-tier1-assoc: no hub with unconsumed evidence');
    return 'no-hub';
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
    return 'no-verdict';
  }

  // Clean refusal: the cluster supports no claim. The evidence is
  // immutable, so consume it - re-asking learns nothing.
  if (minted === 'declined') {
    await stampConsumed(admin, userId, edgeIds, log);
    log.trace('mint-tier1-assoc: minter declined the cluster', { edges: edgeIds.length });
    return 'verdict';
  }

  const predEmbedding = await embedPrediction(minted.prediction);
  if (!predEmbedding) {
    // Reached a mint decision but couldn't embed it (transient). Leave
    // unconsumed; the retry re-mints and embeds.
    log.debug('mint-tier1-assoc: prediction embed failed, leaving edges unconsumed');
    return 'no-verdict';
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
      return 'verdict';
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
  if (!id) return 'no-verdict';
  await stampConsumed(admin, userId, edgeIds, log);
  log.info('mint-tier1-assoc: minted samskara', {
    id,
    prediction: shorten(minted.prediction),
    edges: edgeIds.length,
  });
  return 'verdict';
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
  log.debug(`mint-tier2: candidate group of ${candidate.length} tier-1 samskaras`);

  const minted = await agentMint(
    apiKey,
    TIER2_MINTER_PROMPT,
    JSON.stringify({
      children: candidate.map((c) => ({ prediction: c.prediction, valence: c.valence })),
    }),
  );
  if (minted === 'declined') {
    // Record the decline so detection advances past this constellation
    // instead of re-offering the same strongest-lift group every sweep
    // (which would starve every weaker uncovered constellation behind
    // it). The candidate RPC TTLs the decline, so a group that later
    // strengthens re-qualifies - we just stamp it here. group_key is the
    // sorted child ids so a re-decline upserts and re-arms the window.
    // Only a clean 'declined' verdict records; a null (transport/parse
    // failure) is NOT a verdict and must leave the group offerable, same
    // discipline as the association-mint decline stamp.
    const childIds = candidate.map((c) => c.samskara_id).sort();
    const { error: declineErr } = await admin.from('samskara_tier2_declines').upsert(
      {
        user_id: userId,
        group_key: childIds.join(','),
        children: childIds,
        declined_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,group_key' },
    );
    if (declineErr) log.debug('mint-tier2: decline write error', { error: declineErr.message });
    log.trace('mint-tier2: agent declined (recorded)');
    return;
  }
  if (minted === null) {
    log.trace('mint-tier2: minter returned null (no verdict, leaving group offerable)');
    return;
  }

  const predEmbedding = await embedPrediction(minted.prediction);
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

  const summary = await agentSummarizeCompound(apiKey, rows, log);
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
 * Phase order is load-bearing: the assimilate drain first (new
 * substrate feeds everything else), then the exploratory probes. The
 * stub this very turn produced is usually NOT visible yet - the
 * browser records it at roughly the same moment this tail runs - so
 * the drain works one turn behind, by construction.
 *
 * Reaction classification used to run first here (its 1-10min window
 * was the only hard timing); it has moved to the next-day evaluation
 * sweep (agents/samskara_evaluation.ts), which judges every fired
 * samskara against the settled conversation and feeds health. Running
 * the live probe too would double-count tallies against the sweep.
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
      // Keep the corpus mean current before anything compares vectors:
      // every similarity dial in the pipeline is calibrated on the
      // centered scale this row defines (see samskara_centering).
      await refreshCentering(adminClient, userId, log);
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
  COMPOUND_SUMMARY_PROMPT,
  SAMSKARA_MODEL,
  TAIL_ASSIMILATE_CAP,
  SWEEP_ASSIMILATE_CAP,
  MINT_DEDUP_COSINE,
  MINT_CLUSTER_COSINE_FLOOR,
  PAIR_RELATE_COSINE_FLOOR,
  MINT_CLUSTER_MAX,
  MINT_CLUSTER_MIN,
  TIER1_POPULATION_CAP,
  ASSOC_HUBS_PER_TICK,
  buildTopicalCluster,
  buildAssociationCluster,
  cosine,
  subtractVector,
  doubtForAssimilation,
  isCleanSummaryParagraph,
  parseVector,
  stripJsonFence,
  insertMint,
};

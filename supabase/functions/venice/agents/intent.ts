// Intent minting agent (function-side, cron-only). The daily sweep
// hands this agent the user's descriptive layer plus the current
// intent portfolio and asks for a PLAN - what to create, retire,
// pause (dormant), or revive - which processMintProposals
// (../../_shared/intent-mint.ts) then validates and caps before any
// row is written. See docs/dev/in-progress/intents.md.
//
// This file owns the agent's pure core: the system prompt (the
// behavior-shaping surface), the payload builder that renders the
// gathered state for the model, and the response parser. The
// orchestration driver (claim a user, gather state, apply the plan,
// write rows + provenance), the claim/save RPCs, and the cron are a
// separate increment. The pure parts are pinned by the Deno suite at
// supabase/functions/tests/intent.test.ts via the __test namespace.
//
// Model: the same static fast-tier map the other curation agents use.
// Minting is judgment-heavy but low-volume (once per active user per
// day), so a small model with a careful prompt is the right tradeoff.

import type { SupabaseClient } from '@supabase/supabase-js';
import { toolComplete } from '../tools/_venice_complete.ts';
import { createEdgeLogger, type EdgeLogger } from '../../_shared/edge-log.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { BIAS_CATALOG, isBiasKey, type BiasKey } from '../../_shared/bias-catalog.ts';
import {
  processMintProposals,
  type ExistingIntent,
} from '../../_shared/intent-mint.ts';
import {
  stepEfficacy,
  populationP0,
  type EfficacyEvidence,
  type TargetDirection,
} from '../../_shared/intent-math.ts';

const INTENT_MODEL = 'mistral-small-3-2-24b-instruct';

// Generous token ceiling: the agent emits a small JSON plan, but a
// thorough portfolio review with rationales over a handful of intents
// plus a few new proposals needs room.
const INTENT_MAX_TOKENS = 4096;

/**
 * The minter's system prompt. This is the surface that decides what
 * growth-intentions the model forms about the user, so it is written
 * for judgment, not brevity (unlike the samskara fast-tier prompts,
 * which pay tokens for inputs).
 *
 * The load-bearing instructions, and why each is here:
 *   - Statements are dispositional LEANS, never commands - the renderer
 *     frames the block as leans and keeps statements verbatim, so an
 *     imperative here would reintroduce the bias/intent conflict the
 *     framing exists to avoid (docs/dev/in-progress/intents.md, the
 *     conflict section).
 *   - The user's explicit instructions and active compensation are
 *     handed in precisely so the minter can AVOID forming an intention
 *     that fights them - conflict is cheapest to prevent at formation.
 *   - Pruning is first-class. The agent sees each intent's efficacy and
 *     employment, and is told to pause / abandon / revive - "changing
 *     its mind" is the point, not accumulation to a cap.
 *   - Restraint: form an intention only on a real repeated pattern with
 *     a plausible lever. Holding few well-grounded intentions beats
 *     filling the cap with speculation.
 */
const INTENT_MINTER_PROMPT = `You maintain a small portfolio of INTENTIONS for one user: standing, longer-arc goals about how to help this specific person grow over time. You are not answering them now. You are deciding, once a day, what you are quietly working toward with them - and, just as importantly, what to stop working toward.

You will receive a JSON object describing:
- "existing_intents": the intentions you already hold, each with its efficacy (how much its target has actually moved the right way relative to a control - null means not yet measurable), recent "openings" (how often a chance to act on it arose), "acted" (how often you took the chance), and recent user "reactions". This is your portfolio under review.
- "samskara_summary" and "top_samskaras": your predictive model of the user (what they tend to do), with ids you can target.
- "biases": cognitive patterns currently being compensated for in your replies, with ids you can target.
- "user_system_prompts": the user's OWN explicit standing instructions to you.
- "memories", "wiki", "recent_threads": supporting context.

Your job is a PORTFOLIO PLAN, not just new ideas. Reviewing and pruning matters as much as adding:
- KEEP (do nothing): an intention that is working - efficacy holding or rising - or one still too new to judge but whose pattern is live.
- RETIRE: an intention that is done, no longer relevant, OR one where openings keep arising but efficacy stays low or falls - the situation comes up and your approach is not landing, so the lever is wrong. Let it go. You may pair a retire with a re-framed "create" that tries a different lever at the same aim.
- DORMANT (pause): an intention whose pattern has gone quiet - few or no recent openings. It is not wrong, just not live right now. Pausing keeps it from cluttering your attention and stops you from re-proposing it; you can revive it later.
- REVIVE: a dormant intention whose pattern has clearly returned and is worth retrying.

Forming a new intention (CREATE):
- Only when there is a real, repeated pattern AND a plausible lever you could actually pull in conversation. Holding three well-grounded intentions beats holding eight speculative ones. Do not fill space for its own sake.
- Write the "statement" as a DISPOSITIONAL LEAN, never a command: "help them notice when they reach for certainty before testing it", "lean on their strength at reframing when they sound stuck" - not "make them..." or "always do...". It describes a direction you incline toward when natural, not an instruction for any single turn.
- Supportive and human. Never clinical, never diagnostic, never a label you would not say kindly to their face. You may work with sensitive or tender material, but as a caring participant, not a therapist writing a chart.
- Bind a TARGET when the intention maps to something measurable, so you can later tell if it is working: a bias ("kind":"bias", "ref": the bias key, "direction":"reduce" usually) or a samskara ("kind":"samskara", "ref": the samskara id, "direction":"reduce" or "reinforce"). If it does not map to anything tracked, use "kind":"none" - a free-form intention that will not be scored.

Hard constraints:
- NEVER form or keep an intention that contradicts the user's explicit instructions in "user_system_prompts". Their stated wishes always win. If an existing intention now conflicts with what they have asked for, retire it.
- NEVER form an intention that would fight an active bias compensation. They should complement each other.
- These are gentle long-term leans, not mandates, and never something you announce to the user as an agenda.

Output ONLY a JSON object, no prose, with these keys (any may be an empty array):
{
  "create": [{"statement": "...", "rationale": "why, in one sentence", "target": {"kind": "bias|samskara|none", "ref": "key-or-id-or-null", "direction": "reduce|reinforce|null"}}],
  "retire": ["intent-id", ...],
  "dormant": ["intent-id", ...],
  "revive": ["intent-id", ...]
}`;

// --- Payload builder -------------------------------------------------------

export interface MinterIntentView {
  id: string;
  statement: string;
  status: 'active' | 'dormant';
  target: { kind: string; ref: string | null; direction: string | null } | null;
  efficacy: number | null;
  openings: number;
  acted: number;
  reactions: string[];
}

export interface MinterInput {
  existingIntents: readonly MinterIntentView[];
  samskaraSummary: string | null;
  topSamskaras: ReadonlyArray<{ id: string; prediction: string; valence: number; health: number }>;
  biases: ReadonlyArray<{ key: string; label: string; tier: string }>;
  userSystemPrompts: readonly string[];
  memories: readonly string[];
  wiki: readonly string[];
  recentThreads: readonly string[];
}

/**
 * Render the gathered descriptive-layer state into the JSON payload the
 * minter reads. Pure: the orchestration driver gathers the data, this
 * shapes it. Keys match the names the prompt references.
 */
export function buildMinterPayload(input: MinterInput): string {
  return JSON.stringify({
    existing_intents: input.existingIntents.map((i) => ({
      id: i.id,
      statement: i.statement,
      status: i.status,
      target: i.target,
      efficacy: i.efficacy,
      openings: i.openings,
      acted: i.acted,
      reactions: i.reactions,
    })),
    samskara_summary: input.samskaraSummary ?? '',
    top_samskaras: input.topSamskaras.map((s) => ({
      id: s.id,
      prediction: s.prediction,
      valence: s.valence,
      health: s.health,
    })),
    biases: input.biases.map((b) => ({ key: b.key, label: b.label, tier: b.tier })),
    user_system_prompts: input.userSystemPrompts,
    memories: input.memories,
    wiki: input.wiki,
    recent_threads: input.recentThreads,
  });
}

// --- Response parsing ------------------------------------------------------

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
 * The four raw proposal arrays, straight off the wire and unvalidated -
 * processMintProposals coerces, validates, dedups, and caps them. This
 * parser only handles transport: strip a markdown fence, parse the
 * JSON, and pull the four keys, tolerating any being absent. Returns
 * null only on a total parse failure (no recoverable object at all), so
 * a model that emitted, say, only "retire" still yields a usable plan.
 */
export interface RawMintProposals {
  rawCreates: unknown[];
  rawRetires: unknown[];
  rawDormant: unknown[];
  rawRevive: unknown[];
}

export function parseMinterResponse(raw: string): RawMintProposals | null {
  let parsed: Record<string, unknown> | null;
  try {
    const obj = JSON.parse(stripJsonFence(raw));
    parsed = typeof obj === 'object' && obj !== null ? (obj as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) return null;

  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  return {
    rawCreates: arr(parsed.create),
    rawRetires: arr(parsed.retire),
    rawDormant: arr(parsed.dormant),
    rawRevive: arr(parsed.revive),
  };
}

/**
 * One minting pass: render the payload, call the model, parse the plan.
 * Returns null on completion or parse failure (the sweep logs and moves
 * on - a missed daily run is harmless, the next one catches up). The
 * caller feeds the result to processMintProposals and applies it.
 */
export async function runMinter(
  apiKey: string,
  input: MinterInput,
): Promise<RawMintProposals | null> {
  let raw: string;
  try {
    const result = await toolComplete({
      apiKey,
      model: INTENT_MODEL,
      // Background curation: ride out a transient 429 rather than
      // dropping the day's plan on one "model overloaded".
      retryRateLimit: true,
      messages: [
        { role: 'system', content: INTENT_MINTER_PROMPT },
        { role: 'user', content: buildMinterPayload(input) },
      ],
      maxTokens: INTENT_MAX_TOKENS,
    });
    raw = result.text;
  } catch {
    return null;
  }
  return parseMinterResponse(raw);
}

// --- Sweep orchestration ---------------------------------------------------
//
// The daily cron POSTs /venice/intent-mint-sweep, which calls
// runIntentMintSweep. It drains up to MINT_SWEEP_CAP due users per tick;
// per user it gathers the descriptive layer + current portfolio, runs
// the minter, validates the plan through processMintProposals, applies
// it, and stamps the run. Best-effort by contract: nothing here may
// throw into the sweep handler, and a per-user failure logs and yields
// to the next user.

const INTENT_MINT_CLAIM_TTL_SECONDS = 300;
// ~daily cadence. A user minted less than this many hours ago is not
// re-picked, so the once-a-day intent is enforced even if the cron
// double-fires.
const INTENT_MINT_MIN_AGE_HOURS = 20;
// Users processed per tick. The cron runs daily, so this bounds a
// single day's worst-case Venice spend (one completion per user); a
// backlog larger than the cap drains across days, acceptable for the
// least time-critical fleet in the app.
const INTENT_MINT_SWEEP_CAP = 25;
// How far back employment telemetry is summarized for the minter's
// pruning decisions.
const EMPLOYMENT_LOOKBACK_DAYS = 30;
// Top samskaras (by health) offered as samskara-target candidates.
const TOP_SAMSKARA_LIMIT = 12;
const RECENT_MEMORY_LIMIT = 20;
// How often a targeted intent is re-sampled and re-scored. Daily would
// be too fast: bias posteriors decay on a 60-day half-life, so day-to-
// day movement is within the deadband and every sample would read as a
// soft miss even while the bias genuinely declines over weeks. Weekly
// spacing gives the metric room to move measurably between samples.
const SAMPLE_INTERVAL_DAYS = 7;
// Trailing window for a samskara target's fire-frequency metric: how
// many recent days of fires count as "the pattern is showing up".
const FIRE_WINDOW_DAYS = 14;

interface BiasSummaryMetricRow {
  bias: string;
  posterior_mean: number;
}

/**
 * Current bias-target metric + matched control. Target value is the
 * bias's posterior mean; the control is the mean posterior across the
 * user's OTHER biases that are NOT themselves the target of an active
 * intent - the untreated cohort. A target that declines faster than
 * that cohort is real movement, not the whole population drifting.
 * Returns null when the target bias has no summary row (nothing to
 * sample yet).
 */
export function biasTargetMetric(
  ref: string,
  rows: readonly BiasSummaryMetricRow[],
  targetedRefs: ReadonlySet<string>,
): { target: number; control: number | null } | null {
  const targetRow = rows.find((r) => r.bias === ref);
  if (!targetRow) return null;
  const controls = rows.filter((r) => !targetedRefs.has(r.bias)).map((r) => r.posterior_mean);
  const control = controls.length
    ? controls.reduce((a, b) => a + b, 0) / controls.length
    : null;
  return { target: targetRow.posterior_mean, control };
}

/**
 * Current samskara-target metric + matched control. Target value is the
 * windowed FIRE COUNT of the targeted prediction (how often the pattern
 * showed up lately) - NOT its health, because a reduce-intent that
 * works makes the pattern rarer, not less predictable. The control is
 * the mean windowed fire count across other untargeted samskaras of the
 * SAME valence sign (a negative pattern is compared against other
 * negative patterns), counting non-firing ones as zero. Returns null
 * when the target samskara no longer exists.
 */
export function samskaraTargetMetric(
  ref: string,
  valence: ReadonlyMap<string, number>,
  fireCounts: ReadonlyMap<string, number>,
  targetedRefs: ReadonlySet<string>,
): { target: number; control: number | null } | null {
  if (!valence.has(ref)) return null;
  const targetSign = Math.sign(valence.get(ref) as number);
  const controls: number[] = [];
  for (const [id, v] of valence) {
    if (id === ref || targetedRefs.has(id)) continue;
    if (Math.sign(v) !== targetSign) continue;
    controls.push(fireCounts.get(id) ?? 0);
  }
  const control = controls.length
    ? controls.reduce((a, b) => a + b, 0) / controls.length
    : null;
  return { target: fireCounts.get(ref) ?? 0, control };
}

function ageDays(iso: string): number {
  return (Date.now() - Date.parse(iso)) / 86_400_000;
}

interface TargetedIntentRow {
  id: string;
  target_kind: string;
  target_ref: string | null;
  target_direction: string | null;
  efficacy: number | null;
  confirm_count: number;
  disconfirm_count: number;
}

/**
 * Sample each targeted active intent's descriptive-layer metric, append
 * an intent_target_samples row, and fold the movement-vs-control into
 * the efficacy posterior. Runs at the START of a user's daily pass so
 * the minter then sees fresh efficacy. Per-intent cadence is gated to
 * SAMPLE_INTERVAL_DAYS (the bias posterior moves too slowly for daily
 * deltas to mean anything). The honest-loop core: this is the only
 * writer of intents.efficacy, and it reads only descriptive-layer
 * signals the intent layer does not produce.
 */
async function evaluateTargetedIntents(
  admin: SupabaseClient,
  userId: string,
  log: EdgeLogger,
): Promise<void> {
  const { data: intentsData } = await admin
    .from('intents')
    .select('id,target_kind,target_ref,target_direction,efficacy,confirm_count,disconfirm_count')
    .eq('user_id', userId)
    .eq('status', 'active')
    .in('target_kind', ['bias', 'samskara']);
  const intents = (intentsData ?? []) as TargetedIntentRow[];
  if (intents.length === 0) return;

  const p0 = populationP0(
    intents.map((i) => ({ confirmCount: i.confirm_count, disconfirmCount: i.disconfirm_count })),
  );

  const targetedBiasRefs = new Set(
    intents.filter((i) => i.target_kind === 'bias' && i.target_ref).map((i) => i.target_ref as string),
  );
  const targetedSamskaraRefs = new Set(
    intents.filter((i) => i.target_kind === 'samskara' && i.target_ref).map((i) => i.target_ref as string),
  );

  // Preload the metric sources once per user.
  let biasRows: BiasSummaryMetricRow[] = [];
  if (targetedBiasRefs.size > 0) {
    const { data } = await admin
      .from('bias_summary')
      .select('bias,posterior_mean')
      .eq('user_id', userId);
    biasRows = (data ?? []) as BiasSummaryMetricRow[];
  }
  const valence = new Map<string, number>();
  const fireCounts = new Map<string, number>();
  if (targetedSamskaraRefs.size > 0) {
    const { data: sams } = await admin
      .from('samskaras')
      .select('id,valence')
      .eq('user_id', userId);
    for (const s of (sams ?? []) as Array<{ id: string; valence: number }>) {
      valence.set(s.id, s.valence ?? 0);
    }
    const since = new Date(Date.now() - FIRE_WINDOW_DAYS * 86_400_000).toISOString();
    const { data: fires } = await admin
      .from('samskara_fires')
      .select('samskara_id')
      .eq('user_id', userId)
      .gte('fired_at', since);
    for (const f of (fires ?? []) as Array<{ samskara_id: string }>) {
      fireCounts.set(f.samskara_id, (fireCounts.get(f.samskara_id) ?? 0) + 1);
    }
  }

  for (const intent of intents) {
    if (!intent.target_ref) continue;

    // Cadence gate: skip if sampled within the interval.
    const { data: last } = await admin
      .from('intent_target_samples')
      .select('target_value,control_value,sampled_at')
      .eq('intent_id', intent.id)
      .order('sampled_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last && ageDays(last.sampled_at as string) < SAMPLE_INTERVAL_DAYS) continue;

    const metric =
      intent.target_kind === 'bias'
        ? biasTargetMetric(intent.target_ref, biasRows, targetedBiasRefs)
        : samskaraTargetMetric(intent.target_ref, valence, fireCounts, targetedSamskaraRefs);
    if (!metric) continue; // target metric unavailable (row/samskara gone)

    const { error: insErr } = await admin.from('intent_target_samples').insert({
      user_id: userId,
      intent_id: intent.id,
      target_value: metric.target,
      control_value: metric.control,
    });
    if (insErr) {
      log.warn(`target sample insert failed: ${insErr.message}`);
      continue;
    }

    const prev = last
      ? { target: last.target_value as number, control: (last.control_value as number | null) ?? null }
      : null;
    const step = stepEfficacy({
      direction: (intent.target_direction as TargetDirection) ?? 'reduce',
      prev,
      curr: metric,
      evidence: {
        confirmCount: intent.confirm_count,
        disconfirmCount: intent.disconfirm_count,
      } as EfficacyEvidence,
      p0,
    });
    if (step.efficacy !== null) {
      const { error: updErr } = await admin
        .from('intents')
        .update({
          efficacy: step.efficacy,
          confirm_count: step.evidence.confirmCount,
          disconfirm_count: step.evidence.disconfirmCount,
          updated_at: new Date().toISOString(),
        })
        .eq('id', intent.id);
      if (updErr) log.warn(`efficacy update failed: ${updErr.message}`);
    }
  }
}

interface IntentRow {
  id: string;
  statement: string;
  status: 'active' | 'dormant' | 'retired';
  target_kind: string;
  target_ref: string | null;
  target_direction: string | null;
  efficacy: number | null;
}

/**
 * Read the user's descriptive layer + current portfolio into the
 * minter payload, and return the existing rows the processor needs to
 * validate the plan against. v1 feeds intents+employment, the samskara
 * compound + top samskaras, the surfaced biases, and the user's enabled
 * system prompts + recent memories. Wiki articles and per-thread
 * summaries are a deliberate follow-up - left out here rather than
 * guessed - and the minter handles their absence (empty arrays).
 */
async function gatherMinterInput(
  admin: SupabaseClient,
  userId: string,
): Promise<{ input: MinterInput; existing: ExistingIntent[] }> {
  const since = new Date(
    Date.now() - EMPLOYMENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [intentsRes, empRes, compoundRes, samskaraRes, biasRes, profileRes, memRes] =
    await Promise.all([
      admin
        .from('intents')
        .select('id,statement,status,target_kind,target_ref,target_direction,efficacy')
        .eq('user_id', userId)
        .in('status', ['active', 'dormant']),
      admin
        .from('intent_employments')
        .select('intent_id,opening,acted,user_reaction,created_at')
        .eq('user_id', userId)
        .gte('created_at', since),
      admin
        .from('intent_compound_summary')
        .select('summary')
        .eq('user_id', userId)
        .maybeSingle(),
      admin
        .from('samskaras')
        .select('id,prediction,valence,health')
        .eq('user_id', userId)
        .order('health', { ascending: false })
        .limit(TOP_SAMSKARA_LIMIT),
      admin
        .from('bias_summary')
        .select('bias,tier')
        .eq('user_id', userId)
        .in('tier', ['soft', 'strong']),
      admin.from('profiles').select('settings').eq('user_id', userId).maybeSingle(),
      admin
        .from('memories')
        .select('label,data')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(RECENT_MEMORY_LIMIT),
    ]);

  const intentRows = (intentsRes.data ?? []) as IntentRow[];

  // Aggregate employment telemetry per intent: opening/acted counts and
  // the recent reaction labels. These are what let the minter judge
  // "the lever is not landing" vs "the pattern has gone quiet".
  const empByIntent = new Map<
    string,
    { openings: number; acted: number; reactions: string[] }
  >();
  for (const row of (empRes.data ?? []) as Array<{
    intent_id: string;
    opening: boolean;
    acted: boolean;
    user_reaction: string | null;
  }>) {
    const agg = empByIntent.get(row.intent_id) ?? { openings: 0, acted: 0, reactions: [] };
    if (row.opening) agg.openings += 1;
    if (row.acted) agg.acted += 1;
    if (row.user_reaction) agg.reactions.push(row.user_reaction);
    empByIntent.set(row.intent_id, agg);
  }

  const existing: ExistingIntent[] = intentRows.map((r) => ({
    id: r.id,
    statement: r.statement,
    status: r.status,
  }));

  const existingIntents: MinterIntentView[] = intentRows.map((r) => {
    const agg = empByIntent.get(r.id) ?? { openings: 0, acted: 0, reactions: [] };
    return {
      id: r.id,
      statement: r.statement,
      status: r.status === 'dormant' ? 'dormant' : 'active',
      target:
        r.target_kind === 'none'
          ? { kind: 'none', ref: null, direction: null }
          : { kind: r.target_kind, ref: r.target_ref, direction: r.target_direction },
      efficacy: r.efficacy,
      openings: agg.openings,
      acted: agg.acted,
      reactions: agg.reactions,
    };
  });

  const biases = ((biasRes.data ?? []) as Array<{ bias: string; tier: string }>)
    .filter((b) => isBiasKey(b.bias))
    .map((b) => ({
      key: b.bias,
      label: BIAS_CATALOG[b.bias as BiasKey].label,
      tier: b.tier,
    }));

  // Enabled user system prompts - the explicit instructions an intent
  // may never contradict.
  const settings = (profileRes.data?.settings ?? {}) as {
    systemPrompts?: Array<{ body?: unknown; enabledByDefault?: unknown }>;
  };
  const userSystemPrompts = Array.isArray(settings.systemPrompts)
    ? settings.systemPrompts
        .filter((p) => p && p.enabledByDefault === true && typeof p.body === 'string')
        .map((p) => (p.body as string).trim())
        .filter((b) => b.length > 0)
    : [];

  const memories = ((memRes.data ?? []) as Array<{ label: string; data: string }>).map(
    (m) => `${m.label}: ${m.data}`,
  );

  const input: MinterInput = {
    existingIntents,
    samskaraSummary: (compoundRes.data?.summary as string | undefined) ?? null,
    topSamskaras: ((samskaraRes.data ?? []) as Array<{
      id: string;
      prediction: string;
      valence: number;
      health: number;
    }>).map((s) => ({
      id: s.id,
      prediction: s.prediction,
      valence: s.valence,
      health: s.health,
    })),
    biases,
    userSystemPrompts,
    memories,
    wiki: [],
    recentThreads: [],
  };

  return { input, existing };
}

/**
 * Apply a validated plan via direct admin-client writes (the samskara
 * mint pattern - not a single transactional RPC). The writes are
 * individually idempotent enough that a mid-failure self-heals on the
 * next daily run: retire/dormant/revive are status sets, and a create
 * that landed before a crash is deduped by processMintProposals next
 * time because it reads the existing rows first. Provenance in v1
 * records only the target binding (kind + ref) as the formation link -
 * richer source citation waits for the agent to return cited sources.
 */
async function applyMintPlan(
  admin: SupabaseClient,
  userId: string,
  plan: ReturnType<typeof processMintProposals>,
  log: EdgeLogger,
): Promise<void> {
  const nowIso = new Date().toISOString();

  for (const intent of plan.toCreate) {
    const { data, error } = await admin
      .from('intents')
      .insert({
        user_id: userId,
        statement: intent.statement,
        rationale: intent.rationale,
        status: 'active',
        target_kind: intent.target.kind,
        target_ref: intent.target.ref,
        target_direction: intent.target.direction,
        last_minted_at: nowIso,
      })
      .select('id')
      .single();
    if (error || !data) {
      log.warn(`create failed: ${error?.message ?? 'no row returned'}`);
      continue;
    }
    if (intent.target.kind !== 'none' && intent.target.ref) {
      const { error: provErr } = await admin.from('intent_provenance').insert({
        intent_id: data.id,
        user_id: userId,
        kind: intent.target.kind,
        ref_id: intent.target.ref,
      });
      if (provErr) log.warn(`provenance failed: ${provErr.message}`);
    }
  }

  const setStatus = async (ids: string[], status: 'retired' | 'dormant' | 'active') => {
    if (ids.length === 0) return;
    const { error } = await admin
      .from('intents')
      .update({ status, updated_at: nowIso })
      .eq('user_id', userId)
      .in('id', ids);
    if (error) log.warn(`status->${status} failed: ${error.message}`);
  };
  await setStatus(plan.toRetire, 'retired');
  await setStatus(plan.toDormant, 'dormant');
  await setStatus(plan.toRevive, 'active');
}

/**
 * One mint pass for a single claimed user.
 */
async function mintForUser(
  admin: SupabaseClient,
  apiKey: string,
  userId: string,
  log: EdgeLogger,
): Promise<void> {
  // Update efficacy from descriptive-layer movement FIRST, so the
  // minter's pruning sees fresh scores when it decides what to retire.
  await evaluateTargetedIntents(admin, userId, log);

  const { input, existing } = await gatherMinterInput(admin, userId);
  const raw = await runMinter(apiKey, input);
  if (!raw) {
    log.info('minter returned no plan (completion or parse failure); skipping');
    return;
  }
  const plan = processMintProposals({
    rawCreates: raw.rawCreates,
    rawRetires: raw.rawRetires,
    rawDormant: raw.rawDormant,
    rawRevive: raw.rawRevive,
    existing,
  });
  if (plan.droppedForCap > 0) {
    log.info(`dropped ${plan.droppedForCap} create(s) over the active cap`);
  }
  await applyMintPlan(admin, userId, plan, log);
  log.info(
    `minted: +${plan.toCreate.length} create, ${plan.toRetire.length} retire, ` +
      `${plan.toDormant.length} dormant, ${plan.toRevive.length} revive`,
  );
}

/**
 * Cron entry: drain up to MINT_SWEEP_CAP due users. Non-throwing by
 * contract - every per-user failure is caught and logged so one bad
 * user never stops the drain, and the finish RPC always runs to release
 * the claim.
 */
export async function runIntentMintSweep(admin: SupabaseClient): Promise<void> {
  const apiKey = await readVeniceKey(admin);
  if (!apiKey) return; // no Venice key configured; nothing to do

  const holderId = crypto.randomUUID();
  for (let i = 0; i < INTENT_MINT_SWEEP_CAP; i++) {
    const { data: userId, error } = await admin.rpc('intent_mint_claim_next_user', {
      p_holder_id: holderId,
      p_ttl_seconds: INTENT_MINT_CLAIM_TTL_SECONDS,
      p_min_age_hours: INTENT_MINT_MIN_AGE_HOURS,
    });
    if (error || !userId) break; // queue dry or claim error - stop this tick

    const log = createEdgeLogger(userId as string, 'intent');
    try {
      await mintForUser(admin, apiKey, userId as string, log);
    } catch (err) {
      log.warn(`mint pass failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await admin.rpc('intent_mint_finish', {
        p_user_id: userId as string,
        p_holder_id: holderId,
      });
    }
  }
}

export const __test = {
  INTENT_MINTER_PROMPT,
  INTENT_MODEL,
  INTENT_MAX_TOKENS,
  buildMinterPayload,
  parseMinterResponse,
  stripJsonFence,
  biasTargetMetric,
  samskaraTargetMetric,
};

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

import { toolComplete } from '../tools/_venice_complete.ts';

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

export const __test = {
  INTENT_MINTER_PROMPT,
  INTENT_MODEL,
  INTENT_MAX_TOKENS,
  buildMinterPayload,
  parseMinterResponse,
  stripJsonFence,
};

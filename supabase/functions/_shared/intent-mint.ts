// intent-mint --------------------------------------------------------------
//
// The pure proposal-processing core for the intent minting sweep. The
// minter agent (a fast-model LLM, not yet built) reads the descriptive
// layer and emits a set of create/retire operations; this module is the
// trusted boundary that validates, dedups, and caps those proposals
// before any row is written. Same role bias's observe-and-drop logic
// plays for the bias observer agent: the LLM is fallible, so the
// structural guarantees live in tested code, not in the prompt.
//
// Self-contained (no relative imports) so the Deno island, vitest
// (tests/intent-mint.test.ts), and tsc can all load it. The agent
// orchestration + prompt that produce the raw proposals live separately
// in the (not-yet-built) venice/agents/intent.ts and are Deno-tested
// there; this module owns only the deterministic processing.
//
// What this CANNOT do: judge whether an intent semantically conflicts
// with an active bias compensation or the user's explicit system
// prompts. That is the minter agent's job (it is handed both in its
// prompt and instructed to avoid contradictions) - a pure function
// cannot read intent. This module enforces the mechanical invariants:
// well-formed target bindings, no exact-duplicate statements, and the
// active-set cap.

/** Mirrors the target_kind / target_direction DB check constraints. */
export type TargetKind = 'bias' | 'samskara' | 'none';
export type TargetDirection = 'reduce' | 'reinforce';

/**
 * Active-set cap. The minter keeps at most this many intents active;
 * the rest must be retired. Mirrors the bias RENDER_CAP (4) order of
 * magnitude - a small set so the rendered block never crowds the
 * instruction surface (the renderer caps lower still, via the shared
 * COMBINED_APPENDIX_CEILING). Placeholder; the backtest may retune.
 */
export const ACTIVE_INTENT_CAP = 4;

/** A target binding the minter proposed for a new intent. */
export interface ProposedTarget {
  kind: TargetKind;
  ref: string | null;
  direction: TargetDirection | null;
}

/** A new intent the minter wants to create. */
export interface ProposedIntent {
  statement: string;
  rationale: string | null;
  target: ProposedTarget;
}

/** An existing intent row, as much as the processor needs to see. */
export interface ExistingIntent {
  id: string;
  statement: string;
  status: 'active' | 'dormant' | 'retired';
}

/** The deterministic plan the sweep applies after processing. */
export interface MintPlan {
  toCreate: ProposedIntent[];
  toRetire: string[];
}

/**
 * Normalize a statement for dedup comparison: trim, collapse internal
 * whitespace, lowercase. Two statements that differ only in spacing or
 * case are the same intent for the purpose of not minting a twin. This
 * is exact-after-normalization, NOT semantic - near-paraphrases still
 * slip through, the same limitation bias's catalog-key dedup has. The
 * minter's prompt is the first line against paraphrase twins; the
 * backtest will tell us whether a semantic dedup (embedding cosine,
 * like samskara) is worth adding.
 */
export function normalizeStatement(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Is a proposed target binding coherent? 'none' must carry no ref or
 * direction (a free-form intent has nothing to measure); 'bias' and
 * 'samskara' must carry BOTH a ref and a direction (otherwise the
 * efficacy loop has no metric to read and no sense of which way
 * "better" runs). An incoherent binding is dropped rather than
 * coerced - a half-specified target would silently become a free-form
 * intent that looks scored, exactly the firewall-leak shape the design
 * forbids.
 */
export function isValidTarget(t: ProposedTarget): boolean {
  if (t.kind === 'none') return t.ref == null && t.direction == null;
  return (
    typeof t.ref === 'string' &&
    t.ref.length > 0 &&
    (t.direction === 'reduce' || t.direction === 'reinforce')
  );
}

/**
 * Coerce one raw agent proposal (unknown shape off the wire) into a
 * ProposedIntent, or null if it fails a structural check. Drops:
 * non-object input, empty/whitespace statements, and incoherent target
 * bindings. A missing target defaults to free-form ('none') rather than
 * being rejected - the common case where the minter forms an
 * aspirational intent with no measurable hook.
 */
export function coerceProposedIntent(raw: unknown): ProposedIntent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const statement = typeof r.statement === 'string' ? r.statement.trim() : '';
  if (statement.length === 0) return null;

  const rationale =
    typeof r.rationale === 'string' && r.rationale.trim().length > 0
      ? r.rationale.trim()
      : null;

  // Default to free-form when no target object is present.
  let target: ProposedTarget = { kind: 'none', ref: null, direction: null };
  if (typeof r.target === 'object' && r.target !== null) {
    const t = r.target as Record<string, unknown>;
    const kind = t.kind;
    if (kind === 'bias' || kind === 'samskara' || kind === 'none') {
      target = {
        kind,
        ref: typeof t.ref === 'string' && t.ref.length > 0 ? t.ref : null,
        direction:
          t.direction === 'reduce' || t.direction === 'reinforce'
            ? t.direction
            : null,
      };
    } else {
      // An unrecognized kind is a malformed proposal, not a free-form
      // intent - drop it rather than silently downgrading.
      return null;
    }
  }

  if (!isValidTarget(target)) return null;
  return { statement, rationale, target };
}

/**
 * Turn raw minter output into a deterministic MintPlan. The pipeline:
 *
 *   1. Coerce + structurally validate each proposed create; drop the
 *      invalid ones.
 *   2. Validate retires: each must name a real existing intent id;
 *      unknown ids are dropped (the agent hallucinated or raced a
 *      delete).
 *   3. Dedup creates against (a) existing NON-retired intents and (b)
 *      earlier creates in the same batch, by normalized statement.
 *   4. Enforce the active-set cap. The resulting active count is
 *      (existing active not being retired) + surviving creates. When
 *      that exceeds `cap`, creates are trimmed from the END - the
 *      agent emits its proposals in priority order, so the lowest-
 *      priority new intents are the ones dropped, never an existing
 *      one. A cap overflow is reported via `droppedForCap` so the
 *      sweep can log it rather than silently swallowing work.
 *
 * Cap is a parameter (defaults to ACTIVE_INTENT_CAP) so tests can pin
 * the trim behavior at small sizes.
 */
export function processMintProposals(args: {
  rawCreates: readonly unknown[];
  rawRetires: readonly unknown[];
  existing: readonly ExistingIntent[];
  cap?: number;
}): MintPlan & { droppedForCap: number } {
  const cap = args.cap ?? ACTIVE_INTENT_CAP;

  // (2) Validate retires against the existing id set.
  const existingIds = new Set(args.existing.map((e) => e.id));
  const toRetire: string[] = [];
  const retireSet = new Set<string>();
  for (const raw of args.rawRetires) {
    if (typeof raw === 'string' && existingIds.has(raw) && !retireSet.has(raw)) {
      retireSet.add(raw);
      toRetire.push(raw);
    }
  }

  // (3) Build the dedup set: normalized statements of existing intents
  // that are NOT retired (a retired intent's statement is free to be
  // re-minted - the user's pattern came back).
  const seen = new Set<string>();
  for (const e of args.existing) {
    if (e.status !== 'retired' && !retireSet.has(e.id)) {
      seen.add(normalizeStatement(e.statement));
    }
  }

  const coerced: ProposedIntent[] = [];
  for (const raw of args.rawCreates) {
    const intent = coerceProposedIntent(raw);
    if (!intent) continue;
    const key = normalizeStatement(intent.statement);
    if (seen.has(key)) continue; // dup of an existing or earlier-in-batch
    seen.add(key);
    coerced.push(intent);
  }

  // (4) Cap. Active after the plan = (existing active, minus retired) +
  // creates. Trim creates from the end if over.
  const survivingActive = args.existing.filter(
    (e) => e.status === 'active' && !retireSet.has(e.id),
  ).length;
  const room = Math.max(0, cap - survivingActive);
  const toCreate = coerced.slice(0, room);
  const droppedForCap = coerced.length - toCreate.length;

  return { toCreate, toRetire, droppedForCap };
}

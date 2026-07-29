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
// well-formed target bindings, no exact-duplicate statements, no two
// active intents on the same (target_kind, target_ref,
// target_direction) binding, and the active-set cap.

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
  /** Target binding, when known. The processor uses (kind, ref,
   *  direction) to block a new create from targeting the same
   *  measurable pattern as a surviving existing intent - two active
   *  intents on the same target inflate the active set, double-count
   *  efficacy sampling, and confound the matched-control backtest.
   *  Omitted in test fixtures that don't exercise target dedup; the
   *  caller always passes it from the DB row. */
  target?: ProposedTarget;
}

/**
 * The deterministic plan the sweep applies after processing. The four
 * verbs are the minter's portfolio vocabulary - the machinery of
 * "changing its mind" rather than only ever accumulating:
 *
 *   - toCreate  - pursue a new intent.
 *   - toRetire  - abandon one for good (tombstoned; its statement is
 *     free to re-form later if the pattern strongly returns).
 *   - toDormant - pause an active intent whose lever is not landing or
 *     whose pattern has gone quiet. It stays in the table (so dedup
 *     blocks re-minting a twin - the decision sticks) but stops
 *     rendering. This is what prevents the minter from re-proposing the
 *     same goal every single day; pausing is a real decision, not a
 *     deletion.
 *   - toRevive  - resume a dormant intent (the pattern came back, or
 *     the minter wants to retry it, possibly alongside a re-framed
 *     create).
 */
export interface MintPlan {
  toCreate: ProposedIntent[];
  toRetire: string[];
  toDormant: string[];
  toRevive: string[];
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
 * Dedup key for a targeted intent's (kind, ref, direction) binding.
 * Returns null for free-form intents - no target to collide on. Two
 * intents that differ only in statement wording but target the same
 * samskara or bias with the same direction produce the same key, so
 * the dedup in processMintProposals drops the second one. Without
 * this, the minter can seat two active intents on the same target by
 * rephrasing the statement slightly - which wastes a slot, double-
 * counts efficacy sampling on that target, and confounds the
 * matched-control backtest (both intents compete for the same
 * control cohort).
 */
export function targetKey(t: ProposedTarget): string | null {
  if (t.kind === 'none') return null;
  return `${t.kind}|${t.ref}|${t.direction}`;
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
 *   1. Resolve the status-change verbs (retire / dormant / revive)
 *      against the existing rows, validating each against the status
 *      it is legal from and assigning each id to at most one verb. A
 *      single id named by several verbs resolves by precedence
 *      retire > dormant > revive (the more final decision wins), so a
 *      contradictory batch can never half-apply.
 *   2. Coerce + structurally validate each proposed create; drop the
 *      invalid ones.
 *   2b. Collapse verbatim same-sweep churn: a create whose normalized
 *      statement matches an intent being retired from a LIVE state in
 *      this same plan is a fumbled reframe (the minter re-worded
 *      nothing). Cancel that retire (revive if it was paused) so the
 *      goal simply persists, and let the duplicate create drop in (3).
 *      Re-forming a statement that was retired in a PRIOR sweep is
 *      untouched - that row is not in this plan's retire set.
 *   3. Dedup creates against (a) every existing intent that is NOT
 *      retired in the resulting state and (b) earlier creates in the
 *      same batch, by normalized statement. A dormant intent still
 *      blocks a twin - pausing is not a deletion - while a retired
 *      one's statement is free to re-form.
 *   4. Enforce the active-set cap. The resulting active count is
 *      (existing intents whose final status is active) + surviving
 *      creates; dormant and retired do not count, so pausing an intent
 *      frees a slot. When the total exceeds `cap`, creates are trimmed
 *      from the END - the agent emits proposals in priority order, so
 *      the lowest-priority new intents drop, never an existing one. A
 *      cap overflow is reported via `droppedForCap` so the sweep can
 *      log it rather than silently swallowing work.
 *
 * Cap is a parameter (defaults to ACTIVE_INTENT_CAP) so tests can pin
 * the trim behavior at small sizes.
 */
export function processMintProposals(args: {
  rawCreates: readonly unknown[];
  rawRetires: readonly unknown[];
  rawDormant?: readonly unknown[];
  rawRevive?: readonly unknown[];
  existing: readonly ExistingIntent[];
  cap?: number;
}): MintPlan & { droppedForCap: number } {
  const cap = args.cap ?? ACTIVE_INTENT_CAP;
  const byId = new Map(args.existing.map((e) => [e.id, e]));

  // (1) Resolve status-change verbs. `claimed` enforces one verb per
  // id; precedence is the iteration order below (retire, then dormant,
  // then revive). Each verb validates the status it is legal from:
  // retire from active|dormant, dormant from active, revive from
  // dormant. An id that fails its legality check is simply dropped.
  const claimed = new Set<string>();
  const collect = (
    raws: readonly unknown[] | undefined,
    legalFrom: (s: ExistingIntent['status']) => boolean,
  ): string[] => {
    const out: string[] = [];
    for (const raw of raws ?? []) {
      if (typeof raw !== 'string' || claimed.has(raw)) continue;
      const row = byId.get(raw);
      if (!row || !legalFrom(row.status)) continue;
      claimed.add(raw);
      out.push(raw);
    }
    return out;
  };
  const toRetire = collect(args.rawRetires, (s) => s === 'active' || s === 'dormant');
  const toDormant = collect(args.rawDormant, (s) => s === 'active');
  const toRevive = collect(args.rawRevive, (s) => s === 'dormant');

  const retireSet = new Set(toRetire);
  const dormantSet = new Set(toDormant);
  const reviveSet = new Set(toRevive);

  // (2) Coerce + structurally validate the proposed creates.
  const coerced: ProposedIntent[] = [];
  for (const raw of args.rawCreates) {
    const intent = coerceProposedIntent(raw);
    if (intent) coerced.push(intent);
  }

  // (2b) Collapse verbatim same-sweep churn. When one plan both retires
  // an intent AND re-proposes the identical (normalized) statement, the
  // minter meant to re-frame the goal but emitted the same words - a
  // fumbled reframe that nets to no change. Applied literally it would
  // tombstone the old row and insert a fresh active twin with identical
  // text, which surfaces as the same sentence under both "Active" and
  // "Let go" in the inspector (a duplicate that reads as a bug). So read
  // it as "keep pursuing this goal": cancel the redundant retire (and
  // revive the row if it was paused), and the duplicate create then
  // drops out of the dedup below because the surviving statement lands
  // in `seen`. This fires ONLY for an intent that was LIVE
  // (active/dormant) at the start of the sweep. Re-forming a statement
  // that was ALREADY retired in a prior sweep stays allowed - the
  // pattern genuinely came back, the legitimate re-form case - because
  // such a row is not in `retireSet`.
  const retiredFromLive = new Map<string, ExistingIntent>();
  for (const e of args.existing) {
    if (retireSet.has(e.id) && e.status !== 'retired') {
      retiredFromLive.set(normalizeStatement(e.statement), e);
    }
  }
  for (const intent of coerced) {
    const e = retiredFromLive.get(normalizeStatement(intent.statement));
    if (!e) continue;
    retireSet.delete(e.id);
    if (e.status === 'dormant') reviveSet.add(e.id);
  }

  // Final status of an existing intent after the plan applies.
  const finalStatus = (e: ExistingIntent): ExistingIntent['status'] => {
    if (retireSet.has(e.id)) return 'retired';
    if (dormantSet.has(e.id)) return 'dormant';
    if (reviveSet.has(e.id)) return 'active';
    return e.status;
  };

  // (3) Dedup set: normalized statements AND target keys of every
  // intent that ends up non-retired. Dormant counts (a paused intent
  // blocks its twin on both statement and target); retired does not
  // (its pattern is free to re-form). An intent whose same-sweep retire
  // was just cancelled (2b) is non-retired again, so its statement and
  // target land here and drop the duplicate create.
  const seen = new Set<string>();
  const seenTargets = new Set<string>();
  for (const e of args.existing) {
    if (finalStatus(e) !== 'retired') {
      seen.add(normalizeStatement(e.statement));
      if (e.target) {
        const tk = targetKey(e.target);
        if (tk) seenTargets.add(tk);
      }
    }
  }

  // (3b) Dedup creates against surviving existing statements/targets
  // and against earlier creates in the same batch. A create whose
  // target key collides with an already-seen intent is dropped even
  // when the statement wording differs - two active intents on the
  // same (kind, ref, direction) target waste a slot and confound the
  // matched-control backtest.
  const toCreateAll: ProposedIntent[] = [];
  for (const intent of coerced) {
    const key = normalizeStatement(intent.statement);
    if (seen.has(key)) continue; // dup of a surviving existing or earlier create
    const tk = targetKey(intent.target);
    if (tk && seenTargets.has(tk)) continue; // same target as a surviving intent
    seen.add(key);
    if (tk) seenTargets.add(tk);
    toCreateAll.push(intent);
  }

  // (4) Cap on the resulting active set.
  const survivingActive = args.existing.filter((e) => finalStatus(e) === 'active').length;
  const room = Math.max(0, cap - survivingActive);
  const toCreate = toCreateAll.slice(0, room);
  const droppedForCap = toCreateAll.length - toCreate.length;

  return {
    toCreate,
    toRetire: [...retireSet],
    toDormant: [...dormantSet],
    toRevive: [...reviveSet],
    droppedForCap,
  };
}

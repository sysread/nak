# Planned changes

Deferred feature work that we tried and reverted, or scoped out and
haven't started yet. Each entry captures enough context that the
next session can pick it up cleanly without redoing the dead-end
investigation that got it here.

The bar for an entry: the work must have actual context worth
preserving. A trivial idea ("add a button") doesn't belong here -
just file an issue. This doc is for the cases where we burned real
investigation cycles and the lessons learned are worth saving.

When an item finishes, it moves to the ledger at the bottom as one
line - what happened and why - and its full body is deleted. Git
preserves the deep record; `git log -p -- docs/dev/planned-changes.md`
finds any removed entry by its heading.

## Open items

### Toast treatment for action errors (scoped out)

**Status:** scoped out during the completion-status unification
(2026-08-27); pick up only if surface stacking resurfaces.

The Chat screen's completion-status unification collapsed the
transcript-tail surfaces to one card and gave the composer
`.error-bar` a dismiss button, but stopped short of restyling the
`.error-bar` as a dismissible toast. The full treatment would move
action feedback (thread-load failures, attachment validation,
delete/fork failures) out of a persistent bar into a transient toast
that auto-expires. Deferred because the bar now has an explicit
escape hatch and no stacking was reproduced after the unification;
the investigation context lives in `docs/dev/exchange.md`
("The screen's error surfaces and what owns what").

### Judge cursor policy on partial batch failure (rejected)

**Status:** rejected 2026-09-03 after the per-fire evidence fix
shipped. Kept as a short note because the idea reads as obviously
correct and will be re-proposed otherwise.

The Sept 1 audit proposed holding the evaluation cursor when ANY
judge batch fails, not only when all of them do, so dropped
predictions get re-asked. Two reasons not to: it addresses only
whole-batch failures, which stopped occurring after the fleet moved
to a more reliable model (~2026-08-20), leaving the model-omits-an-
id shape untouched; and a retry re-judges the WHOLE thread, so the
threads that retry - the hardest ones to judge - would be the ones
re-scored up to three times. The per-fire evidence gate now blunts
the second objection (a retry no longer re-applies evidence), but
the first stands on its own. Revisit only if whole-batch failures
return, which the judge's `judged N/M` log line makes visible.

### Samskara tier-2 confirm bar (observation)

**Status:** downgraded from planned change to observation
(2026-08-10 audit); re-check at the Sept 1 review.

The tier-2 minter almost never declines a candidate (1 lifetime
decline), which looked like a rubber stamp. The harm hypothesis
failed on outcome data:

- The growth was a **backfill**, not runaway: tier-2 went live
  mid-June, burst 28 mints in its first two weeks over the
  accumulated co-fire graph, then decelerated (16 -> 5 -> 1 -> 0 ->
  4 per week) - the deceleration predates the 08-08 cohort halving.
- Tier-2 fires **outperform** tier-1: held rate 0.819 vs 0.785 on
  genuine tests, genuine-engagement rate 77% vs 21%, avg health
  0.897 vs 0.869.
- Child semantic coherence is low (26 of 45 multi-child compounds
  below the 0.60 topical floor, median 0.588), but that is
  consistent with behavioural (co-fire) grouping plus the minter's
  GENERALIZE mandate, and the outcomes say it works.

No prompt change warranted on current evidence. Re-open the
decline-criterion question only if the mint rate climbs back above
low-single-digits/week WHILE the tier-2 held-rate edge over tier-1
falls.

**Sept 1 re-check:** mint rate stayed low (65 total, +5 over three
weeks; still 1 lifetime decline), so the volume half of the re-open
condition is NOT met - but the held-rate edge FLIPPED: 30-day
tier-2 held rate 0.687 vs tier-1 0.764 (August had 0.819 vs 0.785).
The background fleet moved to a new judge model around 08-20, which
straddles the window. That is a confound but probably not an
excuse: the owner rates the new model as MORE reliable than the
deepseek pair it replaced (better instruction-following, and no
lost-track-of-event-order failures in long threads, which were
regular before). If the more trustworthy judge is the one scoring
compounds below tier-1, the flip is more likely signal than drift.

So the watch condition is now the held-rate edge ALONE, not the
conjunction with mint volume: if tier-2 still trails tier-1 over a
full window judged entirely by the current model, that is the
evidence that compounds are over-general, and the
decline-criterion prompt change re-opens on it. Re-measure with a
window starting no earlier than 2026-08-20.

## Ledger

### Completed

- **Retire the browser supervisor** (2026-06-11): the five
  supervisor units ported server-side (turn tails for the
  thread-shaped units, cron sweeps for the tag queues); the
  supervisor worker and its lease apparatus deleted. Bias and
  samskara formation followed server-side in the same milestone.
  Current model: [architecture.md](./architecture.md),
  "Background-job model".
- **Samskara cohort cutoff** (2026-08-08): fire recording reduced
  from kMax 22 to the rendered set (11). The originally-preferred
  relative score cut was rejected on structural grounds - a cohort
  truncated at k BY SCORE is definitionally the closest-scored k
  rows, so no knee can appear inside it for a cutoff to find.
- **Judge evidence applied once per fire** (2026-09-03): re-judging
  a thread no longer re-applies evidence for fires it already ruled
  on, so a conversation the user returns to stops counting its
  early fires once per settling. Before the change, 76 of 451
  threads spanned 2+ days and carried 49% of all genuine verdicts
  at roughly 2x weight. Forward-only (existing tallies untouched),
  so what changes is the accrual RATE. Baseline at ship, for the
  next audit's before/after: p0 0.858, tier-1 129 rows, median
  health 0.859, min 0.749, mean evidence tally 2.21, max 15.03.
  Watch for slower turnover - rows now take longer to reach the
  eviction bar - and for p0 drifting as the inflation washes out.

### Rejected

- **Biometric unlock for the master password** (attempted 2026-05,
  obsolete 2026-06): WebAuthn-PRF unlock was implemented correctly
  but the test device's PRF stack returned no bytes (the reference
  playground failed identically), and the master-password layer was
  later removed entirely, leaving the feature no target. The full
  PRF reference - playground-verbatim registration knobs, the
  failure-mode table, the hard-won lessons (random `user.id` per
  registration, `prf: {}` on create with eval on get,
  `residentKey: 'required'`) - is preserved in this file's git
  history (entry removed 2026-08-10).

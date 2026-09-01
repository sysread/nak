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
weeks; still 1 lifetime decline), so the re-open condition is NOT
met - but the held-rate edge FLIPPED: 30-day tier-2 held rate 0.687
vs tier-1 0.764 (August had 0.819 vs 0.785). Confound: the
background fleet moved to a new judge model (~08-20), which can
shift verdict standards for both tiers; the flip may be judge
drift rather than tier-2 decay. Keep observing; if the negative
edge persists across another multi-week window WITH a stable judge
model, that - not mint volume - becomes the evidence that
compounds are over-general, and the decline-criterion prompt
change re-opens.

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

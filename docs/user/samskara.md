# Samskara

The **Samskara** tab in the conversation drawer is a read-only window
into the instincts Nak quietly forms about you as you chat - and a
health readout so you can tell, at a glance, that the machinery behind
them is actually working.

A "samskara" is a one-line predictive instinct ("in situations like X,
this user tends to Y") that Nak builds in the background from your
conversations and uses to calibrate its replies. Most of the time these
stay invisible - the only in-chat cue is the small mood emoji in the
bottom-right pill. This tab is where you can deliberately look under the
hood.

## Corpus

Browse, search, filter, and sort everything Nak has formed:

- **Search** finds samskaras by meaning, not just wording.
- **Tier** filters to tier-1 (specific instincts) or tier-2
  (compounds - higher-order instincts Nak distilled from groups of
  tier-1 ones that fire together).
- **Sort** by newest, strongest, most-fired, or recently-fired.
- **Hide similar** folds near-duplicate instincts together; the slider
  controls how aggressively.

Click any row to see its detail - confidence, health, how often it has
fired, and where it came from. For a tier-2 compound, that includes the
tier-1 instincts it was built from.

This view is read-only: you can see what Nak believes, but not edit or
delete from here. If an instinct is wrong, it loses health on its own as
Nak's later conversations contradict it.

## Health

A live snapshot that makes silent failures visible - because the
instinct-forming pipeline runs entirely in the background, a stall would
otherwise be invisible:

- **Workers** - whether the background workers are alive.
- **Backlog & lost signal** - work waiting to be processed, and learning
  signal that aged out before it could be used.
- **Inconsistencies** - internal bookkeeping problems that should stay
  near zero.
- **Staleness** - how long since the always-on summary was rebuilt.
- **Activity** - how many instincts formed and fired recently, and how
  often Nak managed to learn from them.

A green dot means healthy; amber means worth a look; red means something
is stuck.

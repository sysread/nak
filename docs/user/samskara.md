# Samskara

Samskara is the layer of **instincts** Nak quietly forms about you as
you chat. A samskara is a one-line predictive hunch - "in situations
like X, this user tends to Y" - that Nak builds in the background from
your conversations and uses to calibrate its replies. Most of the time
they stay invisible: the only in-chat cue is the small mood emoji in the
bottom-right pill. The surfaces below are where you can deliberately
look under the hood.

Two kinds:

- **Tier 1** - specific instincts formed from individual exchanges.
- **Tier 2 (compounds)** - when several tier-1 instincts reliably fire
  together, Nak occasionally distills them into a single higher-order
  instinct. A compound says something broader than any one of its parts.

Everything here is **read-only**. You can see what Nak believes, but not
edit or delete it. A wrong instinct isn't permanent - it loses "health"
on its own as later conversations contradict it, and eventually stops
mattering.

You can see samskara from three places, by how specific the information
is:

- **The Samskara tab** - everything global (the whole corpus, pipeline
  health, the always-on summary).
- **The mood pill** - the read for the *current conversation*.
- **The pulse icon under a message** - the instincts that fired on a
  *single turn*.

## The Samskara tab

A tab in the conversation drawer (alongside Chats, Memories, Wiki, and
so on). It opens on the **Summary** - the global, always-on read - with
**Corpus** and **Health** as tabs across the top of the panel.

### Summary

The tab's home page, and what you land on when you open it. The always-on
**summary** is a short paragraph capturing Nak's current read on who you
are, which rides along in every reply. It's built across all your
conversations, so it's global - which is why it's the landing page rather
than sitting next to Corpus and Health (where it looked like it belonged
to one instinct). A short note above it orients you on what samskara is.
Jump back here any time with the **Summary button** in the top row of the
panel.

### Corpus

Browse, search, filter, and sort every instinct Nak has formed:

- **Search** finds instincts by meaning, not just wording.
- **Tier** filters to all, tier-1, or tier-2 (compounds).
- **Sort** by newest, strongest, most-fired, or recently-fired.
- **Hide similar** folds near-duplicate instincts under one
  representative; the slider controls how aggressively, and a line under
  it shows how many remain after folding.

Click any row to see its detail - confidence, health, how often it has
fired, and where it came from. For a tier-2 compound, "where it came
from" is the tier-1 instincts it was built from.

### Health

A live snapshot that makes background failures visible - the
instinct-forming machinery runs entirely behind the scenes, so a stall
would otherwise be invisible:

- **Workers** - whether a background worker is running right now. They
  only run while the app is open, so "idle" is normal, not a problem.
- **Backlog** - work waiting to be processed. A few items is normal; a
  large, persistent pile means a worker isn't keeping up.
- **Inconsistencies** - internal bookkeeping that should stay near zero.
- **Staleness** - how long since the always-on summary was rebuilt.
- **Activity** - how many instincts formed and fired recently, and how
  often Nak learned from them. A low "reaction resolution" is expected -
  only the turn right after an instinct fires can confirm it.

The dot at the top is green when healthy, amber when worth a look, and
red when something genuinely needs attention - a deep backlog, a
bookkeeping problem, or a long-stale summary. An idle worker on its own
won't turn it red.

## Mood (per conversation)

The little emoji in the bottom-right **mood pill** reflects *the current
conversation* - where its latest read sits between warm and cool,
confident and tentative. Because it's specific to one conversation, it
opens in its own pop-up rather than on the tab: **click the mood pill**
to see the map and where the current conversation lands on it. It clears
when you switch conversations.

## What fired on a message (per turn)

Each of your messages carries a small **pulse icon** in its action row.
Click it to expand a panel showing exactly which instincts fired on that
turn - the ones that shaped Nak's reply to that specific message - along
with how strongly each matched. This is the most granular view: the tab
is the whole corpus, the mood pill is the conversation, and the pulse
dropdown is one turn.

# Working intentions

Intentions are the one feature that lets Nak **develop with you**
rather than only record. Where samskara, the bias profile, memory, and
the wiki all *describe* who you are, an intention is a standing **goal
Nak forms about how to help you grow** - "help them test a belief
before committing to it," "lean on their knack for reframing when they
sound stuck." Nak forms these quietly from the patterns it already
observes, and leans on them gently in conversation.

This is **off by default.** It only runs when you turn it on under
**Settings -> AI -> Working intentions**.

## What it does when enabled

Once a day, on your own Supabase project (no tab needs to stay open),
Nak reviews its intentions like a small portfolio:

- **forms** a new intention when it sees a real, repeated pattern and a
  plausible way to help with it,
- **pauses** one whose moment has gone quiet,
- **lets go of** one that isn't working - if the chance to help keeps
  coming up but nothing changes, Nak decides the approach is wrong and
  drops it,
- **revives** one worth another try.

Letting go is deliberate. Nak is meant to change its mind, not collect
intentions forever.

When intentions are active, a short **"working intentions"** note rides
in the background of Nak's instructions for the turn. It shapes *how*
Nak engages - never *what* you can ask for.

## Seeing them

The **seedling pill** (the leaf icon) sits at the bottom of the
bottom-right column in the chat view, just below the mood emoji and
above the scroll-to-latest arrow; on a narrow screen it's the last
tile in the diagnostics menu. It opens a shared inspector that also
lists Nak's [follow-ups](./followups.md); with intentions on, a
**Working intentions** section appears there too - a read-only view
of what Nak is working toward, grouped into **Active** (shaping
replies now), **Paused** (set aside while the pattern is quiet), and
**Let go** (abandoned, kept for the record). Each intention is shown with its main lean in **bold** and the
situational cue ("when they sound stuck") in *italic*, so the what and
the when read apart at a glance. Each one also shows what it's trying to shift, an honest read of
whether it's landing ("too new to tell", "landing", "not landing", or
"open-ended" for ones with no measurable target), and why Nak formed
it. You can see everything; you can't hand-edit an intention - Nak
manages the set itself, the same way it manages its
[instincts](./samskara.md). With the feature off, the pill and the
inspector still exist (they carry follow-ups), but no intentions
section appears and none are formed.

If Nak lets a goal go and later takes it back up, the active card is
marked **"reconsidered"** rather than appearing a second time under
"Let go" - so the same wording showing up again reads as a deliberate
revival, not a duplicate.

## The guardrails

- **Your explicit instructions always win.** If you've told Nak to do
  (or not do) something, an intention can never override that. An
  intention that would conflict with your stated wishes is dropped.
- **Never announced, never clinical.** Intentions are gentle leans, not
  an agenda Nak narrates at you, and not diagnoses. They're suspended
  entirely in jokes, banter, and role-play.
- **Honest by design.** Nak only counts an intention as "working" when
  the thing it targets actually improves *more than it would have
  anyway* - it can't congratulate itself for a change it didn't cause.

## Turning it off

Flip the toggle off and the whole pipeline goes idle immediately - no
forming, no influence on replies. Your existing intentions are kept,
not deleted, so turning it back on resumes where you left off.

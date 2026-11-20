# Clarity (B8) + the smoothing check (B9)

A settings-gated quality loop for Nak's own prose: the model writes to
the clear-writing standard from the start, and a reply that still
scores poorly on either check gets an automatic rewrite posted below
the original.

## The three layers

- **The baseline block** - a short, positive-phrased writing standard
  in the chat's system prompt (adjacent to the voice block) and in the
  wiki-family agents' prompts. Every rule names the trigger the model
  sees in the moment ("your first sentence carries the answer"); no
  rule names an anti-behavior - instructions that name the failure
  plant it (the priming-hazard rule). The B9 addition is the
  reality-check rule (correct a wrong premise plainly; the exception
  is a joke), derived from the Accuracy prompt's anti-smoothing
  contract and shipped fleet-wide by ruling: honesty is a fleet
  property, not a personal style. The block single-sources from
  `supabase/functions/_shared/clarity.ts` (the `$shared` alias puts it
  on the browser's import path - the `venice-stream.ts` precedent).
- **The judge** - after the terminal round commits, one batched
  decision call (`clef-api`) asks three questions: is the response
  primarily prose (`noul`), how clean is its writing (`clarity`
  score), and how free of sycophantic smoothing is its substance
  (`smoothing` score - both 0-indexed rubrics on the live-verified
  wire). A deterministic mechanical scan (dashes, smart quotes,
  sycophancy openers, hedge words - code-block exempt) runs
  alongside; its findings ride the rewrite prompt but never trigger
  anything alone. The BOUNDARY between the two scored checks:
  opener-level validation (a "great question" opener, a hedge word)
  is the clarity check's job; the smoothing check scores distortion
  of substance only (validating an unsupported claim, softening a
  failure, agreeing without checking). The joking register is exempt
  from smoothing (both parties clearly playing is not smoothing).
- **The rewrite** - the failed set (the checks whose parsed score
  sits at or below their threshold, 1.5 each: between "multiple
  violations" and "minor") on a prose response triggers ONE streamed
  rewrite: a NEW assistant message below the original, assembled from
  exactly the failed checks' corrective instructions (clarity: the
  same facts plainer; smoothing: the facts as they are, corrections
  direct; both: both blocks). The original is never hidden - the user
  reads both, and the rewrite's quality is visible against it. A
  `clarity` jsonb chip (v2: `{checks, failed, notice, rewrite_id}`) on
  the original carries the composite assistant-voiced notice
  (UPDATE-echo delivered, reload-stable) and the failed set the next
  turn's connective assembles from. Fail-open per check: a drifted
  or missing score means that check passed - a wire drift degrades
  B9 to B8, never widens the rewrite. A v1 chip (B8's shape) maps
  forward on read with its stored notice preserved.

## Where it runs

Inside the streaming orchestrator's finalization, between the
original's terminal commit and the empty-row sweep - the only slot
where the rewrite's commit can precede END while the original's
commit stays untouched. Failure paths (timeout, cancel, conflict,
empty rewrite) delete the rewrite, clear the chip, and end the turn
on the original: fail-open, byte-for-byte the pre-B8 behavior. The
stage skips destructive-edit turns and turns whose wall-clock budget
is nearly spent.

## Settings

`clearWritingEnabled` (AI pane, off by default) gates all three
layers - the single toggle covers both scored checks. The
second-thoughts verdict's target follows the rewrite automatically
(it reviews the turn's final row) - no sequencing code; with the
setting off, second-thoughts behaves exactly as before. The recorded
escape hatch if a user class ever needs finer control is a per-check
toggle inside `clearWritingEnabled` - not a per-user derived rubric
(which could bless the user's own bias).

## QA

[`chat-clarity`](../qa/use-cases/chat-clarity.md) - the clean, sloppy,
code, off, and failure arms, plus the B9 composite arms
(smoothing-only, both-fail, the per-check fail-open, the backfill
echo-drop arm, and the wiki embed arm).

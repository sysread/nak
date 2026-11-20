# Clarity (B8)

A settings-gated quality loop for Nak's own prose: the model writes to
the clear-writing standard from the start, and a reply that still
scores poorly gets an automatic rewrite posted below the original.

## The three layers

- **The baseline block** - a short, positive-phrased writing standard
  in the chat's system prompt (adjacent to the voice block) and in the
  wiki-family agents' prompts. Every rule names the trigger the model
  sees in the moment ("your first sentence carries the answer"); no
  rule names an anti-behavior - instructions that name the failure
  plant it (the priming-hazard rule). The block single-sources from
  `supabase/functions/_shared/clarity.ts` (the `$shared` alias puts it
  on the browser's import path - the `venice-stream.ts` precedent).
- **The judge** - after the terminal round commits, one batched
  decision call (`clef-api`) asks two questions: is the response
  primarily prose (`noul`), and how clean is its writing (`score`,
  0-indexed rubric, live-verified wire). A deterministic mechanical
  scan (dashes, smart quotes, sycophancy openers, hedge words -
  code-block exempt) runs alongside; its findings ride the rewrite
  prompt but never trigger anything alone.
- **The rewrite** - a score below `REWRITE_SCORE_THRESHOLD` (1.5:
  between "multiple violations" and "minor") on a prose response
  triggers ONE streamed rewrite: a NEW assistant message below the
  original, same facts, same language, code untouched. The original
  is never hidden - the user reads both, and the rewrite's quality
  is visible against it. A `clarity` jsonb chip on the original
  carries the assistant-voiced notice (UPDATE-echo delivered,
  reload-stable) and the connective the next turn's model reads
  between the two answers.

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
layers. The second-thoughts verdict's target follows the rewrite
automatically (it reviews the turn's final row) - no sequencing code;
with the setting off, second-thoughts behaves exactly as before.

## QA

[`chat-clarity`](../qa/use-cases/chat-clarity.md) - the clean,
sloppy, code, off, and failure arms.

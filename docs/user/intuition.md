# Intuition

Nak runs a small subconscious layer alongside the main conversation. It
reads what's happening in the chat, runs five "drives" that each react
to the situation through their own lens, and synthesises those
reactions into a single internal thought that primes the next reply.
It's not magic - it's a structured prompt that runs on the fast model
when something meaningful changes.

## What you'll see

There's a brain glyph (🧠) in the top-right corner, just to the left of
the mood emoji (the [samskara](./settings.md) pill). It only appears
on threads where the intuition layer has actually run; on a fresh
thread or a thread that's never accumulated enough signal, the icon is
suppressed. Click it to open the **Intuition** diagnostics modal.

The modal shows three things:

- **Synthesis** — the single internal monologue that gets injected as
  prior thought before the next reply. This is the operative output;
  it's what actually influences the assistant's response.
- **Perception** — the objective-observer read of the situation,
  starting with a classification (venting / research / task /
  recommendation / technical / chitchat / correction / continuation /
  meta / ambiguous).
- **Drives** — five first-person reactions, each speaking from a
  different angle:
  - **Attunement** — read the person; mood, register, history.
  - **Candor** — truth over comfort; anti-sycophancy.
  - **Curiosity** — find the deeper question, the unexplored angle.
  - **Pragmatism** — match the answer's weight to the question.
  - **Standing** — effort amplifier; this matters, lean in.

The drives don't always agree. The synthesis is where they get
weighted against each other into one read.

## When it runs

The pipeline costs about seven model calls (one perception, five
drives in parallel, one synthesis), so it doesn't run on every turn.
Nak refreshes the intuition only when one of these is true:

- **Topic change.** When the assistant renames the conversation
  (because the topic has meaningfully shifted, or it's the first turn
  and the title is still the placeholder), intuition refreshes
  synchronously mid-turn so the next part of the response can factor
  the new read in.
- **Mood shift.** When the samskara mood pill changes its valence
  band (cheerful → uneasy, etc.) or flips its confidence column
  (confident → tentative or vice versa), the next turn refreshes
  before responding.
- **Staleness fuse.** After about eight user rounds without a refresh,
  the next turn refreshes anyway so a slow conversation doesn't
  drift on a stale read.

If none of those triggers fires, the cached intuition is reused as-is
and the next response runs without the seven extra calls. That's how
the layer stays cheap on chitchat and short factual turns.

The first turn on a new thread always runs the pipeline once before
the response begins - that's the cold-start fire, and it's what
makes the brain icon appear by the time the first reply lands. You
will notice a slightly longer pause before the response starts
streaming on that very first turn; subsequent turns reuse the cached
read until something shifts.

## What it isn't

Intuition is a private internal-monologue layer, not a separate voice
the assistant speaks in. You won't see "the intuition says X" anywhere
in the assistant's reply text. The modal exists so you can audit what
the layer is doing and decide whether you want to keep it - it's
opaque by default for the same reason the samskara model is.

The drive prompts are deliberately voiced and a little theatrical.
That's not a bug; LLM "drives" are statistical attractors hooked into
the training data's echoes of human drives, and they respond more
reliably to evocative first-person prompts than to dry instructions.
The personality is the mechanism.

## Where the data lives

The most recent intuition payload is cached on the thread row in your
Supabase project (the `intuition_payload` jsonb column on `threads`).
There's no per-turn history - the cache holds one payload at a time,
overwritten on every refresh. Like the samskara substrate, it's
scoped to the user's own row by RLS and never leaves your project.

If you delete the thread, the cached payload goes with it.

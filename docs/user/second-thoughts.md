# Second thoughts

People double-check themselves. The moment after you answer a
question, a little voice sometimes pipes up - *"wait, was that right?
did I read the question the way they meant it?"* Nak has one of those
voices too.

After the assistant finishes a reply, a fast model re-reads what it
just said and reports how confident it feels about it. That verdict
shows up as a small **Second thoughts** panel below the message. It's a
deliberate model of self-doubt - the same anti-overconfidence instinct
that makes a careful person hedge, caveat, or reconsider.

## What you'll see

The assistant reviews **every** reply in the background - but it only
*shows* you something when it has an actual misgiving. Most answers hold
up, and those stay quiet: no news is good news. So a **Second thoughts**
row appearing under a reply always means the assistant flagged
something. It comes in three flavors:

- **Overconfident** (soft highlight) - the answer is basically fine but
  sounded more certain than it should; a caveat was missing.
- **May have misread** (soft highlight) - the assistant suspects it
  answered a slightly different question than you meant.
- **Possible error** (red) - it suspects an actual factual mistake.

When one appears, the note expands on its own and offers a button in the
assistant's own voice - **"Let me temper that"**, **"Let me re-read your
question"**, or **"Let me double-check that"** depending on what's
bothering it.

## Acting on a second thought

The button is the assistant saying *"I might have goofed - if you
agree, let's refine."* You decide. Click it and the assistant takes
another pass at your question, this time chewing on its own doubt, and
**adds a fresh answer below the original**. Nothing is deleted - you
keep both, so you can compare and see whether the second attempt is
actually better.

While reconsidering, the assistant also quietly recalls what it has
learned about you across past conversations (see
[Samskara](./samskara.md)) - specifically the patterns that bear on
the doubt. That is how it can rule "actually, that was justified - I
know this about you" instead of walking back an answer that was right
for reasons the quick reviewer couldn't see.

The button only appears on the **most recent** answer (a refinement
always adds to the end of the conversation), and only while nothing
else is sending. Once you refine, the two answers stay linked: on later
turns the assistant knows it reconsidered, and treats the refined
answer as its current one rather than getting confused by having said
two things.

Because the reviewer is a fast, deliberately *low-context* model - it
sees the latest question and answer plus a short recap of the messages
just before them, but not the older parts of a long conversation and
not everything Nak knows about you from elsewhere - it will sometimes
raise a doubt about something that was actually justified by context it
couldn't see. That
is exactly why *you* hold the button: a gut check isn't a final ruling.
If a flag looks wrong, just don't click - it costs nothing. And even
when you do click, the assistant is free to reconsider and decide its
first answer was right after all.

## Doubts feed what Nak learns

A flagged answer is also a small lesson. When Nak later digests the
conversation into its long-term picture of you (see
[Samskara](./samskara.md)), a round the assistant had misgivings about
is recorded that way - so over time it can notice patterns like "quick
confident answers on this topic tend to miss for this person." Nothing
extra is shown for this; it just makes the background learning a
little more honest about its own stumbles.

## Where the data lives

Each verdict is stored on the message it reviewed (the
`second_thoughts` column on the `messages` row) in your own Supabase
project, scoped to your rows by the same access rules as the rest of
your chat. If you delete the message or the thread, the verdict goes
with it.

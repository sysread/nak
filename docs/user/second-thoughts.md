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

Below a completed reply, a compact **Second thoughts** row appears a
beat after the answer settles (the review runs in the background, so it
lands just after the text does). It carries a one-word read of how the
assistant feels about the answer:

- **Stands by it** (calm) - no misgivings. This is the common case: the
  reply held up on a second look.
- **Overconfident** (soft highlight) - the answer is basically fine but
  sounded more certain than it should; a caveat was missing.
- **May have misread** (soft highlight) - the assistant suspects it
  answered a slightly different question than you meant, or leaned on
  context you didn't state.
- **Possible error** (red) - it suspects an actual factual mistake.

When the assistant has a genuine misgiving, the note expands on its own
and offers a button in the assistant's own voice - **"Let me temper
that"**, **"Let me re-read your question"**, or **"Let me
double-check that"** depending on what's bothering it. For **Stands by
it** there's no button and nothing to say.

## Acting on a second thought

The button is the assistant saying *"I might have goofed - if you
agree, let's refine."* You decide. Click it and the assistant takes
another pass at your question, this time chewing on its own doubt, and
**adds a fresh answer below the original**. Nothing is deleted - you
keep both, so you can compare and see whether the second attempt is
actually better.

The button only appears on the **most recent** answer (a refinement
always adds to the end of the conversation), and only while nothing
else is sending.

Because the reviewer is a fast, deliberately *low-context* model - it
sees only the latest question and answer, not the whole conversation or
everything Nak knows about you - it will sometimes raise a doubt about
something that was actually justified by context it couldn't see. That
is exactly why *you* hold the button: a gut check isn't a final ruling.
If a flag looks wrong, just don't click - it costs nothing. And even
when you do click, the assistant is free to reconsider and decide its
first answer was right after all.

## Where the data lives

Each verdict is stored on the message it reviewed (the
`second_thoughts` column on the `messages` row) in your own Supabase
project, scoped to your rows by the same access rules as the rest of
your chat. If you delete the message or the thread, the verdict goes
with it.

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

Click the row to expand the assistant's own first-person note about
what nagged at it. For **Stands by it** there's usually nothing to say;
for the others, it's a sentence or two voicing the doubt.

## The catch (for now)

Right now, second thoughts is **display-only**: it tells you what the
assistant is second-guessing, but it doesn't yet go back and fix
anything. A **Possible error** or **May have misread** verdict is a
flag for *you* to weigh, not a correction the assistant has made. A
later version will let a strong-enough doubt trigger the assistant to
reconsider and correct itself in a follow-up - but that's not built
yet, so for now the doubt just surfaces.

Because the reviewer is a fast, deliberately *low-context* model - it
sees only the latest question and answer, not the whole conversation or
everything Nak knows about you - it will sometimes raise a doubt about
something that was actually justified by context it couldn't see. That
is by design: it's a gut check, not a final ruling. Treat a flag as
"worth a glance," not "the assistant was wrong."

## Where the data lives

Each verdict is stored on the message it reviewed (the
`second_thoughts` column on the `messages` row) in your own Supabase
project, scoped to your rows by the same access rules as the rest of
your chat. If you delete the message or the thread, the verdict goes
with it.

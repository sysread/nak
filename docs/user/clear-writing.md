# Clear writing

Nak should be easy to read and honest with you. The **clear writing**
setting turns on a quality pass that checks every reply against both
halves of that promise - and, when a reply falls short, posts a
corrected version right below the original.

It's **off by default**. Turn it on in **Settings → AI → Clear
writing**.

## What you'll see

With the setting on, each finished reply gets read by a fast
model that scores two things:

- **Clarity** - can a busy reader parse every sentence on the first
  pass? Does the answer come first, with reasons after and caveats
  last?
- **Straight talk** - does the reply tell you the truth as it is, or
  does it bend reality to make you feel good? Agreeing with a wrong
  claim, softening a failure, reassuring instead of informing - that's
  what gets flagged here, not bluntness. A direct correction is a
  *good* score.

Most replies pass both checks and nothing happens. When a reply
fails, you get two things:

- **A notice card** between the original reply and the new one -
  the assistant's own voice saying what fell short ("that reply came
  out muddier than it should have been" or "that reply smoothed
  things over more than it should have").
- **A rewritten reply** right below the original, fixed for exactly
  what failed: a muddy reply comes back plainer, a smoothed reply
  comes back straighter, and a reply with both problems gets both
  fixes. The original always stays - nothing is hidden or edited,
  so you can compare the two.

The next time you ask something, Nak reads the pair with a short
note connecting them, so it knows the second answer is the one that
counts.

## What it doesn't do

- **Code is never rewritten.** A reply that's mostly code skips the
  prose checks entirely.
- **Playfulness is exempt.** When you're joking around, the
  straight-talk check doesn't grade the banter.
- **It won't pander to you either.** The straight-talk standard is
  the same for everyone: corrections delivered directly, agreement
  only when earned. If your custom prompts ask for a warmer tone,
  this check still grades the facts.
- **Failures change nothing.** If the checking service is down, the
  reply stands as written.

## The instincts connection

The straight-talk check learns from your [instincts](./samskara.md):
the patterns Nak forms about you across conversations also shape what
"smoothed over" means *for you specifically* - the topics where
you'd most easily be given comfort instead of facts. The fixed
standard always applies underneath; your instincts only make it more
specific. A brand-new account gets the fixed standard alone.

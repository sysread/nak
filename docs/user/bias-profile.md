# Bias profile

Nak watches your past conversations for cognitive biases and
quietly adjusts how it phrases responses to compensate. You don't
have to do anything for it; this page covers what's tracked,
where the math sits, and how to inspect what Nak has noticed
about you.

## What it is

The chat assistant tends to mirror your framing. If you anchor on
a number, it reasons relative to that number. If you state a
position confidently, it elaborates on the position rather than
challenging it. These are not Nak-specific - all chat assistants
do this. Bias profile is the layer that pushes back.

A background analysis pass (an hourly server-side sweep) quietly
reads conversations you've already finished and reports any
cognitive biases it observes in your messages. Evidence accumulates across many conversations via a
calibrated Bayesian aggregation; once enough evidence has piled
up for a particular bias, the assistant's system prompt gains a
short instruction to compensate for it in future responses.

The instruction is silent by default. Nak does not say "I notice
you're exhibiting confirmation bias"; it just surfaces a contrary
view alongside the supporting one. The naming-out-loud path is
reserved for cases where you've explicitly invited that level of
meta-discussion.

## What's tracked

A closed catalog of nineteen biases and System-1 heuristics, drawn
from Kahneman's *Thinking, Fast and Slow* and adjacent literature:

- Confirmation bias, sunk-cost fallacy, anchoring
- Availability and representativeness heuristics, base-rate neglect
- Affect heuristic, substitution, framing effect, loss aversion
- Hindsight bias, overconfidence, the planning fallacy
- WYSIATI (what-you-see-is-all-there-is), narrative fallacy
- Recency bias, negativity bias, black-and-white thinking
- Fundamental attribution error

The catalog is fixed. The analysis only reports against these
names; it cannot invent new categories or stretch a clear bias
to fit a near-miss. The full set of definitions and examples
lives in the source at `src/lib/bias/catalog.ts`.

## What's NOT tracked

- **Conversations from today.** The sweep only processes
  conversations whose last activity falls on a previous day.
  Today's chats might still be in progress; analyzing them while
  you're typing would be intrusive. (This also covers whatever
  conversation you have open right now - sending a message dates
  it today.)
- **Jokes, banter, fiction, role-play, and hypotheticals
  presented for fun.** Nak's framing of "trying on a position
  for play" is explicitly NOT the same as "holding a position";
  the analysis prompt has specific instructions to skip these
  registers, and the assistant's compensation rules are also
  suspended in playful exchanges.

## How to inspect it

Look for the chart-graph icon in the pill column in the
bottom-right corner of the messages pane - below the recall light
bulb and the intuition brain, above the mood emoji. The icon
appears once at least one conversation has been
analyzed. Click it to open the bias profile diagnostics
modal.

The modal has three sections:

- **Per-bias evidence.** One row per catalog entry showing the
  current tier (elided, soft, or strong), the lower bound of
  the 90% credible interval, the posterior mean rate, and the
  effective sample size. Biases marked "in prompt" are the ones
  actively shaping responses this session. Hover any tier or
  "in prompt" badge for a one-line explanation of what it means. Biases never
  flagged in any analyzed conversation read as "no
  evidence" rather than a number - their CI lower would just be
  the prior's 10th-percentile (~5%), and surfacing that as a
  percentage misreads as a real measurement. Rows with at least
  one observation expose a "View N observations" toggle: clicking
  it lists every conversation flagged for that bias,
  with the agent's reasoning quoted underneath. The conversation
  title is a link - clicking jumps to that thread and closes the
  modal.
- **Recently processed conversations.** The latest threads the
  sweep has analyzed. Click any thread to expand and see the
  individual observations it found.
- **Per-observation drill-down.** For each observation, the
  bias name, the confidence level the agent reported, and the
  reasoning it gave. The reasoning quotes the specific message
  it considered evidence.

## How the math works

Brief version. The worker is itself an LLM and shares the same
biases it reports against - the clustering illusion (seeing
patterns in random noise) and the law of small numbers (drawing
strong conclusions from a tiny sample). The math is designed
defensively around this.

- Each conversation contributes one weighted probability per
  bias, combined via noisy-OR across multiple findings in the
  same conversation.
- Across conversations, a Beta-Binomial posterior aggregates
  with exponential recency decay (half-life 60 days).
- The prior is deliberately conservative: equivalent to ten
  fake-non-bias-observed conversations seeded ahead of any
  real evidence. The first few real observations cannot move
  the posterior far.
- The surfacing gate is the LOWER bound of the 90% credible
  interval - not the mean. A high mean with wide uncertainty
  (which is what the clustering illusion looks like) doesn't
  cross the gate. Both "high estimate" and "narrow uncertainty"
  have to be true to surface.
- A hard floor on effective sample size means no bias can
  surface from fewer than five effective conversations regardless
  of how clear the signal looks.

Three tiers:

- **Elided** - not enough evidence; the bias doesn't appear in
  the system prompt at all.
- **Soft** - some evidence; the assistant compensates with
  "occasional" framing.
- **Strong** - sustained evidence; the assistant compensates
  with "consistent" framing.

At most four biases ride in the system prompt at once. Beyond
that, the strongest four by credible-interval lower bound are
chosen; the rest stay visible in the modal but don't crowd the
prompt.

## How the system adapts to your reactions

Each time the sweep analyzes a conversation it also classifies
how you reacted to the bias-compensation behavior the assistant
was instructed to perform. Three outcomes per bias that was
active during that conversation:

- **Affirmed** - you engaged positively with the compensation
  (acknowledged the contrary view, thanked the assistant for
  surfacing the base rate, etc.).
- **Pushed back** - you explicitly rejected the compensation
  ("stop hedging", "just answer the question", "I don't need
  alternatives", etc.).
- **Neutral** - no clear signal either way.

Hover any reaction badge in the modal for a one-line reminder
of what the verdict means and how it nudges the gate.

Those reactions accumulate into a per-bias feedback score that
shifts the surfacing thresholds slightly: consistently affirming
biases surface sooner, consistently pushed-back biases surface
later. The shift is bounded (10 percentage points at the
extremes) so a single bad day cannot knock a real pattern off
the map, and the score is dampened by a neutral prior so a single
strong reaction doesn't dominate.

The reactions for the conversation you have open are visible in
the diagnostics modal alongside the observations, plus a
per-bias feedback column in the evidence table. The score also
appears in the modal footer under the math description.

## Privacy

The bias profile lives in your own Supabase. The worker only
reads conversations you already had on your own infrastructure;
no data leaves your environment beyond the per-conversation
LLM call that Nak already routes through Venice for chat
responses. If you delete a thread, its observations cascade-
delete with it.

There is no enable / disable toggle in v1. The system either runs
or it doesn't.

## Related

- [Intuition](./intuition.md) - Nak's subconscious read of the
  current conversation. Sibling layer to bias profile.
- [Settings](./settings.md) - the general settings modal.

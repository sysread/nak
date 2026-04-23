# The chat interface

The main view — composer at the bottom, conversation above, drawer on
the left. This page covers what each piece does and the gestures that
aren't immediately obvious.

## The composer

### Attaching files

The paperclip button in the composer toolbar queues files for the
next message — click the paperclip, paste an image, or drag-drop
onto the composer. Full details in [Attachments](./attachments.md).

## Streaming responses

Replies stream token-by-token. Under the hood, Nak keeps the markdown
render hot — unfinished code fences, tables, and math resolve
themselves in place as more text arrives, so the view is always an
accurate preview of the finished answer.

### Reasoning ("thinking") panel

Reasoning-capable models stream a chain-of-thought trace **before**
the visible answer. Nak shows it as a block-quote-styled panel that
slides open at the top of the message bubble the moment the first
thinking token arrives. Once the model transitions to the visible
answer, the panel animates closed so the reply takes center stage.

After the fact, every message that has saved reasoning shows a
thought-balloon "Reasoning" header at the top of the bubble. Click
it to expand the block-quote back open — handy for reading *why* the
model answered a specific way without regenerating.

### Citations and sources

Nak has a `web_search` tool the model can reach for when a question
benefits from live web data - news, prices, sports scores, releases
past its training cutoff, today's weather. When the model invokes
the tool, you see a tool-call card in the transcript for the
search, then the final answer. Any sources the search surfaced
come back as citations attached to the reply.

Sourced claims may be marked with small `^N^` superscripts in the
text. Click one and Nak expands the sources list under the message
and flashes the matching row so you can see which URL the model
leaned on. A "sources" button in the action bar (badge = count of
cited sources) expands the same panel on demand. Each row shows
the title, date where provided, and a short snippet; click the
title to open the original page in a new tab.

There is no on/off toggle for web search - the model decides per
turn. Questions that don't need current facts won't trigger the
tool, so they never pay the latency or quota cost of a search.

## Thinking and reasoning effort

## Regenerating a response

The circular-arrow button at the right edge of an assistant message's
action bar re-runs the model on that turn. Click it and the message
greys out, its action buttons disable, and a fresh response streams in
below. Once the new reply lands, the greyed-out original is removed
from the conversation (and the database) - the replacement takes its
place.

The button is on every assistant message, not just the last one. What
gets replaced depends on which message you click:

- **The latest reply.** Just that reply (and any tool calls or
  intermediate reasoning rounds that produced it) is greyed out and
  replaced. Your prompt stays put; the model gets another shot at
  answering it.
- **An older reply.** The clicked message AND every message after it -
  including any later prompts you typed and their replies - are
  greyed out and replaced by a single new response to the prompt that
  came before the clicked message. Useful when you realise an earlier
  turn went off the rails and you want to roll back the conversation
  rather than try to talk the model out of it. (The greyed messages
  stay readable while the new reply streams in, so you can copy
  anything you want to preserve before they're removed.)

The regenerate runs against your current settings - model, reasoning
effort, verbosity, active system prompts. So if you switch to a
different tier and then click regenerate on an older message, the
new response comes from the new model. Tool use (web search, etc.)
re-evaluates from scratch too; the new turn might fetch different
sources than the original.

If the regenerated turn fails partway (network drop, rate limit, you
hit Stop), the greyed messages restore to normal and nothing is
deleted. Try again, or carry on as if you hadn't clicked.

## Copying, editing, and deleting messages

## Stop and resume

## The log drawer

The document-shaped button at the right end of the chat top bar
opens the **log drawer** on the right side of the screen. The
drawer is a live feed of everything Nak writes to its internal
logs - service-worker updates, reflection / summary / embedding
worker progress, recall-agent breadcrumbs, and anything else a
background subsystem wants to tell you about.

Useful when:

- A reply took an unusually long time and you want to see whether a
  background worker was blocked.
- The "new version" banner behaves unexpectedly - every service-
  worker state transition lands in the drawer.
- You filed a bug and the maintainers asked for log context.

Controls inside the drawer:

- **Level dropdown** - choose the minimum severity to show (Debug+
  / Info+ / Warn+ / Error). The `+` means "this level and
  everything more severe", matching the filter behaviour of the
  browser devtools console. The drawer opens at whatever you've
  set as your **Default log level** in Settings > Appearance;
  changing the dropdown here is a within-session override that
  resets on the next open.
- **Search box** - case-insensitive substring match against the
  source tag, the message, and any structured details attached to
  the entry.
- **Clear** - drops the current buffer. The live feed continues to
  populate from the next log event onward.

Each entry shows the level, the local time it was captured, the
subsystem it came from (e.g. `[reflection-worker]`), and the message.
When the message carried structured details - an error stack, a JSON
payload, a captured object - a caret appears at the left of the row;
click to expand / collapse the pretty-printed detail.

Every drawer entry is also written to the browser's devtools console
at the matching level, so if you are more comfortable filtering there
the drawer doesn't take anything away - it just adds an in-app view
that travels with the PWA install.

### Samskara diagnostics

The small fist icon at the top of the log drawer opens a dedicated
**samskara diagnostics** screen - a read-only window into the
samskara pipeline for the current conversation. Useful while
vetting the feature or debugging a "why did the model seem to
already expect X" moment.

The screen shows:

- **Overview counters** - total samskaras (split by tier), total
  pair associations across the corpus, and per-chat counts for
  substrate records and cohort fires.
- **Compound summary** - the prose block currently riding in every
  system prompt, plus how many samskaras it covers and when the
  worker last regenerated it.
- **Cohort fires** - each "cohort" is one turn's worth of
  predictions that fired together. Cards are marked confirmed /
  disconfirmed / waiting / aged out so you can see whether the
  reaction-classify phase has caught up. Each prediction shows its
  ranking score, tier, valence, confidence, and health.
- **Substrate** - the per-turn records the worker is assimilating
  into samskaras, with their lifecycle state (pending assimilation
  / pending embed / fully baked).

The toolbar also has a **Collapse duplicates** button. This is a
one-shot maintenance action: tier-1 samskaras whose predictions are
paraphrases of each other (>= 0.9 cosine similarity on their
embeddings) are merged into the oldest one, with fires and
provenance migrated over. It's idempotent - a second click after a
clean pass reports "No duplicates" - and is mostly only useful if
your corpus accumulated duplicates before the dedup-on-mint guard
was in place. New samskaras are dedup-checked at mint time so the
need for cleanup should fall off over time.

Opens via the fist button in the log drawer header; closes via the
×, Escape, or clicking the backdrop.

## When the model is rate-limited

Venice occasionally returns a 429 "model overloaded" response when the
requested model is under heavy load. When that happens the composer
clears as usual, your message stays in the conversation, and a banner
appears above the composer with the provider's explanation (e.g. "The
model is currently overloaded. Please try again later.").

Next to the banner is a refresh-arrow button — click it to re-send the
same request without retyping. Retries pick up any intermediate
tool-call results from the failed turn, so if the first attempt had
already completed a tool round before the rate-limit hit, the retry
resumes from there rather than starting over.

## Where to go next

- [Threads](./threads.md) — managing the conversation list.
- [Models & reasoning](./models.md) — picking a model per conversation.
- [Keyboard shortcuts](./shortcuts.md).

---
Back to the [index](./README.md).

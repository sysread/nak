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

When web-search is on (see [Settings](./settings.md)), Nak asks
Venice to ground replies in live sources. Sourced claims come back
marked with small `^N^` superscripts in the text. Click one and
Nak expands the sources list under the message and flashes the
matching row so you can see which URL the model leaned on.

A "sources" button in the action bar (badge = count of cited sources)
expands the same panel on demand. Each row shows the title, date
where provided, and a short snippet; click the title to open the
original page in a new tab.

## Thinking and reasoning effort

## Regenerating a response

## Copying, editing, and deleting messages

## Stop and resume

## The log drawer

The document-shaped button at the top of the chat column (next to the
hamburger and the "new conversation" bubble) opens the **log drawer**
on the left side of the screen. The drawer is a live feed of
everything Nak writes to its internal logs - service-worker updates,
reflection / summary / embedding worker progress, recall-agent
breadcrumbs, and anything else a background subsystem wants to tell
you about.

Useful when:

- A reply took an unusually long time and you want to see whether a
  background worker was blocked.
- The "new version" banner behaves unexpectedly - every service-
  worker state transition lands in the drawer.
- You filed a bug and the maintainers asked for log context.

Controls inside the drawer:

- **Level dropdown** - choose the minimum severity to show (All /
  Info+ / Warn+ / Error only). Matches the filter behaviour of the
  browser devtools console.
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

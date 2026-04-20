# The chat interface

The main view — composer at the bottom, conversation above, drawer on
the left. This page covers what each piece does and the gestures that
aren't immediately obvious.

## The composer

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

## Where to go next

- [Threads](./threads.md) — managing the conversation list.
- [Models & reasoning](./models.md) — picking a model per conversation.
- [Keyboard shortcuts](./shortcuts.md).

---
Back to the [index](./README.md).

# Forking a conversation

A fork is a second timeline for a conversation. Both the original and
the fork share everything said up to the fork point; from there each
one continues on its own. Use it to try a different direction without
losing the one you have - ask the same question two ways, take a
tangent without derailing the main thread, or keep a "what if"
experiment separate from the real plan.

## How to fork

Open the three-dot menu on a conversation's row in the drawer and
choose **Fork**. The fork opens immediately, with the whole
conversation so far already in it.

The fork starts with the same title as the original, so the two rows
look alike in the drawer. The fork carries a small branch glyph before
its title - that glyph is how you tell a fork from its original at a
glance.

## What a fork inherits

The fork keeps the original's title, its model and reasoning
settings, and its enabled tools - it behaves like the same
conversation from the first message on.

It does not inherit anything that describes the *conversation so
far* in summary form: the background summary, topic tags, and the
assistant's cached "sense of where this conversation is" all rebuild
for the fork on their own after you start talking in it. That is by
design - they will rebuild around whatever direction the fork
actually takes.

## Shared history is shared, not copied

The messages before the fork point exist once, not twice. Both
conversations read the same history; nothing is duplicated in your
database. That has one visible consequence: history that is shared
with a fork survives deletion. If you delete the original
conversation, it disappears from your lists immediately, but the
part of it the fork builds on stays alive for as long as the fork
does - the fork would otherwise lose its own beginning. Cleanup of
whatever nothing depends on anymore happens automatically in the
background.

Search understands this too: if a match lands in a deleted
conversation's shared history, the result points you at the living
fork that carries that history, never at a conversation you can't
open.

## The assistant's view

Inside a fork, the assistant sees one continuous conversation - it
does not treat the inherited part differently, and you don't need to
re-explain anything. The background helpers that read your
conversations (summaries, topic tags, the memory and bias systems)
are told where the fork point is so they don't double-count the
shared history they already processed in the original.

## Where to go next

- [Threads](./threads.md) - the drawer, renaming, archiving,
  deleting.
- [Search](./search.md) - finding a conversation by meaning.

---
Back to the [index](./README.md).

# Forking a conversation

A fork is a second timeline for a conversation. Both the original and
the fork share everything said up to the fork point; from there each
one continues on its own. Use it to try a different direction without
losing the one you have - ask the same question two ways, take a
tangent without derailing the main thread, or keep a "what if"
experiment separate from the real plan.

## How to fork

There are two ways to fork, differing only in where the shared
history ends.

**The whole conversation:** open the three-dot menu on a
conversation's row in the drawer and choose **Fork**. The fork opens
immediately, with the whole conversation so far already in it.

**From a specific message:** every message card has a small branch
button in its action row (next to the copy and delete buttons). It
forks the conversation at that message: the fork gets everything up
to and including it, and everything after it stays behind in the
original, untouched. Hovering the button outlines the messages that
will stay behind, so you can see exactly where the fork ends before
you click. Use this to rewind to an earlier point and take a
different direction without giving up the turns you already have.

The button appears on your messages and on the assistant's finished
replies - not on a reply that is still streaming or mid-tool-call,
because the fork needs a clean cut point.

The fork keeps the original's title behind a short fork marker: a
fraktur letter f with a small subscript number, so the first fork of
"Sourdough basics" is titled "f1 Sourdough basics" (with the f in
fraktur and the 1 as a subscript). The number counts how many forks
have been made from that same point in the conversation - fork twice
from the same place and the second one gets a 2. Forking a fork does
not stack markers; the new fork gets a fresh marker on the base
title. The fork also carries a small branch glyph before its title
in the drawer.

The marker also means "this fork has not found its own direction
yet." While it is there, the assistant knows it is talking in a
fresh fork, and once your messages make the fork's direction clear
it renames the conversation to match - the marker disappears and
the fork gets a title of its own. You can also rename it yourself
at any time, like any other conversation. A fork of a conversation
that has not been named yet stays unnamed too, and gets its own
automatic title after you start talking in it.

## What a fork inherits

The fork keeps the original's title (behind the fork marker), its
model and reasoning settings, and its enabled tools - it behaves
like the same conversation from the first message on.

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

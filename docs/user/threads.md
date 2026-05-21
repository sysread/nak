# Threads

Every conversation is a thread. The left-hand drawer lists them —
pinned at the top, recent below, archived underneath. This page covers
how to organize, rename, and clean up threads.

## Creating a new thread

## The drawer layout

## Pinning a thread

## Renaming a thread

New threads start with a placeholder title ("New conversation"). The
assistant names them for you as part of its first reply - it picks a
short topical title from whatever you actually asked about, looking
past any opening pleasantry. If the topic of an ongoing thread shifts
significantly later on, the assistant may rename it again to match
what the conversation has become. You'll see a faded *Renamed to X*
line in the transcript at the point where a rename happened.

To rename a thread yourself, click its title in the top bar, type the
new name, and press Enter (or click outside the input). A manual
rename pins the title - once you've set it, the assistant won't
overwrite your choice, even if the topic later changes. To go back to
automatic titles on a thread you've renamed, there's currently no
one-click option; you can rename it to a new title manually, but the
assistant will still consider it pinned. File a request if this
matters to you.

## Archiving and unarchiving

## Deleting a thread

## Filtering by topic

The conversation drawer has a **Topics** button between the search
box and the thread list. Open it to see a checkbox list of every
topic Nak has assigned across your conversations - check one or
more to narrow the list to only threads tagged with any of those
topics. Selections are joined with OR, so checking `baking` and
`bread` shows everything tagged with either.

Each active filter shows up as a pill below the dropdown. Click the
**×** on a pill to remove that one topic from the filter without
reopening the dropdown; **clear** removes all of them at once. The
filter applies to the date-sorted list AND to search results -
typing in the search box while a filter is active gives you "search
within these topics".

A special `untagged` row at the top of the dropdown filters to
threads the background agent hasn't reached yet, or threads where
the agent decided no topic fit. It's useful when you want to see
the backlog draining.

Topics are assigned automatically by a background agent - see
[What runs in the background](./background.md) for what it does and
how the vocabulary stays consistent.

## Responding on multiple devices

If you have Nak open on more than one device or browser tab and
start a reply on one of them, the others know about it. Open the
same conversation on your phone while your laptop is still
producing a response and the phone shows a "Responding on another
device" indicator with the composer disabled until the response
finishes. The reply itself streams in over the regular sync
channel, so you'll see the assistant's message appear on the phone
just like any other update - you just can't *send* a competing
message from the second device while the first one is still
working.

The lock is per-conversation, not global. If your laptop is
producing a reply in thread A and you switch your phone to thread
B, the phone's composer is fully active there - only the
conversation that's currently being responded to is gated.

If the device producing the response crashes, loses its
connection, or you close its tab mid-reply, the other devices
detect the silence within about a minute and re-enable their
composer automatically. You can also start a fresh response on
another device once that timeout elapses - the new reply takes
over from where things were left.

## Where to go next

- [Search](./search.md) — find a specific thread.
- [The chat interface](./chat.md) — what happens inside a thread.

---
Back to the [index](./README.md).

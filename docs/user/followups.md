# Follow-ups

Nak can save itself a question to ask you later. Tell it you're
making lasagna on Saturday, and it notes "ask how the lasagna turned
out" - so the next time the recipe comes up, it knows the outcome is
still unknown and asks instead of assuming, and once Saturday has
passed it can bring the question up on its own at the start of a
conversation.

Follow-ups exist to fix a real failure: without them, Nak sometimes
remembered the *plan* from one conversation and quietly treated it
as *done* in the next. A follow-up marks the gap explicitly - "this
was planned; I don't know how it went."

## How follow-ups get created

Two paths, both automatic:

- **In the moment.** When you share a plan or an upcoming event that
  has a natural "how did it go?" horizon, Nak can save a follow-up
  right there in the conversation (you'll see the `followup_create`
  tool call in the reply). Saving requires the **followups** toolbox
  - Nak can switch it on itself, or you can enable it from the
  toolbox popover in the composer.
- **Afterwards.** The same background pass that writes long-term
  memories after a conversation settles also records unresolved
  plans it finds there, so a follow-up doesn't depend on Nak
  thinking of it mid-chat.

When a date is known ("the meeting is Thursday"), the follow-up
carries it, and only becomes ask-worthy after the date has passed.
With no date, Nak never brings it up on its own - it only surfaces
when you raise the topic.

## How they come back up

- **When you mention the topic**, the follow-up surfaces alongside
  Nak's memories of the plan, framed as unresolved - Nak answers
  your question and may ask how it went, but won't claim it
  happened.
- **After the date passes**, the question can come up at the start
  of a conversation even about something unrelated - a brief,
  natural aside, not an interrogation. At most a couple of pending
  questions are raised per conversation, the same question is not
  repeated in back-to-back conversations, and one that goes
  unanswered a few times (or ~a month past its date) quietly
  expires.

## Answering, postponing, dismissing

- **Answer it** (asked or unprompted - "made it, came out too
  salty") and Nak closes the follow-up and remembers the outcome the
  normal way, via [Memory](./memory.md).
- **Plans changed?** Say so ("we ate out - making it tomorrow") and
  Nak reschedules the same follow-up rather than closing it or
  creating a duplicate.
- **Don't want to be asked?** Say that too ("stop asking about the
  lasagna") and Nak dismisses it for good.

You can always ask "what were you going to ask me?" - Nak lists its
open follow-ups, and recently closed ones with what it learned.

## Seeing them

The **seedling pill** (the leaf icon at the bottom of the
bottom-right column in the chat view; the last tile in the
diagnostics menu on a narrow screen) opens a read-only inspector of
Nak's follow-ups: **Waiting to ask** (with when each will be raised -
"ready to ask", "asking after Jul 6", or "when it comes up"),
**Answered** (with the outcome you shared), and **Let go** (dropped
without an answer). The two closed groups are history and only show
their five most recent entries; a **"Show N more"** link under each
tells you how many are hidden and reveals the rest in place. **Waiting
to ask** is never collapsed. If you've turned on
[working intentions](./intents.md), those appear in the same
inspector, in their own section - both are notes Nak keeps to itself
about the future.

## Notes

- Follow-up surfacing rides the same machinery as
  [context recall](./settings.md); if you disable context recall in
  Settings, the proactive asks stop too.
- Follow-ups are questions, not memories. The durable outcome, once
  you share it, lands in [Memory](./memory.md) like anything else
  you tell Nak.

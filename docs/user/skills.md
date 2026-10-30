# Skills

A skill is a piece of reusable task guidance Nak keeps for you:
the format your weekly report should follow, the steps a monthly
checklist walks through, what "draft the release notes" means in
your world. Each skill is a short name, a one-to-two-sentence
description of when it applies, and a body of Markdown
instructions. Both you and Nak create and edit them, and Nak
follows them when a task matches.

Skills are one of three knowledge surfaces, and the split is
deliberate:

- **Memory** ([Memory](./memory.md)) - facts about you and your
  world. Nak recalls them as background context.
- **Custom prompts** (Settings -> Prompts) - always-on voice and
  persona shaping that ride every reply wholesale.
- **Skills** - working instructions, pulled in only when a task
  matches. A skill's description rides every message at the cost
  of a couple of sentences; the body loads only on a match, so it
  can carry real detail.

## How Nak uses skills

Every message you send, Nak quietly appends an index of your
skills to the request - one line per skill, name and description
only. Before starting a task it scans that list; when an entry
plausibly matches the work, it loads that skill's full body and
follows it. The index is capped at 50 entries, and a
4,000-character cap can cut it shorter; past either cap, an
overflow note points at the full list, and Nak can pull that
list through its tools when a task seems to call for something
the index didn't show.

There is no invoke button and nothing to enable - Nak decides
when a skill fits. If you want a specific one used, say so:
"use my release-notes skill" works, and so does simply describing
the task in the skill's terms.

## Nak maintains them for you

Nak does not wait for you to write skills:

- When you keep asking for the same kind of thing, or when it has
  just worked out guidance it will need again - a format, a
  procedure, a checklist - it captures it as a skill.
- It updates skills that proved wrong or stale, and deletes ones
  that no longer apply.
- It announces every create, update, and delete in its reply, so
  nothing changes silently.

You can drive the same changes from the conversation: "save a
skill called standup-report for writing my standup updates",
"add a step to my release-notes skill", "delete the
weekly-report skill". The persistent trail for all of this is a
**last edited by** stamp on every skill - you or Nak - shown in
the Skills tab. (There is no fuller per-change history.)

## The Skills tab

Click the **Skills** tab in the left drawer. The sidebar lists
your skills alphabetically with a search box on top; the list
loads more pages as you scroll, so a large collection never stops
at a fixed cap. Click a row and the main panel shows the name,
the description, the body rendered as Markdown, and the
last-edited stamp. With nothing selected, the panel shows the
same list plus a **New skill** button.

If the tab is open when Nak - or your other device - changes a
skill, the list and any open skill update on their own, with no
refresh. A skill that was deleted elsewhere closes back to the
list with a short notice.

### Searching

The search box filters the sidebar in place. It is plain text
matching over names, descriptions, and bodies - not the
meaning-based search Memory and the Wiki use. Clearing the box
returns the alphabetical listing.

Searching filters the sidebar only. A skill you have open stays
open even when its row falls out of the results, with a hint
explaining that the row is filtered out, not gone.

### Creating a skill

Click **New skill**. Three fields, each with a live character
counter that stops at its cap:

- **Name** (64 characters) - a short, slug-like handle such as
  `release-notes`. Unique per account, matched
  case-insensitively: creating a skill whose name differs only in
  case from an existing one is refused with a clear error.
- **Description** (300 characters) - one to two sentences on when
  to use the skill, like "how I draft release notes; use for any
  release-notes ask". This rides every message, so short beats
  clever.
- **Body** (32,000 characters) - the Markdown instructions,
  loaded only when a task matches. This is where the detail
  lives: procedures, formats, checklists, examples.

**Create** saves and opens the new skill.

### Editing and deleting

Open a skill and click **Edit**. The form swaps the rendered body
for a textarea and shows the same live counters; **Save**
persists and returns to the rendered view, **Cancel** drops the
draft.

**Delete** asks for confirmation inline. Deletes are hard - there
is no trash bin - so a mistaken delete means recreating the
skill, or asking Nak to reconstruct it from your conversations.

## What's stored and where

- **Location:** the `skills` table in your Supabase project.
  Every row carries your account id; Row-Level Security keeps
  accounts apart on a shared deployment.
- **Content:** the name, the description, the body, and who last
  edited the row. No conversation transcripts.
- **Backups:** whatever your Supabase project's own backups
  cover. Nak adds nothing on top.

## Limitations

- **The model mediates use.** There is no manual invoke control;
  ask in the conversation instead.
- **Text-only search.** Skill search matches literal text, not
  meaning.
- **No history.** The last-edited stamp is the whole edit trail;
  there is no per-change log like the Memory and Wiki changelogs.
- **No import, export, or sharing** between users.

## Where to go next

- [Memory](./memory.md) - the facts-about-you sibling surface.
- [Wiki](./wiki.md) - the encyclopedia about your world, the
  other store both you and Nak maintain.
- [The chat interface](./chat.md) - where Nak's skill loads show
  up as tool calls in the reply.

---
Back to the [index](./README.md).

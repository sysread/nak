# The chat interface

The main view — composer at the bottom, conversation above, drawer on
the left. This page covers what each piece does and the gestures that
aren't immediately obvious.

## The composer

### Mobile: the composer menu

On narrow screens the composer toolbar collapses behind a single
button — a 3x3 grid of dots sitting to the left of the textarea.
Tap it and a thin vertical column slides up, one icon per row:
attachments, prompts, toolbox, model, reasoning, verbosity. Tap
one to act on it (the column closes; the corresponding popover
takes over if the button has one). The send button stays in its
usual bottom-right spot.

The descriptions below for individual buttons apply the same way
whether they're in the desktop toolbar or the mobile column — the
behaviour is identical; only the layout differs.

### Attaching files

The paperclip button in the composer toolbar queues files for the
next message — click the paperclip, paste an image, or drag-drop
onto the composer. Full details in [Attachments](./attachments.md).

### Toolboxes

The **toolbox popover** sits in the composer toolbar, just after the
attach and prompts buttons.
Nak's capabilities beyond plain chat are grouped into named toolboxes
that you can enable per conversation:

- **Cooking** — save, read, and edit recipes in the Cookbook.
- **Memories** — search, create, update, and delete long-term
  memories about you.
- **Conversations** — search prior conversations for context.
- **Images** — generate a picture from a text description and attach
  it to the reply. See [Attachments](./attachments.md#generating-images).

Click the toolbox icon to open the popover and check off the
toolboxes you want active for this conversation. Each toolbox is
independent — turn on just Cooking if you're meal-planning; turn on
Memories + Conversations when you want Nak to reach into your
history.

The badge on the button counts how many toolboxes are currently on.
When a toolbox is off, its tools aren't on the wire — the model
can't accidentally write a recipe when you only asked for chat.
Reflex-level tools (memory recall, conversation recall, web search)
always ride along without needing a toolbox — you never have to
enable a toolbox just to get the model to look something up.

Nak can also flip toolboxes itself mid-conversation when it realises
it needs a capability. When that happens, the toolbox button briefly
pulses so you can see the change.

## Streaming responses

Replies stream token-by-token. Under the hood, Nak keeps the markdown
render hot — unfinished code fences, tables, and math resolve
themselves in place as more text arrives, so the view is always an
accurate preview of the finished answer.

### Reasoning ("thinking") panel

Reasoning-capable models stream a chain-of-thought trace **before**
the visible answer. Nak shows it as a block-quote-styled panel that
slides open at the top of the message bubble the moment the first
thinking token arrives, so you can watch the model think out loud.

A short thought stays open all the way through. Once the thinking
runs long, the panel tucks itself closed mid-stream (at a sentence
break) so a lengthy trace doesn't push the screen around — and it
always closes when the model switches to the visible answer. While
the thinking is still streaming, the collapsed "Reasoning" header
carries two small pills: a running timer and a live character count,
so you can see it's still working and how far along it is.

You can take over at any time: click the "Reasoning" header to
collapse or expand it yourself, even mid-stream. Your choice sticks
for the rest of that response — Nak won't auto-open or auto-close it
behind you once you've touched it.

After the fact, every message that has saved reasoning shows a
thought-balloon "Reasoning" header at the top of the bubble. Click
it to expand the block-quote back open — handy for reading *why* the
model answered a specific way without regenerating. The timer and
character-count pills stay on the message for as long as the
conversation is open, but they aren't saved with it — reopen the
thread fresh (or on another device) and the header shows without them.

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

The regenerate runs against your current settings - model profile,
reasoning effort, verbosity, active system prompts. So if you switch
to a different profile and then click regenerate on an older message,
the new response comes from the new model. Tool use (web search, etc.)
re-evaluates from scratch too; the new turn might fetch different
sources than the original.

If the regenerated turn fails partway (network drop, rate limit, you
hit Stop), the greyed messages restore to normal and nothing is
deleted. Try again, or carry on as if you hadn't clicked.

## Message timestamps

Every message card carries the time it was created at the left edge of
its action row, as a small `yyyy-mm-dd HH:mm` stamp (24-hour clock).
Assistant replies show it alongside the copy, sources, and regenerate
buttons; your own messages show it on their own row even when there's
nothing else there. The time is rendered in your display timezone -
the same setting the context-window detail row uses - which Nak
detects from your browser and you can override in Settings.

## Copying, editing, and deleting messages

Your own messages carry a trash button at the right edge of their
action row. Click it and Nak removes that message and **everything
after it** - the reply it prompted, any later turns you went on to
have, all of it - rolling the conversation back to exactly where it
stood before you sent that message. Hovering the button red-outlines
the range it will remove so you can see the blast radius before you
commit; a confirmation prompt guards the click.

This is the harder-edged sibling of regenerate. Regenerate rolls back
and immediately re-runs the model; delete-from-here rolls back and
stops, leaving you at a clean prompt to take the thread in a new
direction (or to delete the whole thread from the conversation list if
you removed everything). Unlike regenerate, a delete cannot be undone -
the removed messages are gone from the database, not just hidden.

To remove an entire conversation, use **Delete** in the thread list
rather than deleting from the first message.

## Stop and resume

While the model is generating a response, the send button turns
into a filled square. Click it (or use the same Enter shortcut that
normally sends - Ctrl+Enter on Windows/Linux, Command+Enter on
macOS) to stop the response where it is. Whatever the model had
already produced - partial reasoning, partial answer text, any
citations that arrived - is saved to the conversation with a
trailing `--- user interrupted response` marker so you can tell a
stopped reply from one that finished on its own.

The composer stays editable while the response streams, so you can
start drafting the next message without waiting for the stop click
to take effect. Pressing the stop button does not send whatever
you've typed - it just cancels the current response. After the
stop lands, the button returns to its normal send icon and your
draft is still there.

If the model was in the middle of running a tool when you stopped
(a web search, a memory lookup, and so on) the tool is cancelled
and its row in the conversation records the cancellation. Any
tools that had already finished in earlier rounds of the same
turn stay saved. You can continue the conversation as usual; the
partial reply and any tool results are part of the history the
next turn sees.

## Recovering an interrupted response

If a response is cut off in a way Nak can't predict (a tab close
mid-stream, a power loss, or any interruption that left a tool
result without its follow-up) you'll see one or more **recovery
messages** when you re-open the conversation:

- A short note like *(The previous response was interrupted before
  I finished. Picking up from here.)* appears in place of the
  missing reply.
- If a tool was mid-run, its row reads *(tool execution was
  interrupted - no result available)* so the conversation history
  stays consistent.

These messages stand in for what should have been there. Your
next message proceeds normally - the model sees the recovery
notes, knows what happened, and usually acknowledges or re-runs
the missing tool calls in its reply. The recovery messages are
saved into the thread on your next send so the conversation reads
the same way next time you open it.

Recovery messages can land mid-thread, not just at the end. If
you've ever sent a follow-up question on top of a conversation
where the prior tool turn didn't quite finish, the recovery rows
slot in between the broken turn and your follow-up so the rest of
the conversation reads coherently from there.

## The log drawer

The document-shaped button at the right end of the top bar opens
the **log drawer** on the right side of the screen. The button is
present on every section - Chats, Recipes, Memories, and Wiki -
so you can pop the drawer open without first switching back to a
chat. The drawer is a live feed of everything Nak writes to its
internal logs - service-worker updates, reflection / summary
agent progress, recall-agent breadcrumbs, and anything else a
background subsystem wants to tell you about. (Server-side work,
like embedding backfill and the curation agents, reaches the
drawer over a live relay - entries published while the app is
closed land only in your Supabase project's function logs.)

Useful when:

- A reply took an unusually long time and you want to see whether a
  background job was stuck.
- The "new version" banner behaves unexpectedly - every service-
  worker state transition lands in the drawer.
- You filed a bug and the maintainers asked for log context.

Controls inside the drawer:

- **Level dropdown** - choose the minimum severity to show (Trace+
  / Debug+ / Info+ / Warn+ / Error). The `+` means "this level and
  everything more severe", matching the filter behaviour of the
  browser devtools console. `Trace+` is the most permissive setting
  and surfaces the per-cycle breadcrumbs background jobs emit
  even when they have nothing to do; `Debug+` is the default and
  hides those routine pings while still showing every decision worth
  keeping visible. The drawer opens at whatever you've set as your
  **Default log level** in Settings > Appearance; changing the
  dropdown here is a within-session override that resets on the
  next open.
- **Source dropdown** - narrow the feed to a single subsystem tag
  (e.g. `reflection`, `summary`, `auto-title`). The list is
  built dynamically from the tags actually present in the current
  buffer, so it never offers options that would match nothing. Starts
  at **All sources**; the dropdown is greyed out until at least one
  entry with a source has landed. The level filter still applies on
  top, so picking a source tag and stepping the level down to `Trace+`
  is the fastest way to read one subsystem's per-cycle breadcrumbs in
  isolation.
- **Search box** - case-insensitive substring match against the
  source tag, the message, and any structured details attached to
  the entry. Whitespace splits the input into independent tokens, so
  `wiki write=true` searches for two needles, not one literal
  phrase. The **Any / All** dropdown next to the box decides whether
  an entry has to hit at least one token (Any, the default) or every
  token (All).
- **Clear** - drops the current buffer and resets the source filter
  back to **All sources**. The live feed continues to populate from
  the next log event onward.

Each entry shows the level, the local time it was captured, the
subsystem it came from (e.g. `[reflection]`), and the message.
When the message carried structured details - an error stack, a JSON
payload, a captured object - a caret appears at the left of the row;
click to expand / collapse the pretty-printed detail.

Every drawer entry is also written to the browser's devtools console
at the matching level, so if you are more comfortable filtering there
the drawer doesn't take anything away - it just adds an in-app view
that travels with the PWA install.

### Conversation mood

Click the **mood emoji** at the bottom-right of the conversation
pane (the persistent pill that updates when a samskara mints) to
open the **conversation mood** pop-up - where the current
conversation's latest read sits between warm and cool, confident
and tentative. The pop-up is the per-conversation view only;
everything corpus-wide (browsing every instinct, pipeline health,
the always-on summary) lives on the **Samskara tab** in the
conversation drawer - see [Samskara](./samskara.md).

The pill is visible whenever a conversation is open. On a thread
that has fired before, the pill seeds from the most recent stored
fire so the emoji you see right after opening matches the model's
last read. On a thread with no fire history it shows 💤 as a
"nothing to report" placeholder. As soon as a new samskara mints -
the forming happens on the server within a couple of turns of the
exchange that earned it, whether or not the tab stays open - the
emoji swaps to track that mint. On the brand-new-chat screen with
no conversation selected the pill is hidden - there's no context
yet to predict against.

The emoji is picked from a small two-axis table:

- **Valence** (warm vs. cool, in five bands) sets the row -
  cheerful, content, neutral, uneasy, or pensive.
- **Confidence** (how sure the model is) splits each row into a
  **confident** column and a **tentative** column. A tentative
  cheerful read shows up as a slight smile rather than a beaming
  one; a tentative neutral read shows up as 🤨 (skeptical) instead
  of 😐, and so on.

Hover the pill for the disambiguating label, or open the pop-up:
it holds a fold-away **legend** that plots all ten cells with
their valence ranges and the confidence cutoff, sourced directly
from the same lookup the pill uses (so the legend can never
drift), and overlays a small **glowing red dot** on the cell where
the pill currently sits. The line beneath the table reads out the
exact valence and confidence numbers that produced it.

Per-turn detail (which samskaras fired on a specific user message,
plus Nak's notes for that round) lives **inline in the chat
transcript**, not in this pop-up. See **Per-message diagnostics**
below.

### Per-message diagnostics

Every user message that triggered samskaras on its turn carries a
small **pulse-line icon** in its action row, mirroring the outline-
stroke buttons under each assistant message. Click it to expand a
panel anchored to that turn. The panel shows:

- A header pill marking the cohort as **confirmed**,
  **disconfirmed**, or **pending**, depending on how the next-day
  review judged the instincts that fired on this turn (pending means
  the conversation hasn't settled and been judged yet).
- The **substrate row** for the same round, lifted to the top of the
  panel with an accent stripe because it's Nak's after-the-
  fact summary of what actually happened on this turn ("user asked
  X about Y, expressing Z" / "the assistant did W and it landed P").
  Includes its lifecycle state (pending assimilation, assimilated
  but unembedded, or fully baked) and the round's valence reading.
- Below that, the **predictions that fired** for that turn, grouped
  by theme (paraphrase clusters collapse into a representative with
  a "+N similar" chevron). "Show all" bypasses the clustering and
  lists every fire individually. Each entry shows its tier, ranking
  score, valence, confidence, and health.

The icon only appears on messages that produced at least one fire
or substrate row, so cold-start messages and any turn Nak
couldn't predict against stay clean. Panels remember whether you
opened them for the duration of the open thread; switching to
another conversation collapses them all.

Closes via the ×, Escape, or clicking the backdrop.

## When the model asks you a clarifying question

If you ask something genuinely ambiguous - "what should I do about
the calendar thing?", "help me write that email", "explain quantum
mechanics" - the model can pause and ask you to clarify before
spending a long reply on the wrong reading. When that happens, a
small card appears inline in the conversation with the question and
2-4 buttons for the most likely answers, plus an **Other** button
that expands a textarea where you can type a free-form reply.

The conversation pauses until you respond. Pick one of the buttons
to send that answer back, or type into Other and hit Enter.

A few things to know:

- **You can ignore the question and just send a new message
  instead.** Typing into the main composer and hitting send treats
  the question as skipped - the model sees that you moved on and
  responds to your new message. The question card sticks around in
  the conversation history showing it was skipped.
- **Reloading the page skips the question.** A clarifying question
  that hasn't been answered when you close the tab or refresh the
  app is treated as skipped on next load. The card reappears in
  history with a "skipped on reload" tag. If you want to actually
  answer, send a new message that says what you would have picked.
- **OS notifications carry the question text.** If you have [reply
  notifications](#reply-notifications) on and the tab is
  backgrounded when a clarifying question lands, the notification's
  body is the question itself, so you can decide whether to switch
  back without first reopening the app. The question
  card in the message list is the durable signal regardless of
  whether the notification fires.
- **Answered questions stay in the transcript.** After you answer,
  the card dims and shows your reply below the question - the
  conversation reads cleanly on a re-scroll without losing the
  context of which option you picked.

The model is told to use clarifying questions sparingly, only when
the wrong reading would waste a long answer and the question has a
tight answer space. If you find Nak asking too often, that's a bug
to report.

## Reply notifications

If you switch to a different conversation while a reply is still
streaming, Nak keeps the reply running in the background - the
stream is tied to the app session, not the view. When you come
back, the completed message is already there, just without the
token-by-token playback you would have seen live.

To make that easier to notice, turn on **Notify me when replies
finish** in Settings > AI. When it's on, a completion that lands
in a thread you aren't currently viewing surfaces in one of two
ways, picked automatically:

- **The tab is visible but you're on a different thread.** A
  small dot appears next to the thread's row in the sidebar.
  Opening the thread clears the dot.
- **The tab is backgrounded, the PWA is minimized, or the screen
  is locked.** Nak fires a real OS notification - desktop
  notification on Windows/macOS/Linux, system notification on
  Android. Click it and the window focuses and jumps straight to
  the thread.

The first time you flip the toggle on, your browser asks whether
Nak can send notifications. Allow it and the feature is ready;
deny it and the toggle snaps back off (an in-app dot alone isn't
what the setting advertises, so we don't silently downgrade).
You can re-enable the permission later from your browser's site
settings and flip the toggle again.

A few platform quirks worth knowing:

- **iOS Safari in a tab has no Notification API at all.** You'll
  only get the in-app sidebar dot, never a system notification.
  [Install Nak to the home screen](./install-pwa.md) on iOS 16.4
  or later and the installed PWA can fire real notifications.
- **Multiple completions on the same thread collapse** into one
  OS notification - a second reply in a thread that already has
  an unfired notification replaces it rather than stacking a
  second popup. You'll still see one dot per thread in the
  sidebar.
- **Interrupted replies don't notify.** If you hit Stop on a
  reply, the partial text is saved but no notification fires -
  you already know the reply is done.
- **A thread you're actively watching never notifies itself.**
  "Actively watching" means the thread is selected AND the tab is
  visible - you can see the stream. If the tab is hidden (you
  switched to another app, locked the screen, minimized the window)
  Nak fires the OS notification regardless of which thread is
  selected, because you're not actually watching anything in that
  case. Replies in threads you navigated away from inside the app
  still get the sidebar dot whether the tab is hidden or not.
- **Browser-level permission doesn't sync across devices.** The
  setting itself is on your account, so flipping the toggle on
  one device leaves it checked everywhere. The OS-level "allow
  notifications" grant, though, is per-origin-per-browser - your
  desktop browser hasn't been asked just because your phone has.
  When the setting is on but this browser hasn't been granted
  permission yet, the Reply notifications section in Settings
  shows an "Enable notifications for this browser" button that
  asks for the grant on the spot.

Off by default because enabling it triggers the browser's
permission prompt, and prompting you for permissions without you
asking first would be rude.

## When the model is rate-limited

Venice occasionally returns a 429 "model overloaded" response when the
requested model is under heavy load. Nak silently retries the request
once after a short pause before surfacing anything to you, since the
overload window usually clears within a second or two and the second
attempt succeeds.

When the auto-retry also fails, the composer clears as usual, your
message stays in the conversation, and a banner appears above the
composer with the provider's explanation (e.g. "The model is currently
overloaded. Please try again later.").

Next to the banner is a refresh-arrow button — click it to re-send the
same request without retyping. Retries pick up any intermediate
tool-call results from the failed turn, so if the first attempt had
already completed a tool round before the rate-limit hit, the retry
resumes from there rather than starting over.

The in-session retry button lives only in memory - refreshing the page
or reopening Nak loses it. When that happens, if the failure left the
conversation with a completed tool round (e.g. a web search) but no
final reply, the thread opens with a muted "The response appears to
have been cut off. Click to retry." banner at the bottom of the
transcript. Its refresh-arrow button resumes the turn the same way
the in-session retry would: the existing tool results stay, and the
model picks up from them to produce the reply.

A turn where the model produced only its private reasoning and no
actual answer (a quirk of some models that occasionally "think"
without replying) is handled the same way: there's nothing to build
on, so clicking retry discards the empty response and generates a
fresh one in its place rather than stacking a second reply beneath it.

The same goes for a reply the stream cut off partway through - say a
network error mid-answer, or a failure while the model was still
thinking. Whatever the model managed to send - its reasoning, and any
answer text - stays on screen as a normal card with the error banner
beneath it, so you can read what arrived and work out *why* it failed
(a token limit, a malformed sequence, a network drop). Nothing is
dropped the moment the failure happens. Click retry and that partial
card is outlined in red while a fresh, complete answer streams in, then
it fades out and the new reply takes its place - the same red-outline
preview the regenerate button uses. (If the cutoff happened after a
tool round had already finished, those tool results are kept and the
new answer builds on them; only the half-finished reply is replaced.)

## Where to go next

- [Threads](./threads.md) — managing the conversation list.
- [Models & reasoning](./models.md) — picking a model per conversation.
- [Keyboard shortcuts](./shortcuts.md).

---
Back to the [index](./README.md).

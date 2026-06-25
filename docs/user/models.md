# Models & reasoning

Nak routes chat requests to Venice. The **AI** pane in Settings picks
the default model tier, the default reasoning effort, the default
verbosity, whether replies come back with bionic-style emphasis,
whether web-search is available to the model, and whether
search-grounded answers come back with inline `[1]` / `[2]` source
markers. The same pane is where you tell the model your name and
location, both of which ride along on every reply.

## About you

Optional identity fields injected into the system prompt on every
turn, so the model can address you naturally and ground location-
specific answers (weather, local time, regional context) without
asking back.

- Set them in Settings -> AI -> *About you*. Fill in **Name**,
  **Location**, both, or neither - each field saves on its own
  **Save** button.
- Both are free-form. Use whatever you want the model to call you
  ("Ada", "Dr. Lovelace", "ada/she/her") and however you want to
  describe where you are ("Lisbon", "Brooklyn, NY - mostly working
  East-coast hours", "currently roaming Asia"). The string is
  passed verbatim into the system prompt.
- Leave a field blank to skip it. Both blank means no profile block
  is sent at all and the per-turn prompt costs zero extra tokens.
- The values follow your account across browsers (stored in your
  Supabase profile next to the rest of your settings). They are
  never sent anywhere except to your chosen Venice model as part
  of the system prompt.
- The model is told to *use* the values, not recite them. You
  shouldn't see the assistant parroting your name back unprompted;
  it just has the context when it would otherwise have to ask.
- The wiki agent picks the same fields up, so new articles refer
  to you by name rather than as a generic "user" - see
  [Wiki](./wiki.md). Existing articles don't get rewritten
  retroactively; the change applies to articles the agent writes
  from here on.

## Model tiers

Nak gives you three model **tiers** - **Smart**, **Balanced**, and
**Fast** - rather than making you pick a raw model id every time. A tier
is a named slot: pick a tier for a conversation (or as your account
default) and Nak resolves it to whichever concrete Venice model that slot
points at. Threads store the tier, not the model, so re-pointing a tier
later doesn't strand your old conversations.

Out of the box the three tiers are tuned for a speed/capability spread,
but each slot is **configurable** in Settings -> AI -> *Models*:

- **Pick the model.** Each tier has a searchable picker populated live
  from Venice's model catalog. Click it and start typing to filter
  (fuzzy match, so "v4" finds "DeepSeek V4"); every row lays out the
  model name with its **capability icons** (reasoning, vision, tools)
  and right-aligned pills for **context window** and **input/output
  price**, so you can compare models at a glance before committing.
  Point Smart at a frontier model, Fast at a small quick one, whatever
  fits how you work. The selected model's same capability/context/price
  strip also shows on the tier row itself.
- **Set the reasoning effort.** Each tier carries its own default
  thinking level (see below), set from a second dropdown on the same row.
  This is what makes the tiers feel different even when they front
  similar models - Fast defaults thinking off for snappy replies, Smart
  leans into it.
- **Mark the account default.** The radio on each row picks which tier
  new threads start on. You can still override the tier per-conversation
  from the chat top bar.
- **Reset.** A tier you've customized shows a **Reset** link that drops
  your override and returns it to its built-in model and reasoning level.

Changes save the moment you make them - no Save button. If the model you
picked is later retired by Venice, the dropdown keeps showing it as your
current choice and the tier keeps working until you pick a replacement.

> Heads-up: Nak ships extra safety handling (the
> [glitch recovery](#automatic-glitch-recovery) re-roll) only for the
> models it has vetted. If you point a tier at a model Nak hasn't seen,
> the reasoning and vision controls still work from the catalog's
> capability flags, but that model-specific safety net doesn't extend to
> it.

## Reasoning effort

Reasoning models can spend hidden "thinking" tokens before they start
writing the reply. More thinking can help on hard problems; it also
adds latency. The composer's lightbulb picker (next to the verbosity
balloon) sets how much thinking the model does **for the current
conversation**:

- **Off** - no thinking pass at all. The model answers directly. This
  is the quickest option and the right one for routine turns.
- **Low** - a short thinking pass. The account-level default.
- **Medium** / **High** - progressively more deliberation before the
  reply, at the cost of more wait time.

Notes on how it behaves:

- The picker shows on every tier that uses a reasoning-capable model
  (all three of Smart, Balanced, and Fast do by default). Each tier
  starts at its configured default - out of the box **Smart** is
  *Medium*, **Balanced** *Low*, and **Fast** *Off*, and you can change a
  tier's default in Settings -> AI -> *Models* - and you can move any
  individual conversation up or down from there.
- Your pick is **per conversation** and sticky: it's saved on the
  thread, so it survives refreshes and follows you across devices.
- The row marked **default** is your account-level default (set in
  Settings -> AI -> *Default reasoning effort*). Re-selecting it
  clears the per-thread override, so a later change to your default
  flows through to the conversation automatically.
- Picking a level on a fresh conversation starts a draft so the choice
  has somewhere to live, the same way the model picker does.

## Verbosity

Verbosity suggests how long the model's answers should be. **Low**
biases toward short, direct replies; **medium** (the default) is
neutral; **high** invites expansive prose. It's orthogonal to
reasoning effort — verbosity controls *output* length, reasoning
controls how much hidden thinking happens before the reply.

- Pick your **default verbosity** in Settings → AI → *Default
  verbosity*. Every thread that hasn't overridden it uses this.
- Override **per thread** from the composer's speech-balloon
  picker (next to the reasoning picker). The choice is sticky — it's
  saved on the thread row in Supabase, so it survives refreshes
  and carries across devices.
- Providers that don't recognize `text.verbosity` silently ignore
  it; the field is always safe to send.

## Emphasis markdown

A bionic-style scan aid for long replies. When it's on, Nak asks
the model to sprinkle light Markdown emphasis through its
answers - **bold** on terms and identifiers you should fix on,
*italics* on short phrases and transitional clauses that orient
you - so long prose skims more easily.

- Flip it on in Settings -> AI -> *Emphasis markdown*. Off by
  default.
- The nudge is a short instruction added to every request while
  the toggle is on. The model decides where to place emphasis;
  Nak does not post-process the reply.
- Short replies (a sentence or two) stay unformatted - the
  instruction explicitly tells the model to skip emphasis when
  there's nothing to skim.
- Costs a handful of prompt tokens per turn. Nothing when the
  toggle is off.
- Strictly semantic. True "bionic reading" bolds the leading
  prefix of every word by word length; this feature picks
  meaningful words and phrases instead. If you want
  mechanical-prefix bionic, it would need to be a separate
  render-time transform, not a model instruction.

## Reply notifications

See [The chat interface](./chat.md#reply-notifications). The
toggle lives in the AI pane next to the Emphasis markdown one,
but the behaviour (OS notification or sidebar dot when a reply
lands in a thread you're not viewing) is chat-UX, so the full
write-up lives on the chat page.

## Per-thread overrides

## Web search

## Inline citations

When web search is active, Venice can interleave `[1]` / `[2]` source
markers into the answer body that link back to the pages it pulled.
Inline citations are enabled by default and are independent of the web-
search toggle itself - turning citations off still lets the model
ground its answer with live results, it just strips the markers so the
reply reads as plain prose.

- Pick the **default** in Settings → AI → *Inline citations*. Every
  new conversation starts with whatever you set here.
- Override **per conversation** from the composer's quote-marks
  button (visible whenever global web search is on). The choice is
  sticky - it's saved on the thread row in Supabase so it survives
  refreshes and carries across devices. Toggling back to the default
  clears the per-thread override so a later change to the default
  propagates automatically.
- The setting only does anything when web search is active for the
  turn. Citations without a search are sourceless, so Venice ignores
  the flag in that case.

## System prompts

A system prompt is a standing instruction the model sees before your
message - "be concise," "answer in British English," "you are a
patient tutor." Nak lets you keep a library of named prompts and
toggle them on or off per conversation.

- Manage them in Settings -> **Custom prompts**. Each prompt is a
  card with a **Name**, a **Default** checkbox, and the prompt
  **body**.
- The **Default** checkbox seeds the active set for *new*
  conversations. Leave it off for prompts you only want occasionally.
- Per-conversation toggles live in the chat composer (the same place
  you pick a model). Flipping a prompt on or off there only affects
  the current thread - it is not saved back as a default.
- Changes save automatically as you type; there is no Save button.
- **Reorder** the library by dragging the grip handle on the left
  edge of a card. The order you set is the order the toggles appear
  in the composer, so put the ones you reach for most at the top.
  (Reordering is drag-only and works with a mouse or trackpad.)

## Automatic glitch recovery

Some models occasionally emit an internal control token (and a burst
of unrelated text) at the very start of a reply instead of answering -
a known quirk of the DeepSeek family that fronts the Balanced and Fast
tiers. Nak detects this, throws the bad attempt away, and regenerates -
automatically, without you doing anything.

- When it happens you'll briefly see a small **"oops, all slop!"**
  notice card where the answer would be, while the real reply streams
  in below it. The notice then powers off (a little CRT-style collapse
  animation) and disappears once the good reply lands.
- Nak re-rolls up to twice, nudging the sampling temperature each time
  so the retry doesn't reproduce the same glitch. If all attempts still
  come back malformed, you'll get an error with a **Retry** button -
  sending again almost always clears it, since the glitch is random.
- This only kicks in for models known to have the quirk; everything
  else streams through untouched.

## Where to go next

- [Settings overview](./settings.md) — the pane this lives in.
- [The chat interface](./chat.md) — where the choices take effect.

---
Back to the [index](./README.md).

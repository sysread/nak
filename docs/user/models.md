# Models & reasoning

Nak routes chat requests to Venice. The **AI** pane in Settings picks
the default model tier, the default reasoning effort, the default
verbosity, whether replies come back with bionic-style emphasis,
whether web-search is available to the model, and whether
search-grounded answers come back with inline `[1]` / `[2]` source
markers.

## Model tiers

## Reasoning effort

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

## Where to go next

- [Settings overview](./settings.md) — the pane this lives in.
- [The chat interface](./chat.md) — where the choices take effect.

---
Back to the [index](./README.md).

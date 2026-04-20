# Models & reasoning

Nak routes chat requests to Venice. The **AI** pane in Settings picks
the default model tier, the default reasoning effort, the default
verbosity, and whether web-search is available to the model.

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

## Per-thread overrides

## Web search

## System prompts

## Where to go next

- [Settings overview](./settings.md) — the pane this lives in.
- [The chat interface](./chat.md) — where the choices take effect.

---
Back to the [index](./README.md).

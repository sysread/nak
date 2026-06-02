# Components

Reusable Svelte 5 components under `src/components/`. Every one uses
runes (`$props`, `$state`, `$effect`) rather than Svelte 4 stores.
Screens (`src/screens/*.svelte`) compose these; no component here
imports from another screen.

Components are the *composition* layer: they wire pure UI-behavior
primitives from `src/lib/ui/` to framework-native reactivity, bind
to DOM events, and render markup. The decision logic those
primitives encode (option lists, selection mutators, display-label
transforms, domain sentinels) does not live in the `.svelte` file -
see [`./frontend-organization.md`](./frontend-organization.md) for
the criteria and a worked example.

## `<Markdown>`

File: `src/components/Markdown.svelte`.

Renders sanitized markdown into HTML via
`src/lib/markdown.ts`'s `renderMarkdown`. The pipeline is `marked` →
custom renderer (code fences, image stubs) → `DOMPurify` with an
element/attribute allowlist. KaTeX is wired as a marked extension,
so `$inline$` / `$$block$$` math renders inline.

```ts
interface Props { content: string; }
```

- Re-renders on every `content` change and on every late-arriving
  highlight.js grammar, via an `$effect` that subscribes to
  `onLanguageLoaded`. A code fence that lacked its grammar on the
  first pass gets real token spans once the dynamic import
  resolves.
- Emits fenced code blocks wrapped in a `<div class="code-block">`
  with a `<button class="copy-code-btn">`. A delegated click handler
  inside the component owns clipboard interaction and the
  copy-then-check-flash UX. DOMPurify's allowlist excludes SVG, so
  the copy/check icons are injected client-side from static
  strings after each render (safe because they're not model-
  influenced).
- DOMPurify adds `target="_blank" rel="noopener noreferrer
  nofollow"` to every `<a>` via an `afterSanitizeAttributes` hook.
  Consumers that want to intercept certain clicks (see
  `./help.md`) do so with `preventDefault` in a wrapping click
  handler.

Consumers: `Chat.svelte` (user + assistant messages), `Help.svelte`
(rendered docs), `ToolCalls.svelte` (tool-call detail panel - the
generic JSON-as-markdown formatter is in `src/lib/ui/tool-format.ts`,
with per-tool overrides as optional `formatArgs` / `formatResult`
schema fields on `ToolDef`).

## `<Scanner>`

File: `src/components/Scanner.svelte`.

K.I.T.T.-style five-dot left-to-right-and-back pulse. Used anywhere
the app is waiting and has no meaningful progress signal yet — the
composer's pre-first-token gap, the conversation-search round-trip,
the Help modal's inter-doc transition.

```ts
interface Props {
  label?: string;    // aria-label (default: 'Loading')
  size?: number;     // em multiplier (default: 1)
}
```

CSS animations are defined in `src/styles.css`. The `--scanner-scale`
custom property makes the scale prop work without inline keyframes.

Consumers: `Chat.svelte` (several spots), `Help.svelte` (doc
transitions), archive loading sentinel in the drawer.

## `<ContextRing>`

File: `src/components/ContextRing.svelte`.

Per-message context-window indicator. A 14px SVG ring that fills
proportional to `totalTokens / contextWindow`, with a hue ramp from
green (0%) through yellow (50%) to red (100%). Clicking the ring
slides a detail row open beneath the message's action bar showing a
summary of context-window usage and the wall-clock time the row was
received; clicking again (or Escape) slides it closed. Desktop hover
also exposes the same summary as a native `title` tooltip.

```ts
interface Props {
  totalTokens: number;
  contextWindow: number;
  createdAt?: string | null;
}
```

- Renders nothing when either token prop is missing. The data comes
  from the `messages.usage` JSONB column (sourced from Venice's
  `usage` epilogue frame) and the model's `contextWindow` in
  `src/lib/models.ts`; both are missing for very old assistant
  rows and for turns where usage wasn't reported.
- `createdAt` is the assistant row's `messages.created_at`. Formatted
  via `Intl.DateTimeFormat` with `dateStyle: 'medium'` + `timeStyle:
  'short'` and the user's `app.journalTimezone` (seeded from
  `detectTimezone()` so it always has a value, then overwritten from
  `profiles.settings.journalTimezone` on unlock). Rendered as a muted
  "Received <timestamp>" line beneath the usage headline, and folded
  into the hover/aria summary so the timestamp is also reachable
  without expanding. A bad zone string falls back to the browser
  default rather than blanking the line.
- The reveal mechanism is a Svelte `{#if open}` block with a
  `slide` transition from `svelte/transition`. Parent message-card
  layout uses `flex-wrap: wrap` and the detail row is
  `flex-basis: 100%`, so the row drops to its own line inside the
  bubble rather than floating on top.
- Decision logic (the clamp + hue ramp + color string, the usage
  summary, the timezone-aware timestamp formatter with bad-zone
  fallback, the bullet-joined tooltip) lives in
  `src/lib/ui/context-ring.ts` and is unit-tested directly in
  `tests/context-ring.test.ts` alongside the component-mount
  cases. The `.svelte` file owns the SVG geometry, the `open`
  rune, and the Escape `$effect`.

Consumers: message action bar in `Chat.svelte`.

## `<ReasoningPicker>`

File: `src/components/ReasoningPicker.svelte`.

Composer-bar twin of the model tier picker. Renders a trigger
button + a popover menu of `THINKING_LEVELS` (off / low / medium /
high) from `src/lib/models.ts`. `off` maps to
`venice_parameters.disable_thinking` rather than a `reasoning_effort`
value; the other three map to `reasoning_effort`. Controlled — the
parent owns open/closed state so it can coordinate with sibling
popovers (model picker, prompt picker) and enforce "only one menu
open at a time."

`value` is a `ThinkingLevel` (may be `off`); `defaultEffort` is the
account-level `ReasoningEffort` shown with the `default` badge, which
therefore never lands on the Off row.

```ts
interface Props {
  value: ThinkingLevel;
  defaultEffort: ReasoningEffort;
  open: boolean;
  onToggle: () => void;
  onSelect: (level: ThinkingLevel) => void;
}
```

The emitted DOM uses `.model-picker-btn` on the trigger and
`.composer-menu .menu-item-btn` on the rows, matching the existing
composer CSS so the picker slots in next to the model picker
without a style pass.

Consumers: composer row in `Chat.svelte`.

## `<AssistantBody>`

File: `src/components/AssistantBody.svelte`.

Assistant message body — everything inside an `.msg.assistant`
bubble EXCEPT the in-progress streaming branch (which lives in
`Chat.svelte` because it wires live state). Renders the
markdown content, the reasoning panel above and the citations
panel below, and the action bar (copy, citations toggle,
context ring, regenerate).

Decision logic (the `^N^` citation-ref detector, the
orphan-refs `citationsUnavailable` predicate, the
controls-visibility gate, the `#cite-N` href parser, the
flash delay matching the slide-down) lives in
`src/lib/ui/assistant-body.ts` and is unit-tested at
`tests/assistant-body.test.ts`. The `.svelte` file owns
`citationsOpen` / `flashCite` runes, the body-click delegation,
and the markup.

Consumers: assistant turns in `Chat.svelte` (both the plain
content branch and the tool-group branch that slots
`<ToolCalls>` between body and actions via the `children`
snippet).

## `<ToolCalls>`

File: `src/components/ToolCalls.svelte`.

Collapsible tool-call log rendered inside an assistant bubble
when that turn invoked tools. One row per call: status glyph,
tool name, plus a duration or live-ticker pill. Clicking a row
expands into a detail panel with the arguments and result.

The detail panel renders in one of two views, per-call:

- **markdown** (default) - the readable shape produced by
  `src/lib/ui/tool-format.ts`'s generic JSON-as-markdown
  formatter, or by a per-tool override declared on the tool's
  schema (see `formatArgs` / `formatResult` on `ToolDef`).
  Long fields wrap, identifiers render as inline code, URLs
  linkify, and nested objects/array elements get bracket-path
  section headers. `recipe_save` ships an override that
  surfaces the cooklang source as a labelled fenced block
  below the metadata; new tools can opt in the same way when
  the generic shape doesn't read well for their payload.
- **json** - the raw pretty-printed wire shape inside a `json`
  fence (the historical look). Reachable via the "view: json"
  toggle at the top right of the detail panel. The override
  is ignored in this view; what you see is exactly what the
  model sent or received.

The toggle is per-call - one card can sit in JSON while
another sits in markdown.

```ts
interface Props {
  calls: OpenAIToolCall[];
  resultsByCallId: Record<string, Message>;  // role='tool' rows keyed by tool_call_id
  timings?: Record<string, CallTiming>;      // in-memory, per-session
}
```

Status sources:

- **In-session calls** have a `timings` entry (startedAt, endedAt,
  error flag). That's where the live duration ticker comes from.
- **Replayed history** (opened a prior conversation) has no timings;
  rows are read-only. Success/failure falls back to parsing the
  result content — a JSON payload with an `error` key renders as
  failure; invalid/non-JSON payloads are treated as success.

Timings are not persisted (in-memory, owned by `Chat.svelte`).
Reopening a conversation shows completed rows with status glyph
only, no duration pill — historical latency wasn't worth the
storage cost.

Decision logic (the 4-source status tree, the live-vs-final
duration pill, the args/result renderers that resolve view
mode + per-tool formatter overrides, the activity-narration
extractor that tolerates partial streaming JSON) lives in
`src/lib/ui/tool-calls.ts` and is unit-tested at
`tests/tool-calls.test.ts`. The generic JSON-as-markdown
formatter that powers the default "markdown" view lives in
`src/lib/ui/tool-format.ts` (unit tests at
`tests/tool-format.test.ts`). The `.svelte` file owns the
per-call `expanded` and `viewMode` runes and the markup.

Consumers: assistant bubble in `Chat.svelte`.

## `<CopyButton>`

File: `src/components/CopyButton.svelte`.

Tiny copy-to-clipboard affordance used for assistant-message copies
and anywhere a Svelte-side string needs a one-click "put this on
the clipboard" control. Label flips to "Copied!" and the button
gets a `.copied` modifier for ~1.5s.

```ts
interface Props {
  text: string;
  label?: string;     // default: 'Copy'
  ariaLabel?: string;
}
```

Clipboard failures (permission denied, insecure context) are
swallowed silently — the absence of the "Copied!" flash is itself
the signal.

Not used for code-fence copies inside rendered markdown: those go
through a delegated DOM handler in `<Markdown>` because Svelte
doesn't mount child components inside `{@html}` output. The two
paths are intentionally parallel; see the comments in
`src/components/Markdown.svelte` and `src/lib/markdown.ts`'s
`renderer.code` for why.

Consumers: assistant message action bar in `Chat.svelte`.

## `<SecretInput>`

File: `src/components/SecretInput.svelte`.

Password-style input with an eye-icon reveal toggle. Used for the
master password and for the three long API keys in Setup /
Settings. Bindable value; toggle flips input type between
`password` and `text`.

```ts
interface Props {
  id: string;
  value: string;           // bindable
  required?: boolean;
  minlength?: number;
  placeholder?: string;
  autocomplete?: AutoFill; // default: 'off'
}
```

Autocomplete defaults to `'off'` so browsers don't try to autofill
the Supabase publishable key into a credit-card form somewhere. Master-
password callers override with `'current-password'` /
`'new-password'` so password managers and Chrome devtools see the
hint and stop warning about a missing attribute.

Consumers: `Setup.svelte`, `Unlock.svelte`, `EditConfig.svelte`,
`Settings.svelte` (keys pane, security pane).

## `<UpdateBanner>`

File: `src/components/UpdateBanner.svelte`.

Top-right "new version available — Reload" pill. Renders only when
`updateState.available` from `$lib/update.svelte` is true, so the
banner has zero visual footprint until the service worker reports
a waiting build.

No props. Mounted once in `App.svelte` outside the phase switch so
the banner appears across every phase (setup / locked / unlocked /
edit-config). The Reload button calls `applyUpdate()`, which posts
`SKIP_WAITING` to the waiting SW and reloads.

See `./build-deploy.md` for the update-detection pipeline and
`./settings.md` for the matching About pane.

Consumers: `App.svelte`.

## Component-level conventions

- **Runes everywhere.** `$props()` destructures at the top; bindable
  props use `$bindable()` with a default value.
- **Controlled popovers.** Anything that opens a menu (picker, ring
  reveal) takes its open/closed state as a prop so the parent can
  ensure only one is open.
- **SVG inline, not separate icon system.** Each icon is an inline
  `<svg>` matched to the surrounding stroke/size conventions. No
  icon library.
- **Styles global.** Components do not ship `<style>` blocks; CSS
  lives in `src/styles.css` under feature-scoped selector prefixes
  (`.md`, `.scanner`, `.context-ring`, `.reasoning-picker`,
  `.tool-calls`, etc.). Keeps the tree small and makes theme
  tokens (`var(--accent)`, etc.) consistently available.

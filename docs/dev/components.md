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

## `<AsciiSpinner>`

File: `src/components/AsciiSpinner.svelte`.

Classic terminal bar spinner - cycles `- \ | /` on a 100ms
`setInterval`. Takes no props. Frame sequence, cadence, and the
reduced-motion fallback glyph live in `src/lib/ui/ascii-spinner.ts`;
the component is the timer plus a `$state` counter.

Picked over `<Scanner>` where the surface is a single character cell
in a text row rather than a standalone waiting affordance, and over
the `transform: rotate()` treatment the chat tool rows apply to their
U+21BB glyph (`.tool-status.status-pending` in `styles.css`) because
a rotating glyph that small reads as a shimmer - swapping the glyph
outright changes the shape, which the eye catches at any size.

Two contracts callers must honour:

- **Keep it inside an `aria-hidden` container.** Both current call
  sites are in `aria-live="polite"` regions; an unhidden spinner
  would announce its frame sequence ten times a second.
- **Give it a fixed-width cell** if a label sits beside it. The
  component pins `--font-mono` and `width: 1ch` so the frames hold
  their column, but a caller that lets the cell size to content will
  still shift on frames with different side bearings in a
  non-Lekton fallback font.

Under `prefers-reduced-motion: reduce` (sampled once at mount) it
renders a static ellipsis instead of starting the timer.

Consumers: `Memories.svelte` and `Wiki.svelte` - in each, the pending
row of the librarian run's step list plus the "running in the
background" notice shown when the in-flight lease is held by a run
this strip didn't start. See [`./memory.md`](./memory.md) and
[`./wiki.md`](./wiki.md).

Deliberately NOT applied to the chat tool-call rows
(`.tool-status.status-pending`), which keep their rotating glyph. That
indicator appears on every tool call in every conversation, so
changing it is a change to the app's overall texture rather than a
fix to one strip - it wants its own decision.

## `<ModelCombobox>`

File: `src/components/ModelCombobox.svelte`.

Search-and-select combobox for the per-profile model picker in
Settings -> Model profiles, replacing the native `<select>` (which
can't render the per-row capability badges, context-window pill, and
input/output price pill, nor type-to-filter). Each row aligns the
model name left, capability badges centered, and the context + price
pills right; CSS **subgrid** keeps those columns aligned across every
row. A fuzzy search box filters the list as the user types.

```ts
interface Props {
  options: ModelOption[];   // from profileRowView.options
  value: string;            // selected model id
  disabled?: boolean;
  ariaLabel: string;        // e.g. "Model for Everyday"
  onSelect: (id: string) => void;
}
```

- ARIA is the "combobox with external listbox" pattern: the search
  `<input role="combobox">` owns `aria-activedescendant`, the `<ul
  role="listbox">` holds `role="option"` rows. Arrow keys move the
  highlight, Enter selects it, Escape closes; the rows are pointer
  targets (hover sets the highlight). Open-from-trigger highlights the
  current selection so Enter-on-open re-picks it.
- Conventions mirror `TopicsFilter.svelte`: `open` state, button +
  popover binds, a document-level click-outside listener, and
  component-scoped styles. The popover widens past the trigger
  (`width: max-content`, capped) to fit the four columns.
- Decision logic - the fuzzy matcher (`fuzzyMatch`), the filter/rank
  (`filterModelOptions`), and the per-row data (`capabilityChips`,
  `formatContextWindow`, `formatPricing`) - lives in
  `src/lib/ui/model-picker.ts` and is unit-tested in
  `tests/model-picker.test.ts`. The `.svelte` file owns only the
  keyboard model, the open/close glue, and the markup.
- An off-catalog "current" option (a model no longer in the live
  catalog) renders name-only - no badges or pills, since the snapshot
  doesn't carry catalog capability/pricing data.

Consumer: `Settings.svelte` (one per card in the Model profiles pane).

## `<ImageModelSelect>`

File: `src/components/ImageModelSelect.svelte`.

Custom button + popover listbox for the **Image generation** picker in
Settings -> AI, replacing a native `<select>` (which can't render the
per-row price pill). Each row left-aligns the model name with any
beta/retiring tags and right-aligns the per-image price in a pill; CSS
**subgrid** keeps the pills sharing one right edge across rows. The
trigger shows the selected model's name + price the same way.

```ts
interface Props {
  options: ImageModelOption[];  // from buildImageModelOptions
  value: string;               // selected model id
  disabled?: boolean;
  ariaLabel: string;
  onSelect: (id: string) => void;
}
```

- Stripped-down sibling of `<ModelCombobox>`: **no** fuzzy-search input
  (image models are few), so the keyboard model lives on the focusable
  `<ul role="listbox" tabindex="-1">` itself rather than a search
  `<input>`. Arrow/Home/End move the highlight (mirrored to
  `aria-activedescendant`), Enter/Space selects, Escape closes (and
  `stopPropagation` so it doesn't bubble to Settings' modal-close
  handler); rows are pointer targets that set the highlight on hover.
- Decision logic - the structured option rows (`buildImageModelOptions`,
  `imageModelOption`) and the price label (`formatImagePrice`) - lives in
  `src/lib/ui/image-model-picker.ts`, unit-tested in
  `tests/image-model-picker.test.ts`. The `.svelte` file owns only the
  keyboard model, open/close glue, and markup.
- The synthetic off-catalog "current" option renders name + a `current`
  badge, pill collapsed (no catalog price to show).

Consumer: `Settings.svelte` (Image generation subsection).

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

- Renders nothing when either token prop is missing. `totalTokens`
  comes from the `messages.usage` JSONB column (sourced from Venice's
  `usage` epilogue frame; absent on turns where usage wasn't
  reported). `contextWindow` is the thread's CURRENT profile's
  window, passed in by `AssistantBody` from the resolved
  `ModelProfile` - not
  a lookup on the row's historical `messages.model`. So an old row is
  measured against the model the user is on now (the window they have
  to manage); a turn larger than today's window fills the ring and the
  detail shows raw counts over the window. There is no retired-model
  registry.
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

Composer-bar twin of the model-profile picker. Renders a trigger
button + a popover menu of `THINKING_LEVELS` (off / low / medium /
high) from `src/lib/models/index.ts`. `off` maps to
`venice_parameters.disable_thinking` rather than a `reasoning_effort`
value; the other three map to `reasoning_effort`. Controlled — the
parent owns open/closed state so it can coordinate with sibling
popovers (model picker, prompt picker) and enforce "only one menu
open at a time."

`value` is a `ThinkingLevel` (may be `off`); `defaultLevel` is the
active model profile's default level shown with the `default` badge -
also a `ThinkingLevel`, so the badge can land on the Off row when the
profile ships with thinking disabled.

```ts
interface Props {
  value: ThinkingLevel;
  defaultLevel: ThinkingLevel;
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

## `<GeneratedImageCard>`

File: `src/components/GeneratedImageCard.svelte`.

The dedicated card for a `generate_image` tool's output, rendered as
its own `.msg.assistant` bubble directly below the tool-group card
that produced it (`Chat.svelte`'s `generated-image` message block).

```ts
interface Props {
  threadId: string | null;  // thread to resolve the image within
  filename: string;         // the orchestrator-minted filename (resolution key)
  aspectRatio: string;      // CSS aspect-ratio for the placeholder box
}
```

- Resolves the image itself, by filename, via
  `findImageByFilenameInThread` in an effect, then delegates the render
  to `<MessageAttachments>` so the preview / download-anchor /
  expired-chip treatment matches every other attachment. While the
  attachment is unresolved it shows a `<Scanner>` placeholder sized to
  `aspectRatio` so the card holds its space and doesn't reflow when the
  bytes land.
- Why by-filename instead of reading the assistant row's `attachments`:
  generate_image attaches its output server-side, per round, AFTER the
  assistant row was inserted and echoed over realtime, and the
  `message_attachments` insert fires no `messages` event. The in-memory
  row never re-hydrates, so before this card the image only appeared
  after a full reload. See [`./attachments.md`](./attachments.md).
- A short bounded retry (`RETRY_DELAYS_MS`) covers the rare case where
  the card mounts before the server-side attach has committed; a
  replayed thread resolves on the first attempt and never retries.
- Decision logic (which calls get a card, the descriptor parse, the
  aspect-ratio string) lives in `src/lib/ui/generated-image.ts`,
  unit-tested at `tests/generated-image.test.ts`. The `.svelte` file
  owns only the resolution effect and the placeholder markup.

Consumer: `generated-image` block in `Chat.svelte`.

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
Supabase publishable key in Setup / the Keys pane and for the
account-password fields on the Auth screen and Security pane.
Bindable value; toggle flips input type between
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
the Supabase publishable key into a credit-card form somewhere.
Account-password callers override with `'current-password'` /
`'new-password'` so password managers and Chrome devtools see the
hint and stop warning about a missing attribute.

Consumers: `Setup.svelte` (publishable key) and `Settings.svelte`
(keys pane publishable key, security pane account-password fields).

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

## `<MessageAttachments>`

File: `src/components/MessageAttachments.svelte`.

Renders per-message file attachment previews: image thumbnails,
file-type icons, download anchors, and expired-state chips.
Delegates rendering to pure helpers in `src/lib/ui/attachments.ts`.

Consumers: `Chat.svelte` (user + assistant message bubbles),
`GeneratedImageCard.svelte`.

## `<CitationsPanel>`

File: `src/components/CitationsPanel.svelte`.

Slide-down panel inside an assistant bubble showing web-search or
context-recall citations with `^N^` anchor links. Clicking a
citation opens the source. Decision logic lives in
`src/lib/ui/citations.ts`.

Consumers: `AssistantBody.svelte`.

## `<ReasoningPanel>`

File: `src/components/ReasoningPanel.svelte`.

Collapsible per-message reasoning/thinking panel rendered above the
assistant body. Shows elapsed-ms and char-count pills during
streaming; freezes on hand-off to the persisted card. Auto-collapse
logic lives in `src/lib/ui/reasoning-panel.ts`.

Consumers: `Chat.svelte` (streaming + persisted assistant bubbles).

## `<VerbosityPicker>`

File: `src/components/VerbosityPicker.svelte`.

Composer-bar twin of the reasoning picker. Renders a trigger
button + a popover menu of verbosity levels from
`src/lib/ui/verbosity.ts`. Takes an optional `disabled` prop:
unlike ReasoningPicker (hidden outright for non-reasoning models)
the control stays visible and disables, with an explanatory
tooltip, when the model's backend is recorded as rejecting the
`text.verbosity` wire knob - Chat derives the flag from
`verbosityRejectedForModel(app.modelFeatureRejections, ...)`, the
same signal that disables the Settings profile card's verbosity
dropdown. When disabled while the menu is open, the menu closes
itself (the dead trigger can no longer close it).

Consumers: composer row in `Chat.svelte`.

## `<AskUserCard>`

File: `src/components/AskUserCard.svelte`.

In-chat question card surfaced when the function-side round
suspends on an `ask_user` tool call. Renders the question,
available options, and fires the answer envelope on selection.

Consumers: `Chat.svelte` (in the message list while a question is
pending).

## `<SecondThoughtsPanel>`

File: `src/components/SecondThoughtsPanel.svelte`.

Slide-down panel under an assistant message showing the model's
self-review and any refinement iterations. Gated on
`SecondThoughtsSlot` state.

Consumers: `AssistantBody.svelte`.

## `<ArtifactsList>`

File: `src/components/ArtifactsList.svelte`.

List of code artifacts generated by the model, rendered in a
structured card below the assistant body.

Consumers: `Chat.svelte`.

## `<OfflineBanner>`

File: `src/components/OfflineBanner.svelte`.

Persistent top-of-screen banner indicating the app is offline
and serving cached content. Renders only when the offline-cache
store reports disconnected state.

Consumers: `App.svelte`.

## `<BucketHeader>`

File: `src/components/BucketHeader.svelte`.

Header row for a grouped bucket of items in a drawer tab list
(e.g. "Favorites", "Upcoming").

Consumers: drawer tab lists in `Chat.svelte`.

## `<TopBarActions>`

File: `src/components/TopBarActions.svelte`.

Per-section action cluster in the top bar (new conversation +
digest on Chats; changelog / librarian / sweeps on the other
tabs). Renders a merged icon-button group on desktop and
collapses into a single overflow ("...") menu at the 720px
mobile breakpoint. An action marked `pinned: true` stays out
of the mobile collapse as its own always-visible button
(used for the chats tab's new-conversation action).

Consumers: `Chat.svelte`.

## `<TopicsFilter>`

File: `src/components/TopicsFilter.svelte`.

Search-and-select filter dropdown for the drawer's topic
vocabulary. Allows filtering thread/memory/recipe lists by one
or more topics.

Consumers: drawer header in `Chat.svelte`.

## `<DiagnosticPills>`

File: `src/components/DiagnosticPills.svelte`.

Bottom-right glance column (and mobile drop-up twin) of
diagnostic status pills: recall, intuition, bias, samskara
mood, intents. One registry (`src/lib/ui/diagnostic-pills.ts`)
drives both surfaces.

Consumers: `Chat.svelte`.

## `<RecallEntry>`

File: `src/components/RecallEntry.svelte`.

Single recall entry in the Recall diagnostics modal. Renders
the injected note with clickable `^N^` citation links.

Consumers: `Recall.svelte` screen.

## `<ExtractedTextDrawer>`

File: `src/components/ExtractedTextDrawer.svelte`.

Right-edge slide-out drawer showing the parsed text content of
a chat attachment, for long documents the model references.

Consumers: `Chat.svelte`.

## `<LogsDrawer>`

File: `src/components/LogsDrawer.svelte`.

Right-edge slide-out drawer of diagnostic breadcrumb logs,
fed by the edge-to-main log relay. Renders entries from
`app.logs`.

Consumers: `Chat.svelte`.

## `<LibraryList>`

File: `src/components/LibraryList.svelte`.

Library drawer tab: lists uploaded documents with search,
status chips, and per-document actions.

Consumers: drawer tabs in `Chat.svelte`.

## `<MemoryList>`

File: `src/components/MemoryList.svelte`.

Memories drawer tab: lists memory rows with search, topic
filter, and per-memory actions.

Consumers: drawer tabs in `Chat.svelte`.

## `<MemoryChangelogPanel>`

File: `src/components/MemoryChangelogPanel.svelte`.

Slide-down panel for a memory row showing its revision history
and changelog entries.

Consumers: `MemoryList.svelte`.

## `<WikiList>`

File: `src/components/WikiList.svelte`.

Wiki drawer tab: lists wiki articles with search, status chips,
and per-article actions.

Consumers: drawer tabs in `Chat.svelte`.

## `<WikiRecords>`

File: `src/components/WikiRecords.svelte`.

Detail view of wiki article records: the article body, metadata,
and revision history.

Consumers: `WikiList.svelte`.

## `<WikiChangelogPanel>`

File: `src/components/WikiChangelogPanel.svelte`.

Slide-down panel for a wiki article showing its revision history
and changelog entries.

Consumers: `WikiRecords.svelte`.

## `<WikiSkippedPanel>`

File: `src/components/WikiSkippedPanel.svelte`.

Panel showing wiki articles that were skipped during the
autonomous wiki agent's sweep, with the reason for each.

Consumers: `WikiList.svelte`.

## `<RecipeList>`

File: `src/components/RecipeList.svelte`.

Cookbook drawer tab: lists recipes with search, filter, and
per-recipe actions.

Consumers: drawer tabs in `Chat.svelte`.

## `<RecipeRating>`

File: `src/components/RecipeRating.svelte`.

Interactive star-rating control for recipes. Click a star to
set the rating; rendered inline in recipe detail cards.

Consumers: `RecipeList.svelte`.

## `<SamskaraBrowseList>`

File: `src/components/SamskaraBrowseList.svelte`.

Browse list of samskara records: the user's predictive model
compounds, ordered by confidence band, with per-samskara detail.

Consumers: Samskara diagnostics modal.

## `<SamskaraHealthPanel>`

File: `src/components/SamskaraHealthPanel.svelte`.

Stats panel for the samskara system: counts by confidence band,
formation rate, decay rate, association graph metrics.

Consumers: Samskara diagnostics modal.

## `<SamskaraMoodLegend>`

File: `src/components/SamskaraMoodLegend.svelte`.

Color legend mapping samskara mood bands to their visual palette.

Consumers: `SamskaraHealthPanel.svelte`.

## `<SamskaraMoodSync>`

File: `src/components/SamskaraMoodSync.svelte`.

Bottom-right mood pill that syncs with the samskara mood band,
showing a subtle color and label for the current detected state.

Consumers: `DiagnosticPills.svelte`.

## `<CohortPanel>`

File: `src/components/CohortPanel.svelte`.

Panel showing samskara fire cohorts: which samskaras fired on a
given turn, with their scores and the substrate they matched
against.

Consumers: `DiagnosticPills.svelte` (via the samskara pill's
detail view).

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

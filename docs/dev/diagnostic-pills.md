# Diagnostic pills

## Role

The diagnostic pills are the small glance cues that let the
user open each subconscious-layer diagnostics modal: **recall**,
**intuition**, **bias**, **samskara mood**, and **intents**.
They appear in a fixed top-to-bottom order on two surfaces:

- **Desktop** — a vertical column floating at the bottom-right
  of the messages pane, above the scroll-to-bottom arrow.
- **Mobile** (`<= 720px`) — a drop-up "wharf" menu hanging off
  a three-dot trigger in the composer bar, because the desktop
  column would collide with the response text on a narrow
  viewport.

This feature owns only the *pills* (presence, order, glyph,
labels, click-to-open-modal). The modals themselves and the
data behind each pill belong to the respective features
(Recall, Intuition, Bias profile, Samskara, Intents).

## Why one registry + one component

Historically each pill was its own Svelte component with its
own absolute-`bottom` CSS, the mobile wharf was a hand-
duplicated set of buttons, and a media-query hide-list in
`styles.css` had to name every desktop pill or it "leaked"
onto mobile. Three coupling sites, kept in sync by hand —
reordering or adding a pill meant editing ~6 places, and edits
to one surface silently desynced the other.

Now a single ordered registry is the source of truth and a
single component renders both surfaces from it, so the two
**cannot drift apart by construction**.

## Files

- `src/lib/ui/diagnostic-pills.ts` — the registry. The ordered
  `DIAGNOSTIC_PILLS` descriptor array (the one place order
  lives), the `DiagnosticPillContext` shape, and
  `visibleDiagnosticPills(ctx)` which filters to the present
  pills and annotates each with its desktop `bottom`. Pure and
  rune-free (the "decision logic lives in `src/lib/ui`" rule,
  see [frontend-organization.md](./frontend-organization.md));
  unit-tested in `tests/diagnostic-pills.test.ts`.
- `src/components/DiagnosticPills.svelte` — renders both
  surfaces. Takes `variant: 'desktop' | 'mobile'`, loops the
  registry, and carries the scoped CSS for the column AND the
  mobile wharf (responsive show/hide included). A pure reader.
- `src/components/SamskaraMoodSync.svelte` — headless single
  owner of the samskara mood data (see Gotchas).
- `src/lib/samskara/mood.svelte.ts` — the shared mood store.
  `current` (valence/confidence/tier) feeds the diagnostics-
  modal dot; `visual` (glyph/label + transition id) feeds the
  pill.

## Entry points

`Chat.svelte` mounts the component **twice** — once per surface:

- `<DiagnosticPills variant="desktop" .../>` inside
  `.messages-wrap` (so the absolutely-positioned column anchors
  to the same box as the scroll-to-bottom arrow and stays
  aligned regardless of composer height).
- `<DiagnosticPills variant="mobile" ... open onToggle onClose/>`
  inside `.composer-bar` (the wharf trigger has to live next to
  the model-picker wharf trigger).

Two mounts, not one instance, because the surfaces need
different DOM parents — a single Svelte instance renders into
one place in the tree. Each mount carries a comment pointing at
the other. `SamskaraMoodSync` is mounted once next to the
desktop pills.

## Layout model

The desktop column is bottom-anchored above the scroll arrow.
`visibleDiagnosticPills` assigns each present pill a `bottom`
of `3.6rem + i*2.5rem`, counting `i` from the **bottom** of the
visible set (lowest pill at `3.6rem`, `2.1rem` pill height +
`0.4rem` gap = `2.5rem` step). Because the offset is computed
from the *present* pills rather than a fixed per-pill value, an
absent pill (intents off, or samskara on the new-chat screen)
simply collapses its slot — no gap opens, and there is no
`--diag-base`-style toggle to keep in sync.

Mobile order is plain DOM order from the same registry loop.

## Contracts

- **Order is `DIAGNOSTIC_PILLS` order.** Changing the array
  reorders both surfaces. A test pins it.
- **Presence**: recall / intuition / bias are always present
  (recall and intuition merely render *disabled* when their
  payload is missing — the slot is held). Samskara is present
  only on an active thread (`moodVisual !== null`). Intents is
  present only when `app.intentsEnabled`.
- **Each pill opens `navigate({ modal })`** with its registry
  `modal`.

## Interactions

- **Recall** ([context-recall.md](./context-recall.md)) —
  consumes the cached `context_recall_payload`; pill disabled
  until the note is non-empty.
- **Intuition** ([intuition.md](./intuition.md)) — consumes the
  cached `intuition_payload`; pill disabled until present.
- **Bias profile** ([bias-profile.md](./bias-profile.md)) —
  always-enabled pill; the modal carries its own cold-start
  chrome.
- **Samskara** ([samskara.md](./samskara.md)) — the mood pill
  reads `moodState.visual`, written only by `SamskaraMoodSync`
  from the `SAMSKARA_MINT_EVENT` relay and the
  `samskaraGetLatestFireMood` thread-open seed.
- **Intents** ([in-progress/intents.md](./in-progress/intents.md))
  — opt-in pill gated on `app.intentsEnabled`.
- **Chat** ([chat.md](./chat.md)) — owns the two mount sites,
  the payload `$derived`s passed in, and the mobile
  `composerDiagWharfOpen` state + `closeMenus` coordination.

## Gotchas

- **Both mounts are in the DOM at once** (CSS hides the wrong
  one per viewport). So any per-thread side effect must have a
  single owner or it runs twice. That is why the samskara
  pipeline (the mint listener, the thread-open seed fetch, the
  `route.cid` reset effect) lives in the headless
  `SamskaraMoodSync.svelte`, mounted once, writing to
  `moodState`; the pills are pure readers. Do not move that
  logic back into `DiagnosticPills`.
- **`SamskaraMoodSync` writes two store fields together.**
  `set` (the modal dot's triple) is unconditional per mint;
  `setVisual` (the pill) honours the dedup in
  `nextMoodFromMint` so a no-op mint doesn't replay the fly
  transition. `clear()` clears both on thread switch.
- **`src/lib/ui/samskara-toasts.ts` is a misnomer.** It no
  longer drives toasts (the auto-dismissing stack was removed
  long ago); it is the mood-shape transition primitives
  (`nextMoodFromMint` / `nextMoodFromSeed` / `defaultMood` /
  `MoodVisual`). Left named as-is to avoid churn; don't go
  looking for toast UI behind it.
- **The mobile wharf shares the `composer-wharf-slide`
  keyframe** with the model-picker wharf, which is why that
  one keyframe stays global in `styles.css` while the rest of
  the wharf styling is scoped inside `DiagnosticPills.svelte`.

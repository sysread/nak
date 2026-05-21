# `src/components/`

Reusable Svelte 5 components, runes-mode (`$props`,
`$state`, `$derived`, `$effect`). Screens (`src/screens/`)
compose these; no file in here imports from another screen.

A component's job is composition, not decision-making.
Take the pure UI-behavior primitives from `src/lib/ui/`,
wire them to framework-native reactivity, bind to DOM
events, attach the document-level listeners that close
popovers or trap escape keys, render the markup. Anything
else that would need rewriting in a framework swap - DOM
refs, lifecycle hooks, transitions, focus management,
ARIA mirroring - is also fair game here.

**What does NOT belong here** is anything that doesn't
need Svelte to express it: option-list synthesis,
selection mutators, domain sentinels, display-label
transforms, enum-to-string maps, fallback chains over
persisted shapes, count-to-noun pluralization, state-
machine transitions over user input. Those go in
`src/lib/ui/<feature>.ts` and get composed in.

The rule of thumb when reviewing a `.svelte` file: if you
deleted everything between `<script>` and `</script>`
except `import`s and `$props` / `$state` / `$derived`
declarations and the file was *worse* at explaining what
the UI does, the missing logic should have been in
`src/lib/ui/`. The script block should read like glue,
not like a feature spec.

Bug fixes and new affordances are the usual creep vector
- "just three lines inline" compounds across a year of
edits until the next port-to-React rewrite is rediscovering
every rule from scratch. Extract the primitive the first
time, even if the call site is one line. See
[`docs/dev/frontend-organization.md`](../../docs/dev/frontend-organization.md)
for the full criteria, a worked example, and the audit
checklist.

## Catalog

The per-component inventory lives at
[`docs/dev/components.md`](../../docs/dev/components.md):
prop shapes, conventions (controlled popovers, inline SVG,
global CSS), and consumer references for each component.

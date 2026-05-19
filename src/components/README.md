# `src/components/`

Reusable Svelte 5 components, runes-mode (`$props`,
`$state`, `$derived`, `$effect`). Screens (`src/screens/`)
compose these; no file in here imports from another screen.

A component's job is composition: take the pure
UI-behavior primitives from `src/lib/ui/`, wire them to
framework-native reactivity, bind to DOM events, attach
the document-level listeners that close popovers or trap
escape keys, render the markup. Anything else that would
need rewriting in a framework swap - DOM refs, lifecycle
hooks, transitions, focus management, ARIA mirroring - is
also fair game here.

What does NOT belong here is decision logic that has
nothing to do with Svelte: option-list synthesis, selection
mutators, domain sentinels, display-label transforms,
state-machine transitions over user input. Those go in
`src/lib/ui/<feature>.ts` and get composed in. See
[`docs/dev/frontend-organization.md`](../../docs/dev/frontend-organization.md)
for the full criteria and a worked example.

## Catalog

The per-component inventory lives at
[`docs/dev/components.md`](../../docs/dev/components.md):
prop shapes, conventions (controlled popovers, inline SVG,
global CSS), and consumer references for each component.

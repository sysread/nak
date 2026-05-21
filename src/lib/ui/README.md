# `src/lib/ui/`

Pure UI-behavior primitives. Plain TypeScript modules, one
per feature. No runes, no Svelte imports, no DOM access, no
reactive state, no `*.svelte.ts` extension. A reader who
knows nothing about Svelte should be able to open one of
these files and understand it as ordinary TypeScript.

**The decisions that belong here are the ones a port to
React, Solid, or Vue would have to make identically:**
what the visible option list looks like, what counts as an
active filter, how a selection mutates in response to a
click, what label a value gets in the UI, what the next
state is after some user action, which fallback fires when
a persisted row is malformed, how a count maps to a noun
phrase, which enum value maps to which user-facing string.

The companion `src/components/<X>.svelte` is the only file
allowed to wire these into framework-native reactivity. If
a component is reaching for a helper that doesn't yet
exist in this directory, add the helper here first - even
if the call site is a single line. Inline decision logic
in a `.svelte` file is the dominant creep vector: each
"just three lines" compounds across edits until the
component becomes a feature spec instead of a glue layer.
See [`docs/dev/frontend-organization.md`](../../../docs/dev/frontend-organization.md)
for the extraction criteria, the audit checklist, and a
worked example.

## Worked example

`src/lib/ui/topics-filter.ts` paired with
`src/components/TopicsFilter.svelte`. Five pure functions
on one side; Svelte composition glue on the other. Tests
live at `tests/topics-filter.test.ts` (plain vitest, no
mount, no harness).

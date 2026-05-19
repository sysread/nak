# `src/lib/ui/`

Pure UI-behavior primitives. Plain TypeScript modules, one
per feature. No runes, no Svelte imports, no DOM access, no
reactive state. A reader who knows nothing about Svelte
should be able to open one of these files and understand it
as ordinary TypeScript.

The decisions that belong here are the ones a port to
React, Solid, or Vue would have to make identically: what
the visible option list looks like, what counts as an
active filter, how a selection mutates in response to a
click, what label a value gets in the UI, what the next
state is after some user action.

The companion `src/components/<X>.svelte` is the only file
allowed to wire these into framework-native reactivity. See
[`docs/dev/frontend-organization.md`](../../../docs/dev/frontend-organization.md)
for when to extract a primitive vs. leave it inline, the
shape these modules take, and how they get tested.

## Worked example

`src/lib/ui/topics-filter.ts` paired with
`src/components/TopicsFilter.svelte`. Five pure functions
on one side; Svelte composition glue on the other. Tests
live at `tests/topics-filter.test.ts` (plain vitest, no
mount, no harness).

# Frontend organization

The frontend splits into two layers with deliberately
different concerns. Knowing which layer a change belongs in
is the prime directive when working on UI code.

```text
src/lib/ui/<feature>.ts      pure UI-behavior primitives
src/components/<X>.svelte    Svelte composition + DOM glue
```

The split exists so most of the codebase's UI logic survives
a framework swap. The `.svelte` files are the only place
Svelte's API surface is allowed to leak in.

## What goes in `src/lib/ui/`

Plain TypeScript modules. Pure functions only. No runes
(`$state`, `$derived`, `$effect`), no Svelte imports, no
`*.svelte.ts` extension, no reactive state, no DOM access.
A reader who knows nothing about Svelte should be able to
open one of these files and understand it as ordinary
TypeScript.

The decisions that belong here are the ones a port to React
/ Solid / Vue would have to make identically: what the
visible option list looks like, what counts as an active
filter, how a selection mutates in response to a click,
what label a value gets in the UI, whether two values are
considered equivalent, what the next state is after some
user action.

Concrete shape — the topic-filter primitives at
`src/lib/ui/topics-filter.ts`:

```ts
export function computeOptions(topics: readonly string[]): readonly string[];
export function labelFor(topic: string): string;
export function isUntagged(topic: string): boolean;
export function selectionAfterToggle(
  selected: readonly string[],
  topic: string,
): string[];
export function selectionAfterClearOne(
  selected: readonly string[],
  topic: string,
): string[];
```

Five functions. Each takes inputs, returns outputs, mutates
nothing. The companion test file (`tests/topics-filter.test.ts`)
is plain vitest with no mount and no harness - import a
function, call it, assert on the return value.

## What goes in `src/components/`

Svelte 5 components. Their job is composition: take the
primitives from `src/lib/ui/`, wire them to framework-
native reactivity (`$state` / `$derived`), bind to DOM
events, render markup, attach the document-level listeners
that close popovers or trap escape keys.

The component is also where any genuinely framework-coupled
concern lives: prop destructuring, DOM refs (`bind:this`),
transitions, lifecycle hooks (`onMount` / `onDestroy`),
event delegation, focus management, ARIA attributes that
mirror reactive state. Those would all be rewritten in a
framework swap; the primitives wouldn't.

Concrete shape — the topic-filter component at
`src/components/TopicsFilter.svelte`:

```svelte
<script lang="ts">
  import {
    computeOptions,
    labelFor,
    isUntagged,
    selectionAfterToggle,
    selectionAfterClearOne,
  } from '$lib/ui/topics-filter';

  const { topics, selected, onChange }: Props = $props();

  let open = $state(false);
  const options = $derived(computeOptions(topics));
  const selectedSet = $derived(new Set(selected));
  const hasActive = $derived(selected.length > 0);

  function toggle(t: string): void {
    onChange(selectionAfterToggle(selected, t));
  }
  // ...listeners, mutators, markup...
</script>
```

The component knows how to be a Svelte component. It
delegates every UI-behavior decision to a primitive call.

## When to extract

Not every component needs a sibling in `src/lib/ui/`. The
test is: would a port to another framework rewrite this
logic, or would it carry it across unchanged?

Extract when the component has:

- A non-trivial transformation from props to view (option
  list synthesis, bucketing, filtering, sorting).
- Domain knowledge encoded in plain values (sentinels,
  reserved names, magic constants tied to a spec).
- A state machine over user input (multi-step selection,
  toggle semantics that preserve order or dedupe).
- Display-label transforms that hide an internal
  representation from the user.

Skip when the component is:

- Layout-only, with no decisions beyond "render the
  children."
- A thin presentational wrapper over a single prop value.
- Dominated by lifecycle / transition / DOM-quirk handling
  with little or no logic on top.

Borderline cases stay in the component until the second
caller appears. Three similar lines beat a premature
abstraction.

## What to extract: domain knowledge, not length

The bar for extraction is **whether a reader needs feature-
specific knowledge to interpret the expression**, not whether
it's short. Length is a bad proxy. A one-liner that requires
the reader to recall how the feature works internally
deserves a name. A one-liner that's universal arithmetic
doesn't.

`selected.length > 0` is universal - any reader knows what
"array is non-empty" means without context. Stays inline.
`new Set(selected)` is universal - "build a lookup set."
Stays inline. `onChange([])` is universal - "reset to empty."
Stays inline.

`clusters.length < sortedFires.length` is **not** universal.
It only means "the panel is showing a collapsed view" if you
already know the cluster RPC produces fewer buckets than
members exactly when at least one bucket has siblings.
That's domain knowledge leaking into arithmetic. Extracts to
`isCollapsedView(clusters, fires)` - the name carries the
intent and the reader doesn't have to re-derive the meaning.

The test isn't "could I write this inline" - of course you
could - it's "would a reader of the component understand it
without consulting the feature's docs."

Trivial inline examples from the topic-filter component
(`hasActive`, `selectedSet`, `clearAll`) all pass the
universal-arithmetic test. The cohort-panel component's
`toggleCluster` is similar - the body is pure Set
manipulation any reader can follow without knowing what
clusters are.

## Testing

Primitives are unit-tested as plain vitest cases. No mount,
no harness, no DOM. Import, call, assert. The directory of
the test file mirrors `tests/<feature>.test.ts` so the
pairing is discoverable.

Component-level tests live in `tests/<name>.test.ts` too
but use `@testing-library/svelte`'s `render()`. Existing
examples: `tests/reasoning-picker.test.ts`,
`tests/verbosity-picker.test.ts`. These cover the view
surface (rendered markup, ARIA, focus, event emission) -
not the decisions the primitives already prove.

## Discovery

The two layers carry short READMEs at their roots
(`src/lib/ui/README.md`, `src/components/README.md`) so the
split is visible from inside the source tree. Both point
back here for the long form.

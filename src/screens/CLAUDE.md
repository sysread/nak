# `.svelte` files in this tree

Before you write a `function`, a non-trivial
`$derived.by(() => { ... })` body, or a template branching
cascade (`{#if foo === 'a'} ... {:else if foo === 'b'}`),
ask: would a port to React, Solid, or Vue rewrite this
expression? If no, it's a UI-behavior primitive and belongs
in `src/lib/ui/<feature>.ts`, not here. The `.svelte` file
calls into the helper; runes are framework wire-up, not the
home for decision logic.

Specifically: enum-to-label transforms, count-to-noun
pluralization, list-assembly with filtering or sorting,
next-state computations for $state Maps/Sets, and any walk
over a domain collection are all candidates for extraction.
Create `src/lib/ui/<feature>.ts` on the first occurrence,
even if it's one function.

Full extraction criteria, audit checklist, and a worked
example in
[`docs/dev/frontend-organization.md`](../../docs/dev/frontend-organization.md).

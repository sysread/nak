# Cooklang `>` Continuation Lines: Preserve Structure and Render Sub-Lists

Status: LANDED - kept for the design rationale. The living
reference is [`../cookbook.md`](../cookbook.md) (the section-model
bullet's continuation description); the QA walkthrough is
[`../../qa/use-cases/cookbook-continuation-lines.md`](../../qa/use-cases/cookbook-continuation-lines.md).
Notable divergence from this plan: none - M1-M4 shipped as planned,
with the two review rounds' fixes folded in before implementation.

Read [`../cookbook.md`](../cookbook.md) first; this plan assumes its
cooklang parser/renderer vocabulary.

## SYNOPSIS

A `>` continuation line in cooklang currently has its line structure
destroyed at parse time: the parser space-joins every continuation onto
the previous step, so a step written as prose lead-in plus markdown
sub-bullets renders as one inline wall of text (observed in prod on the
Fermentolyse step of a bread recipe, 2026-10-16). This plan preserves
the line structure in the parsed AST and teaches all three renderers
(HTML, plain text, markdown) to present it: prose continuation lines
wrap exactly as today, `-`/`*` bullet lines render as a sub-list
inside the step.

## PURPOSE

The `>` continuation extension was designed for AnyList-style
hard-wrapped prose (`src/lib/cooklang.ts:32-36`), but the LLM reaches
for it whenever a step needs sub-structure - conditional sub-bullets,
altered-quantity notes - because the `recipe_save` tool description
tells it to "wrap long steps with a `>` continuation line"
(`src/lib/tools/recipe_save.schema.ts:87`). The parser's space join
(`src/lib/cooklang.ts:542`) flattens that structure into unreadable
inline text. The information needed to render nicely exists in the
stored source; we discard it during parsing. Fix the parse, fix the
render.

## DESCRIPTION

### How the relevant code behaves today

- **Parser merge.** Each `>`-prefixed line is tokenized and merged
  into the previous instruction step with a single-space join: the
  step's `text` gains a space and the continuation's rendered line
  (`src/lib/cooklang.ts:540-549`). A `>` line with no prior step is
  promoted to a standalone instruction step
  (`src/lib/cooklang.ts:556-569`). The matcher is
  `tryParseContinuation` (`src/lib/cooklang.ts:262-268`); `>>` metadata
  is matched first so it never reaches the continuation path
  (`src/lib/cooklang.ts:510-514`).
- **AST.** `Step.text` is a single string with no line concept
  (`src/lib/cooklang.ts:122-126`). All renderers consume it.
- **HTML.** `stepListItem` emits one `<li`> per instruction step with
  `renderInlineEmphasis(esc(step.text))`
  (`src/lib/cooklang-render.ts:583-586`). The emphasis pass is
  explicitly not a markdown renderer: no lists, no line-break handling
  (`src/lib/cooklang-render.ts:102-143`). `-` bullet markers survive
  as literal text.
- **Plain text / markdown exports.** Both emit
  `` `${i + 1}. ${step.text}` `` per step, flat and per-section
  (`src/lib/cooklang-render.ts:855-876`, `:1044-1062`).
- **Timers.** `collectTimersWithContext` pairs each timer with its
  step's full text (`src/lib/cooklang-render.ts:57-74`); the HTML timer
  context span is styled as a 2-line clamp with ellipsis
  (`src/screens/Cookbook.svelte:2663-2673`, emission at
  `src/lib/cooklang-render.ts:663-666`), and the markdown timer context
  truncates to 80 chars (`src/lib/cooklang-render.ts:1026-1033`).
- **Detail-pane step highlight.** Cookbook.svelte click delegation
  takes `target.closest('li')` and requires that li's parent to be
  `ol.cook-steps` (`src/screens/Cookbook.svelte:1477-1480`); four CSS
  rules use descendant selectors over `cook-steps li` - the counter and
  padding rule `ol.cook-steps li` (`:2831`), the number badge
  `ol.cook-steps li::before` (`:2841`), and the two is-active rules
  (`:2864`, `:2871`) - and two JS clear loops query
  `ol.cook-steps li.is-active` (`:1469`, `:1485`). All assume a step
  `<li`> contains no nested lists. `followTimerLink`
  (`:1028-1039`) resolves `#cook-step-N` anchors, which live on the
  direct step `<li`> only.
- **Other consumers are text-shape-agnostic.** Embeddings feed the raw
  cooklang source, not parsed steps
  (`supabase/functions/_shared/embed-input.ts:73`). The grocery GC
  trigger extracts only `@`-tokens from the raw source
  (`supabase/schema.sql:4332-4346`). Recipe-record export reuses
  `recipeToMarkdown` (`src/lib/recipe-records-export.ts:65-71`).
  Cookbook.svelte has five render surfaces (edit preview, copy-plain,
  copy-markdown, live detail, past-version) and no direct `step.text`
  reads (`src/screens/Cookbook.svelte:271`, `:914-915`, `:921-922`,
  `:991`, `:1001`, `:1405-1409`).
- **Tests pin the flattening.** Space-join is asserted at
  `tests/cooklang.test.ts:392-400`, `:415-419`, `:433-440`, and
  `:476-495`; a `[^<]*` same-text-node assertion at `:685` requires
  prose continuations to stay one text run in HTML.

### What this plan adds

#### M1: Parser preserves lines (src/lib/cooklang.ts)

- The continuation merge joins with `\n` instead of a space
  (`src/lib/cooklang.ts:542`). Nothing else in the parse loop changes:
  token extraction, declaration handling, section tracking, and the
  leading-`>` promotion are untouched.
- Update the module-header extension doc (`src/lib/cooklang.ts:32-36`)
  to say continuations keep their line structure and bullet lines
  render as a sub-list, and that an empty ``> body drops the
  paragraph-break signal (adjacent prose rejoins with a space).
- Update the flattening-pinning tests listed above.

#### M2: Shared step-block grouping + HTML sub-lists (src/lib/cooklang-render.ts)

- New internal helper `stepBlocks(text)`: splits a step's text on `\n`
  and groups consecutive lines into ordered blocks -
  `{ kind: 'prose', text }` (adjacent prose lines rejoined with a
  single space) and `{ kind: 'bullets', items }` (lines matching
  `/^[-*] (.+)$/` after trim). This is the single grouping used by
  every renderer, so the three projections stay in lockstep.
- `stepListItem` renders each block in order: prose blocks as text
  runs (emphasis pass unchanged), bullet blocks as
  `<ul class="cook-substeps"`> with one `<li`> per bullet, each bullet
  rendered with `renderInlineEmphasis(esc(item))` - the prod case
  (`- **condition:** fix`) depends on emphasis inside bullets. Prose
  before and after a sub-list flows as separate text runs; no `<br`>
  needed - the `<ul`> is a block box, so trailing prose starts on its
  own line.
- `collectTimersWithContext` step context uses the step's first prose
  block (falling back to the first line with its `-`/`*` marker
  stripped, when the step has no prose) so the 2-line clamp and the
  80-char markdown truncation see no newline and no bullet marker.
- Cookbook.svelte CSS: narrow the two badge-forming rules from
  `ol.cook-steps li` / `ol.cook-steps li::before` to direct-child
  selectors (`:2831`, `:2841`) so nested bullet `<li`>s do not get
  number badges or counter increments. The is-active rules (`:2864`,
  `:2871`) and the two clear loops (`:1469`, `:1485`) intentionally
  stay descendant: is-active is only ever set on direct step lis, and
  the loops want the broad match to clear stale state. Add
  `.cook-substeps` styles (disc markers, left indent).
- Cookbook.svelte click delegation: resolve the highlighted step with
  `closest('ol.cook-steps > li')` so a click on a sub-bullet highlights
  its parent step instead of being ignored
  (`src/screens/Cookbook.svelte:1477-1480`). `followTimerLink` needs no
  change - timer anchors live on the direct step `<li`>. Add a
  `.cook-substeps li { cursor: pointer; }` rule: the delegation change
  makes sub-bullet clicks highlight the parent step, and narrowing
  `:2831` otherwise strips the cursor hint from them.

#### M3: Plain-text and markdown exports (src/lib/cooklang-render.ts)

- Plain text: prose block on the `N.` line; bullet blocks as
  three-space-indented `- item` lines; trailing prose indented
  three spaces to sit inside the step.
- Markdown: prose block on the `N.` line; bullet blocks as
  `- item` lines at a four-space indent (which nests under the ordered item in
  CommonMark); a prose block following bullets gets a blank line then
  the prose at the same four-space indent, so it renders as a sibling paragraph of the sub-list
  rather than lazy continuation of the last bullet. Sub-lists are
  tight (no blank line between the `N.` line and its bullets); the
  blank line appears only before a trailing prose block. CommonMark
  nesting verified: 4 >= the `1.` content column (3), bullets
  interrupt prose, and no indented-code-block hazard below 7 spaces.
  At step 100+ the marker content column grows to 5 and 4-space
  nesting degrades to lazy continuation - accepted limitation, a
  recipe step number that deep is unreachable.
- A step whose text BEGINS with a bullet block is reachable (a
  top-level `- item` source line becomes its own step, since
  `isSectionReset` only matches 2+ dashes at
  `src/lib/cooklang.ts:288-290`; and a `> - bullet` after a
  declaration line is promoted to a standalone step, since
  declarations do not anchor continuations,
  `src/lib/cooklang.ts:537-538`). Export shape for that case: bare
  `N.` marker with the bullets indented beneath it (plain text
  three spaces, markdown four spaces). HTML renders the sub-list
  under the numbered badge with no lead-in prose - fine, but pinned
  by test.

#### M4: Tool description + docs

- `recipe_save.schema.ts` description: continuations keep line
  structure; `-`/`*` bullet continuations render as a sub-list
  inside the step; keep prose wrapping for plain continuations. The
  dev doc requires keeping this description in sync with rendering
  (`docs/dev/cookbook.md:851-852`).
- `docs/dev/cookbook.md:826-828` (section model bullet) and
  `docs/user/cookbook.md:95-98` (user-facing continuation paragraph)
  describe the new behavior.

### Decisions

- **`\n` in `Step.text` is the carrier of line structure.** No new AST
  field; one source of truth. Renderers that want wrapped prose rejoin
  with a space, which reproduces today's output for existing
  prose-wrapped recipes byte-for-byte.
- **Bullets are `-` and `*` only, single level.** Ordered sub-lists
  (`1.`) and deeper nesting stay literal prose. Narrow scope matches
  the observed LLM habit; extend if a use case appears.
- **Bullet detection applies to any line of step text**, not just
  continuation lines. In practice only continuations can introduce
  them (a top-level `-` line is its own step); this keeps
  `stepBlocks` total.
- **No validateCooklangSource change.** Bullet continuations are now
  first-class, not an authoring quirk to reject.
- **No data migration.** Recipes store raw source; parsing happens at
  read time, so existing recipes pick up the new rendering with no DB
  change.
- **Timer context shows the step's first prose block** (first line
  when the step has no prose). It is informational; per-bullet timer
  context is over-engineering.

### Milestones and verification

- **M1 + M2 + M3 land as ONE merge.** The moment M1's `\n` join lands,
  `Step.text` is multi-line, so the unchanged plain-text/markdown
  exports would emit raw newlines (copy-plain loses the space join;
  copy-markdown emits unindented bullet lines CommonMark parses as a
  new top-level list). The parser and all three renderers ship
  together; M4 (tool description + docs) follows. Gate: the cooklang
  and recipe-export test files. New tests: prose-wrapped continuation
  HTML output unchanged (back-compat), copy-plain/copy-markdown output
  for prose-wrapped continuations unchanged, sub-list HTML shape,
  mixed prose-bullets-prose ordering, emphasis inside bullets, markdown
  nesting, plain-text indent, timer context first prose block,
  all-bullets step shape (HTML and both exports).
- M4 verified by `mise run check` (lint/format gate) plus doc reads.
- Manual QA: paste the Fermentolyse-style source into the cookbook
  edit preview; confirm sub-list rendering, step highlight on
  sub-bullet clicks, timer links, copy-as-markdown output, and
  copy-as-plain output (the AnyList paste journey - indented
  bullet lines are new there).
- The full-suite gate: `mise run check`.

### Risks

- **Markdown nesting pitfalls.** Lazy continuation could glue trailing
  prose onto the last bullet; the blank-line + 4-space rule avoids it.
  Verified against CommonMark list-item continuation rules by test.
- **CSS selector narrowing.** `ol.cook-steps > li` must not regress
  the badge for sectioned recipes (each section's `<ol`> is a fresh
  `ol.cook-steps`; direct children unchanged).
- **Prod data.** Existing flattened RENDERING was produced from
  unflattened SOURCE; nothing stored needs repair.

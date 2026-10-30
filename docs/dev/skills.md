# Skills

Named, described markdown instruction bodies that the user and the
chat model both maintain: a `skills` table, one `skills` combination
tool (list / get / search / save / delete behind an `op` enum), a
per-turn index section in the metadata system message, a static
skills block in the baseline system prompt, and a Skills drawer tab
(sidebar + panel). Recurring task guidance - a format, a procedure,
a checklist - stops being re-derived per conversation and accretes
into explicit, inspectable, editable rows instead.

## Role in the app

Skills are the pull-in layer: the description (the trigger surface)
is always visible to the model at the token cost of a couple of
sentences, and the body is paid for only when a task actually
matches. The split is the design, and it shapes every cap in the
feature - the always-loaded field carries the tight ceiling, the
on-demand field carries the loose one.

Skills are one of three knowledge surfaces, and the split is
deliberate:

- **Memories** (see `./memory.md`) - facts about the user and their
  world, recalled as background context.
- **Custom prompts** (Settings -> Prompts) - always-on persona and
  voice shaping that ride every turn wholesale.
- **Skills** - working instructions, pulled in only when a task
  matches. The model also maintains them, so recurring asks accrete
  into guidance instead of stale training assumptions.

From the user's perspective this is the Skills feature documented
in `docs/user/skills.md`. The dev side has five moving parts:

1. **The store** - `skills` table, RLS-scoped, no embedding
   columns, no claim columns, no changelog (see Contracts).
2. **The tool** - one combination tool, the first in nak: a single
   `skills` tool with an `op` enum discriminator, in the `skills`
   toolbox.
3. **The index** - a skills section in the per-turn metadata
   system message: one `name: description` line per skill,
   entry- and byte-capped, flattened.
4. **The instructions** - a static `SKILLS_BLOCK` in the baseline
   system prompt teaching use and proactive maintenance.
5. **The browser** - `src/components/SkillList.svelte` (sidebar)
   plus `src/screens/Skills.svelte` (panel) plus
   `src/lib/skills-store.svelte.ts` (shared rune), reached as a
   drawer tab; the URL keys are `?drawer=skills` for the tab and
   `?skill=<id>` for the focused skill.

There are no agent-side mirrors: no reflection integration, no
skill-mining sweep, no librarian. The chat model is the only
writer besides the user.

## Files

- `src/lib/skills.ts` - the canonical char-limit constants:
  name 64, description 300, body 32000, and the two index caps
  (50 entries / 4000 chars). The asymmetry is the design: the
  description rides every turn so it carries the tight cap; the
  body loads on demand so it carries the loose one. This file is
  canonical - the edge island mirrors it.
- `supabase/functions/_shared/skills-limits.ts` - the Deno-island
  mirror of those five constants (the edge function cannot import
  browser modules; see `supabase/functions/README.md`).
  `tests/skills-limits-parity.test.ts` fails if the pair drifts.
- `src/lib/supabase/types/skills.ts` - the `Skill` row type, the
  body-less `SkillSummary` projection, and defensive coercers
  (`last_author` coerces unknown values to `'user'`).
- `src/lib/supabase/skills.ts` - the data-layer slice: `listSkills`
  (the body-less index projection, ordered `name asc`, NO row
  limit - the index caps and the overflow count are computed in JS
  from the fetched set, so the deterministic-selection contract
  has a defined input), `listSkillsPage` (offset-paged browse
  list, `name asc` with `id` as cross-page tiebreak, the
  `pageSize + 1` probe deriving `hasMore`), `getSkill`, `searchSkills`
  (ILIKE over name + description + body via the QUOTED logic-tree
  builder), `saveSkill` (create/update by id, stamps
  `last_author = 'user'`), `deleteSkill` (hard delete).
- `src/lib/supabase.ts` - the facade delegates its skill methods
  to the slice one-for-one under the same names (the Skills banner
  near the top of the file maps them).
- `src/lib/supabase/realtime.ts` - `subscribeToSkillChanges`, the
  memories twin: a `postgres_changes` subscription on the user's
  skills rows relayed as a coarse no-payload callback.
- `src/lib/skill-events.ts` - the window-level event bus
  (`emitSkillChange` / `onSkillChange`), mirroring
  `memory-events.ts`. Payload-free by design: consumers re-fetch
  what they need rather than trusting a payload that would have
  to track the table shape.
- `src/lib/tools/skills.schema.ts` - the browser-side wire schema:
  the `op` enum, flat per-op params each carrying the canonical
  maxLength, the tool description with the maintenance trigger,
  and the detail-panel `formatArgs` (the op renders first).
- `supabase/functions/venice/tools/skills.ts` - the edge
  implementation, self-registering via the side-effect import
  barrel. One shared `ArgErrors` pass collects op-conditional
  validation; the ops then dispatch on `op`. The search sweep is
  capped at 20 results (`SKILL_SEARCH_LIMIT`) - tool results land
  wholesale in context, and 20 name + description hits is enough
  for the model to pick a get target.
- `src/lib/chat/system-prompt.ts` - `SKILLS_BLOCK`, the static
  instructions: what skills are, scan the index before starting a
  task, `op=get` on a plausible match, `op=list` when no index
  section is present (a failed fetch is indistinguishable from an
  empty store), maintain proactively, announce every
  create/update/delete, and the skills-vs-memories ROUTING rule:
  a user statement of how they want a task done is skill material
  even when no similar skill exists yet (added after live QA -
  without it the model routed casually-stated procedural
  preferences to `memory_save`, so the first skill was never
  created; the index entry is what triggers skill-thinking), with
  the wiki explicitly excluded as a destination for task guidance
  (the third model-reachable write surface, closed the same day).
  Slotted into the `sections` array near
  the other feature blocks; cache-safe because it is static.
- `src/lib/chat/prompt-assembly.ts` - `buildSkillsIndexSection`
  plus the `skillIndex` option on `buildMetadataSystemMessage`.
  The section rides LAST, after the title nudge - pure data after
  everything directional.
- `src/lib/chat/loop.ts` - the per-turn fetch: `listSkills` runs
  concurrently with the attachment inventory in one `Promise.all`,
  each leg swallowing its own failure (a failed skills fetch
  degrades to no section, which `SKILLS_BLOCK`'s `op=list`
  fallback covers).
- `src/lib/skills-store.svelte.ts` - the shared rune store.
  Two regimes feed `results`: browse (empty query; offset pages
  from `listSkillsPage`, grown by the listing surfaces'
  infinite-scroll sentinels) and search (non-empty query; capped,
  unpaged, `hasMore` forced false). A supersede token discards
  late-landing responses from superseded flights.
  `refreshSkillsListing` is the bus-driven refresh: it refetches
  rows 0 through the loaded depth in ONE query so a realtime
  write does not collapse every page the user scrolled in. Bus
  refresh lives in the panel, not the store - the store is pure
  data plus query drivers.
- `src/components/SkillList.svelte` - the sidebar. Search input
  bound to `skillsStore.query` behind the 200ms debounce, rows of
  name + one-line description snippet, active marker, browse-list
  sentinel. Composition-only; the decisions live in
  `src/lib/ui/skills-list.ts`.
- `src/screens/Skills.svelte` - the panel. A small state machine
  over `route.skill` plus local mode (list / create / detail /
  edit / loading; the precedence list lives in the
  `skillsPanelSurface` docstring in `src/lib/ui/skills.ts`). With
  no selection: the paged browse list plus the New skill button,
  with its own load-more sentinel so the panel list can also
  reach past the first page. With a selection: detail (body
  rendered as Markdown, `last_author` + timestamps), inline edit,
  delete with an inline confirm strip. Owns the bus listener:
  refresh listing + reclassify the open skill. Composition-only;
  the decisions live in `src/lib/ui/skills.ts`.
- `src/lib/ui/skills.ts` - pure panel primitives: surface
  selection, the action-status vocabulary (including the named
  duplicate-name status for the 23505), form validation with the
  canonical caps, notice copy, formatters.
- `src/lib/ui/skills-list.ts` - pure sidebar primitives:
  `SEARCH_DEBOUNCE_MS` (200, each feature module declares its own
  copy by convention), `ROW_SNIPPET_CHARS` (90), `emptyMessage`,
  `rowSnippet` (whitespace-collapsed before the length cut).
- `src/lib/routing.svelte.ts` - the `skill` param (singular
  against the plural drawer value `skills`). Deep-link contract:
  the per-row param renders only inside its drawer tab, so the
  URL is always `?drawer=skills&skill=<id>`, never a bare
  `?skill=<id>`.
- `supabase/schema.sql` (skills section) - table, unique
  expression index, `touch_skill_updated_at` trigger, RLS
  policies, realtime publication membership, and the
  `(id, user_id)` replica identity index.
- Tests: `tests/skills.test.ts` (panel primitives),
  `tests/skills-list.test.ts` (sidebar primitives),
  `tests/skills-store.test.ts` (the store's regimes, supersede
  token, depth-preserving refresh), `tests/skills-slice.test.ts`
  (the data layer against a stubbed client),
  `tests/skills-index-block.test.ts` (the metadata section:
  present / empty-absent / entry-capped / byte-capped / overflow
  line / the newline-flatten injection pin),
  `tests/skills-limits-parity.test.ts` (island lockstep),
  `tests/realtime-subscribe.test.ts` (the relay twin), and the
  Deno pair `supabase/functions/tests/skills_barrel.test.ts`
  (barrel membership - the net for a forgotten import, which
  would make the model's skills call die unimplemented) and
  `skills_tool.test.ts` (per-op behavior: natural-key routing,
  near-match refusal, ArgErrors validation, b-strict shape,
  `last_author` stamping).

## Entry points

- **Chat turn start** - `src/lib/chat/loop.ts` fetches the index
  per turn, concurrently with the attachment inventory, and passes
  it to `buildMetadataSystemMessage`. Failure degrades to no
  section.
- **`skills` tool call** - the main model invokes the tool
  mid-turn; the venice function's `performToolCall` dispatches on
  the registered `ToolDef`, which routes on `op`.
- **The Skills drawer tab** - tab pick navigates
  `?drawer=skills`, lazy-mounts the panel and sidebar, and kicks
  the first listing load if the store has not fetched yet. The
  per-tab top bar reads **Skills** and carries one action, **All
  skills**, which clears an open detail back to the list (on the
  list surface it is a documented no-op, the Library upload
  button's shape).
- **Panel writes** - the user's create / edit / delete go through
  the facade (the session client, RLS in force) and stamp
  `last_author = 'user'`. No tool harness on the browser path.
- **Realtime relay** - an effect in `Chat.svelte` subscribes
  `subscribeToSkillChanges(userId, emitSkillChange)`, so
  server-side writes (the skills tool) and other devices' panel
  writes reach every open skills surface through the bus.

## Data model

- **`skills` table** (full definition in `supabase/schema.sql`).
  Columns: `id`, `user_id`, `name`, `description`, `body`,
  `last_author` (check `in ('user','assistant')`, default
  `'user'`), `created_at`, `updated_at`.
- **Unique `(user_id, lower(name))` expression index** - the
  natural key. One skill per user per case-insensitive name, and
  every name comparison (tool lookups, the panel's duplicate
  check) goes through `lower(name)`, never bare `name`. An inline
  unique constraint cannot hold an expression, so the index IS
  the constraint.
- **`touch_skill_updated_at` trigger** - stamps `updated_at` on
  every UPDATE. Skills are written from two surfaces (the panel
  and the server-side tool) and neither is trusted to set it, so
  the trigger is the single source of truth; the edge tool never
  stamps it and the browser slice's explicit stamp is consistency
  only.
- **RLS** - all four policies (select / insert / update / delete)
  are `auth.uid() = user_id`.
- **Realtime** - publication membership plus a UNIQUE replica
  identity index on `(id, user_id)` so DELETE events survive the
  realtime filter (the lesson the memories table learned
  retroactively; see `./memory.md` "Gotchas").
- **No embedding / claim / backfill machinery.** Search is ILIKE
  over name + description + body, honest while a personal skill
  store stays small. If stores ever grow to where a sequential
  scan per search is not, the appropriately shaped index is a
  pg_trgm GIN index - a new extension for this schema,
  deliberately not added now.
- **Char limits** - name 64 / description 300 / body 32000, plus
  the index caps (50 entries / 4000 chars). The body cap was set
  from a calibration read over 42 shipped real-world skill
  bodies (median ~7KB, p90 ~25KB): 32000 covers the full p90
  envelope with headroom for a genuinely dense skill, blocks the
  one-skill-doing-two-jobs class outright, and caps the one-shot
  on-demand load at roughly 8k tokens.

## Contracts

### The combination tool

One tool, not five verbs: a single `skills` tool with an `op`
enum discriminator (list / get / search / save / delete) plus
flat optional per-op parameters. This is the FIRST combination
tool in nak - every other toolbox member is a verb tool with its
own schema - and the pattern candidate for future features. It
is the design, not a fallback: a 2026-10-29 live calibration
against the serving backend (direct API calls, fake tool names)
found no tools-array cap (512 fake tools accepted, all 200s) and
the model composing `op` + params reliably under free choice,
unprompted. The measured cost is ~99 tokens per tool schema per
cache miss, with latency flat through ~69 tools. The enum form
was chosen over a `oneOf` variant form because both verified
working, but the enum schema is smaller on the wire and its
params stay individually describable.

Per-op required fields cannot be expressed in a flat JSON Schema
(the central validator has no per-branch view), so op-specific
validation routes through one `ArgErrors` pass in the edge
implementation, which collects every problem in a single round
trip; the schema's per-param descriptions carry the pairing so
the model rarely needs that round trip. Recorded in the wire
schema's header (`src/lib/tools/skills.schema.ts`).

### The description contract

A skill's description states WHEN the skill applies - a routing
hint, "use when ..." - and never what the skill does. The reason
is a cross-feature rendering contract: the per-turn index
presents each `name: description` line as data, not directives
(`buildSkillsIndexSection`'s framing line), so an
instruction-shaped description ("decides whether to research,
clarify, or answer") wastes the line and blurs the index's role.
Caught by the model itself in live use (2026-10-30, prod thread
24af4889): the write side originally said only "one to two
sentences on when to use this skill," which left room for the
model to blend a routing hint with an imperative summary of the
skill's behavior. Both write surfaces now name the contract -
the wire schema's `description` param tells the model the line
renders as data and that what the skill does belongs in the
body, and SKILLS_BLOCK's hygiene line carries the same rule -
pinned by test beats on both.

### Per-op semantics

- `op=list` - every skill's name, description, `updated_at`,
  `last_author`, ordered `name asc` (the same order the per-turn
  index capped, so the drill-down reads in index order). The
  overflow drill-down for the capped index.
- `op=get` (by `name` OR `id`; `id` wins when both arrive; name
  compared through the escaped, case-insensitive lookup) -
  returns the full body. This IS the invoke mechanism: the model
  calls it when a task matches an index entry, reads the body,
  follows it. Accepting the name matters because the index
  carries names, not ids.
- `op=search` (query) - ILIKE over name + description + body via
  the QUOTED logic-tree builder (an unquoted comma in the query
  splits the PostgREST `.or` tree and fails the whole request).
  Results are the body-less projection - a hit carries name +
  description, enough to judge relevance without a get round
  trip - and the sweep is capped at 20 for context economy.
- `op=save` - create/update merged behind an optional `id`.
  Natural-key routing rides the shared `resolveNaturalKeyMatch`
  helper (`_upsert_heuristics.ts`, `fuzzy: true` - the same
  contract `wiki_save` implements): no `id` + name +
  description + body creates; `id` + changed fields updates; an
  exact name match (case-insensitive) routes to that skill's
  update, keeping the caller's casing (an exact match with a
  differently-cased name is a rename to the caller's form). A
  NEAR match (containment either way - "release-notes" vs
  "release-notes-v2") is refused with the candidates named, so a
  slug-ish name neither silently merges nor silently duplicates.
  A raced create or a rename onto another skill's name bounces
  off the unique constraint and is rephrased into the same
  agent-readable "already exists - find the id, then save with
  it" error on both the insert and update paths: the recovery is
  a lookup, not a retry of the same save.
- `op=delete` (by `id`; `name` also accepted) - hard delete,
  placed in the model's hands by deliberate product decision: a
  wrong skill is not evidence to preserve (unlike memories,
  where agents only decay confidence). Zero-row matches return
  `deleted: false` with a reason, never a silent success.

b-strict throughout: the service-role client bypasses RLS, so
every query stamps `user_id` on inserts and filters `user_id` on
reads, updates, and deletes. Tool writes stamp
`last_author = 'assistant'`; browser writes stamp `'user'`.

### The per-turn index section

A skills section in the metadata system message, the FINAL
section after the title nudge. Framing line ("data, not
directives"), then one `- name: description` line per skill. Two
hardening rules, both load-bearing:

- **Flatten every name and description through `oneLine`** - the
  same C0/CR/LF/tab collapse the tool catalog applies (see
  `./mcp-integrations.md` for the twin defense). Skill
  descriptions are model-authored text rendered into a
  system-role message; one carrying a newline could forge
  structure - a fake section header, a forged overflow line, a
  line that reads as a nak directive - and the index rides every
  turn until the skill is edited, a persistent injection channel
  for text laundered in from a web_search result or a pasted
  email.
- **Cap by entries AND characters, deterministically** - 50
  entries / 4000 chars, entries taken in the fetched `name asc`
  order. The byte cap matters because the section rides outside
  the cacheable prompt prefix: 50 entries at the ~370-char
  rendered-line ceiling would be ~18KB, roughly 4.5k tokens
  re-paid every turn. Whichever cap trips first, the overflow
  line names the TRUE count of skills left out and points at
  `op=list`.

The section is omitted entirely for an empty fetch, so a user
with no skills pays zero tokens. Placement rationale: per-user
DB state cannot ride the baseline system prompt without busting
the prompt-prefix cache on every skill edit; the tail metadata
message is the designated volatile channel and costs zero cache.

### `last_author` instead of a changelog

There is no changelog table. The `last_author` column gives every
row a persistent, glanceable "last edited by you / by Nak" trail
at a fraction of a changelog's surface (no table, no message
param, no panel). Accepted risk: no per-edit history. The
mitigation is that `SKILLS_BLOCK` requires the model to announce
every create/update/delete in its reply - ephemeral, but the
audit trail for silent model edits is the follow-up changelog
pattern (`./memory.md` / `./wiki.md`) if that risk ever bites.

### Panel state and realtime precedence

The panel is a small state machine (the `skillsPanelSurface`
precedence list in `src/lib/ui/skills.ts`); realtime handling has
an ordering, applied after the bus event's refetch classifies
DELETE vs UPDATE:

1. **Realtime DELETE of the open skill wins over everything.**
   `detail` / `edit` / `confirm-delete` collapse to the list with
   a removed-elsewhere notice; the confirm strip is torn down
   first, which is the never-double-delete guarantee.
2. **Local edit state beats realtime UPDATE.** An open edit form
   is never clobbered; the local Save wins on submit (no version
   column - last write wins, same as every other nak panel).
   `cancelForm` refetches when the form closes, so the returned
   detail reflects current truth.
3. **Search filters the sidebar only.** A `detail` selection
   whose row falls outside the results stays open, with a
   clear-the-search hint.
4. A save from an open `edit` re-renders `detail` from the
   write's own returned row and patches the listing row - no
   refetch on the happy path.

## Interactions with other features

- **Chat** - `Chat.svelte` owns the `skills` drawer tab (the
  lazy-mounted `SkillList` / `Skills` pair sharing
  `skillsStore`), the per-tab top bar (Skills title + All-skills
  back action), and the realtime relay feeding the skill event
  bus. The chat loop fetches the per-turn index and passes it to
  `buildMetadataSystemMessage`. See `./chat.md`.
- **Tools** - the `skillsToolbox` (slotted after
  `libraryToolbox`) whose single member is the combo tool. One
  tool cannot be split across always-on plus a write toolbox, so
  its reads ride inside it and toolbox membership is catalog
  grouping only. See `./tools.md` "The write toolboxes".
- **Prompt augmentation** - the skills index is the final section
  of the metadata message, after the title nudge; the section
  list and ordering contract live there. See
  `./prompt-augmentation.md`.
- **Wiki** - the save op's natural-key routing and near-match
  refusal ride the SAME `resolveNaturalKeyMatch` helper
  `wiki_save` uses (`_upsert_heuristics.ts`), so the two
  features cannot drift on what "same name" means. See
  `./wiki.md`.
- **Frontend organization** - the `.svelte` files are
  composition-only; every display decision lives in the
  `src/lib/ui/skills*.ts` primitives. See
  `./frontend-organization.md`.
- **Components** - the `SkillList` sidebar entry. See
  `./components.md`.

## Gotchas

- **The per-row param survives an account switch.** `signOut()`
  never touches `route` or the URL, so `?skill=<id>` (like
  `?memory=` and `?wiki_article_id=` before it) outlives a
  sign-out and lands in the next account's tab, where RLS makes
  the id read as a missing row and the panel falls to the list
  with a not-found notice. Pre-existing parity across every
  per-row param, not a regression this feature introduced; the
  fix, if ever wanted, is cross-cutting.
- **The index is built once per turn.** The loop fetches the
  skills index at turn start; a skill saved mid-turn (by the
  model or another device) lands in the index on the FOLLOWING
  turn - the same accepted staleness shape as the title nudge.
- **The classification listener double-fires on panel writes -
  benign.** A panel save emits `emitSkillChange` directly AND
  lands a realtime event the Chat relay forwards, so the panel's
  bus listener runs twice for one write. Both runs are
  idempotent refetches that land identical data; the emit is
  deliberately last in the save handler so the first run reads
  consistent post-save state. Do not "fix" this by suppressing
  one leg - the direct emit covers the window before realtime
  delivers.
- **The `sidebar-search-input` class is load-bearing, not
  cosmetic.** `src/lib/ui/sidebar-search-focus.ts` duck-types
  that class name to collapse the mobile drawer nav so the search
  input clears the on-screen keyboard. A new sidebar search
  without the class regresses mobile keyboard overlap with no
  failing test.
- **The reflection sweep has no skills awareness - a stated
  preference can land twice.** The chat model saves a task
  format as a skill, and the reflection sweep reading the same
  settled thread can ALSO write it as a memory (reflection's
  prompt knows nothing about skills). Harmless while the two
  agree; the drift risk arrives when a skill is later honed - the
  memory keeps the old format and can surface via recall
  contradicting the current skill body. The model-facing
  mitigation is structural: a skill is explicit current
  instructions, a recalled preference memory is context, and
  SUBCONSCIOUS_BLOCK's override framing covers stale expectations
  - but if the contradiction ever confuses turns in practice, the
  hardening options are teaching the reflection prompt that task
  formats live in skills (skip or cross-reference instead of
  duplicating), or a SKILLS_BLOCK line that a skill outranks a
  recalled preference memory. Deferred until observed, not
  speculatively.

## Where to go next

- `docs/user/skills.md` - the user-facing version of the same
  story.
- `./tools.md` - the registry the combo tool plugs into, and the
  write-toolbox contract.
- `./prompt-augmentation.md` - the metadata message's section
  list and ordering contract.
- `./wiki.md` - the sibling both-user-and-model content store,
  and the shared natural-key helper.

# Grocery remodel: products + list entries, then auto-sectioning

Status: OPEN. Milestone 1 not started. When a milestone lands,
graduate its durable content into
[`../grocery-list.md`](../grocery-list.md) and update the Status
line; when both land, retire this doc per the in-progress rules in
CLAUDE.md.

Read [`../grocery-list.md`](../grocery-list.md) first; this plan
assumes its vocabulary (the recipe bridge, the sticky prefs
trigger, the shopping-trip window, the acquired history).

## SYNOPSIS

Split `grocery_items` into a durable product catalog and a
transient list-membership log, then add LLM auto-sectioning (a
small non-reasoning model files new items into the user's own
store sections) on top of the cleaned-up model.

## PURPOSE

The grocery feature conflates two domain objects in one table. A
`grocery_items` row is simultaneously the durable identity of a
product ("corn, canned, canned-goods aisle, photo") and the
transient state of a list entry ("do I need it right now; did I
buy it"). Every recent design conversation ran into a fight that
traces back to that conflation:

- `needed = false` means "bought" (the acquired history and the
  add-input's suggestion corpus) but un-planning a recipe
  ingredient also needs a "not on the list" state - same
  field/value, two meanings.
- Deleting a row destroys section/note/photo memory, which is why
  `grocery_section_prefs` exists: a name-keyed side-memory
  compensating for rows that die too easily. Name-keyed means it
  can hold only ONE section per name, so it cannot represent
  "canned corn vs fresh corn vs frozen corn" - and a section
  learned in one recipe's context silently wins the name for every
  future context.
- `section_id = null` means both "deliberately filed in Other" and
  "not yet classified".
- The In-cart membership during a shopping trip is derived from
  `updated_at`, which means "row changed", not "acquired" - the
  documented gotcha where editing an old item mid-trip fakes it
  into the cart.
- `count` / `unit` freeze one add's quantity into the durable row,
  though quantity is per-add and not part of identity.

The product's design intent (user-confirmed): items are unique by
label PLUS details (provenance, note, section, photo), variants
live forever, and section corrections are manual edits to the
specific variant. Amount never affects identity.

## DESCRIPTION

### The new model

**`grocery_products`** - the catalog. One row per variant; lives
forever; carries everything that makes a variant itself:

- `id`, `user_id`, `name`, `note`, `section_id` (null = Other /
  unfiled), `image_id`, `recipe_id` (null = standalone),
  `created_at`, `updated_at`.
- `section_source text` with `check (section_source in
  ('user', 'auto'))`, null = unfiled. Disambiguates the
  section_id-null overload: the classifier may only touch rows
  whose `section_source` is null, and a user edit stamps `'user'`,
  which nothing overwrites.
- Recipe products are effectively unique per
  `(recipe_id, normalized name)`; standalone products are
  deliberately unconstrained so same-name variants coexist.

**`grocery_list_entries`** - list membership as events:

- `id`, `user_id`, `product_id` (FK, `on delete cascade`),
  `count text`, `unit text`, `added_at`,
  `acquired_at` (null = on the list now).
- On the list = an open entry (null `acquired_at`) exists for the
  product. Buying stamps `acquired_at`. Un-checking a recipe
  ingredient deletes the open ENTRY; the product row (the memory)
  survives, and nothing fake enters purchase history.
- In-cart during a trip = entries with
  `acquired_at >= trip start`. Exact; the `updated_at` gotcha
  dies.
- Quantity rides the entry, so a recipe's cooklang qty is captured
  at check-time and amount changes never touch identity.
- The acquired history becomes a real purchase log - one row per
  buy - instead of "the row exists with a flag".

**Retired: `grocery_section_prefs`** and its three triggers. The
product rows ARE the memory. The learned sections already live on
filed rows, so dropping the prefs data loses almost nothing.

### Semantics changes riding the remodel

- **Recipe uncheck** deletes the open entry, not the product.
  Re-checking finds the product by `(recipe_id, normalized name)`
  and opens a new entry.
- **Recipe-edit invalidation** narrows: on a `cooklang` change,
  delete only the recipe's PRODUCTS whose normalized name no
  longer parses out of the new source (entries cascade). Renamed
  ingredients drop; amount-only edits keep everything. The trigger
  lives in Postgres but the cooklang parser is TypeScript, so the
  trigger extracts ingredient names with a SQL regex over the
  cooklang `@`-syntax (duplication against a stable external spec,
  not against our code) and a vitest guard runs the same regex in
  JS against `parseCooklang` output across sample recipes so drift
  fails the gate.
- **Suggestion corpus** (the panel add-input) becomes manual-only
  (`recipe_id is null`): recipe variants are managed from their
  recipe, and their names are poor evidence without the recipe's
  context.

### Auto-sectioning (milestone 2)

- `src/lib/grocery-section-agent.ts`: prompt assembly (the user's
  section list, manual-only example items capped per section,
  optional recipe context), the non-streaming `complete()` call
  through the venice proxy, response validation, conditional save.
- New `AGENT_MODELS` slot `grocerySection` ->
  `mistral-small-3-2-24b-instruct`: classification over evidence
  in context wants a fast non-reasoning instruct model (see
  CLAUDE.md "Venice sub-completions"), and the webSearch
  convention of one slot per surface lets it be retuned alone.
  Explicit `maxTokens` with headroom; check `finish_reason`; any
  parse/validation failure fails closed (row stays unfiled).
- The call is fire-and-forget AFTER the insert - adds stay
  instant; the item lands unfiled and hops into its section when
  the call returns. The save is conditional on
  `section_source is null` so a concurrent manual filing wins.
- Recipe adds classify automatically with the recipe title +
  cooklang source as context; "Add all" batches every unfiled
  ingredient into ONE call returning a name-to-section map. The
  ingredient checkbox renders a spinner while its classification
  is in flight.
- Standalone adds choose per-add in the suggestion dropdown:
  - `Add "corn" (Other)` renders whenever the query is non-empty
    (Enter triggers it) - instant, unfiled, no model call. Also
    the path for creating a new variant of an existing name.
  - `Add "corn" (Auto)` joins it only when no existing product
    matches the name - auto on an existing name would just guess
    between variants.
  - Existing variants list above the pair with their section name
    in grey; picking one revives that specific product.
  The sidebar's unmatched-search Add gets the same pair.

### Migration / backfill

`supabase/schema.sql` is re-applied start-to-finish on every sync,
so everything is idempotent (`if not exists`, guarded `do` blocks).
The backfill is a one-time transform guarded on the old table's
existence, so fresh installs skip it entirely:

1. Create the two new tables, RLS, indexes, realtime publication
   members with `(id, user_id)` replica-identity indexes.
2. If `grocery_items` exists (in `information_schema`): insert
   products from its rows (name, note, section_id, image_id,
   recipe_id; `section_source = 'user'` where `section_id` is not
   null - it was user-chosen or pref-inherited, both user-shaped);
   one entry per row carrying its count/unit - open for
   `needed = true`, else `acquired_at = updated_at` (the best
   available purchase timestamp); then drop the old table.
3. Drop `grocery_section_prefs` + its triggers unconditionally
   (`drop ... if exists`).
4. Repoint the image-GC RPCs at `grocery_products.image_id`.

### Milestones

**M1 - the remodel** (one PR): schema + backfill; rewrite the data
layer (`src/lib/supabase/grocery.ts`), store, and both surfaces on
the product/entry vocabulary; recipe-bridge semantics changes
(uncheck deletes the entry; name-aware invalidation); suggestion
corpus goes manual-only; GC repoint; tests; dev + user doc
updates; QA use-case re-run (baseline first, per
[`../../qa/README.md`](../../qa/README.md)). No LLM anywhere -
behavior otherwise mirrors today.

**M2 - auto-sectioning** (one PR): the agent module + model slot,
the (Other)/(Auto) pair on both add surfaces, grey section labels
on suggestions, the checkbox spinner, recipe-batch classification.
Docs + QA use-case for the classify flow.

### Notes

- The permanent "Other" pseudo-section stays `section_id = null`;
  undeletable/unrenamable by construction, unchanged.
- Prefs-era behavior "explicitly filing back to Other deletes the
  preference" has no analogue: filing a product to Other is just
  `section_id = null, section_source = 'user'`.
- One consequence of "(Auto) only on unmatched names": once any
  variant of a name exists, new variants are created via (Other) +
  manual filing. Accepted.
- The cloud sandbox has no browser; UI verification for both PRs
  leans on the gate plus explicit "not visually verified" flags in
  the summaries, per CLAUDE.md.

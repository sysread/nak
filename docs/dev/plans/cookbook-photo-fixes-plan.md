# Cookbook Photo Fixes Plan

Status: REV 3 - CONSENSUS (three fresh-context review rounds; round 3
reported no blockers, both audits PASS, and its prescribed edits are
folded in verbatim - that fold is the only unaudited revision).
Fix session for the verified cookbook defect batch (bug-intake
coordinator guard-5-00021, session cookbook-photo-fixes). All
citations verified against current `origin/main` at `5eee96fa`
(worktree fast-forwarded from detached `ce0926d9` 2026-11-03).

Read [`../../dev/cookbook.md`](../cookbook.md) and
[`../../dev/file-storage.md`](../file-storage.md) first: this plan
touches the recipe photo upload path, the `recipe-images` Storage
bucket's RLS, and the plain-text export renderer.

## SYNOPSIS

Four verified defects, one fix session:

1. (MEDIUM) The edit form's Save button is not disabled during
   in-flight photo uploads, even though the code comment and the QA
   use case both promise it is.
2. (HIGH blast radius, LIVE ON PROD) The `recipe-images` Storage
   bucket has no UPDATE policy on `storage.objects`, but uploads use
   `upsert: true` - so ANY re-upload of already-stored bytes takes the
   UPDATE path, RLS-fails, and leaks the raw Postgres error string
   into the UI. A content-addressed store whose docstring claims
   idempotence; the claim is falsified.
3. (LOW, product call) The plain-text export emits a literal
   `== Instructions ==` line when a recipe section is NAMED
   "Instructions" - the section marker collides with the block header
   directly above it.
4. (DOC) The QA use case describes the empty "What changed?" gate as
   an app inline error; the real mechanism is the browser's native
   required-field validation (the app-level fallback is reachable
   only for whitespace-only input, which native validation does not
   trim).

Scope addition proposed by the pre-mortem lens (coordinator approves):
the `grocery-item-images` bucket has the IDENTICAL defect (see
"Adjacent defect discovered" below). This plan proposes to fix its
missing policy in the same schema edit, and nothing else about the
grocery path.

## Decisions (resolved scope, so a future session does not re-litigate)

- **Defect 2 is fixed in three layers** (policy + dedup + error
  mapping), per the coordinator's dispatch. The policy layer is
  deploy-safe on its own: adding an RLS policy has no frontend
  dependency.
- **Defect 3 shape (proposed, coordinator approves)**: suppress the
  `== ... ==` marker ONLY in the collision case (bucket name exactly
  equals the block header "Instructions"). Genuine sub-sections keep
  their markers; the markers are deliberate and test-pinned for real
  sub-sections (rationale recorded in commit `ba2460261`: AnyList
  paste compatibility). Markdown export is untouched.
- **HTML and TOC surfaces are OUT of scope for defect 3.** They nest
  the same name non-adjacently and hierarchically
  (`<h3>Instructions</h3>` then `<h4>Instructions</h4>`,
  src/lib/cooklang-render.ts:751 and :763-765; the TOC likewise,
  :862-866), so the hierarchy disambiguates them; no doubled
  adjacent line. Only the plain-text export emits the two lines
  back to back.
- **Defect 4 is doc-only.** No code change; the app-level fallback in
  `recipeSaveError` stays as defense in depth.
- **Grocery scope (RESOLVED by coordinator ruling 2026-11-03)**: the
  `grocery-item-images` UPDATE policy is INCLUDED in the same schema
  edit - identical defect class, one-block idempotent fix, and the
  pin test covers BOTH content-addressed buckets. The grocery UI's
  error mapping / pick dedup is OUT of scope: the policy makes
  re-uploads succeed, so that error path becomes mostly unreachable.
  The one raw-leak site is recorded under Known issues.
- Error copy stays VISIBLE: a failed upload must still surface an
  error line under the photo grid; nothing is swallowed.

## Known issues (documented, not fixed)

- src/components/Groceries.svelte:473 leaks a raw storage/RLS error
  string for grocery photo uploads. With the grocery UPDATE policy
  landing, the re-upload path that triggers it mostly disappears; if
  a raw-string leak ever shows elsewhere in the grocery UI, that is
  a future pass (coordinator ruling: documented-but-not-fixed).

## PROBLEM

### Defect 1: Save not disabled during upload

The comment above the state declaration promises the binding:

> True while a photo upload (downscale + sha256 + upsert) is in
> flight. Save is disabled while this is true so the user can't
> submit a stale draft that's missing the in-flight photo.
> (src/screens/Cookbook.svelte:241-243)

But the submit button reads only `saving`
(src/screens/Cookbook.svelte:2190: `disabled={saving}`), so during an
upload the button is enabled. The submit handler DOES block the save
(`recipeSaveError` returns 'Wait for photo uploads to finish before
saving.' when `photosUploading` - src/lib/ui/cookbook-screen.ts:162-164,
called from `onSave` at src/screens/Cookbook.svelte:432-446), so the
user sees an inline error instead of a disabled button. The QA use
case promises the disabled behavior
(docs/qa/use-cases/cookbook-recipe-lifecycle.md:129-130: "`Save` is
disabled while an upload is in flight"). The Add-photo button already
disables during upload (src/screens/Cookbook.svelte:2085), so the
pattern exists in the same file.

State that exists: `photosUploading` at
src/screens/Cookbook.svelte:244 (`$state(false)`), set true at :565,
reset in the `finally` at :622-624.

Archaeology note (why the comment lies): the `disabled={saving}`
binding predates photos entirely (commit `ab22cbd47`, the original
Cookbook). Commit `a49dd52d` ("Add photos to recipes") added the
`photosUploading` state, the promising comment, and the Add-photo
binding - but never touched the Save button. No record states why;
the comment was false on the day it was written.

### Defect 2: missing UPDATE policy + upsert re-upload RLS failure

The `recipe-images` bucket gets exactly three `storage.objects`
policies - select ("recipe-images bucket is self-readable",
supabase/schema.sql:2919-2925), insert ("...self-writable", :2927-2933),
delete ("...self-deletable", :2935-2941). No UPDATE policy exists (and
no `for update` policy on `storage.objects` exists anywhere in
schema.sql - verified by grep across all five buckets).

The upload uses `upsert: true`
(src/lib/supabase/cookbook.ts:600-601):
`client.storage.from('recipe-images').upload(path, bytes, {
contentType: mimeType, upsert: true })`. Supabase Storage maps an
`upsert` upload onto INSERT when the object is new and UPDATE when the
object already exists (external behavior; the QA baseline repro below
observes it directly). The key is content-addressed -
`<user_id>/<sha256>` (src/lib/supabase/cookbook.ts:598-599) - so the
same image bytes always map to the same object key. Therefore every
re-upload of already-stored bytes takes the UPDATE path with no policy
covering it, and RLS refuses it.

The failure surfaces raw: `uploadRecipeImageObject` throws
`new SupabaseError(error.message)` verbatim
(src/lib/supabase/cookbook.ts:602) - the Postgres string 'new row
violates row-level security policy'. `onPickPhotos`'s catch prepends
the filename (src/screens/Cookbook.svelte:615-619:
`` `${file.name}: ${errMsg(err)}` ``), so the user sees
"<filename>: new row violates row-level security policy".

Blast radius: not just two identical files in one pick. ANY re-add of
the same photo across edit sessions re-uploads the same bytes to the
same key. The docstring claims the opposite
(src/lib/supabase/cookbook.ts:586-588: "Idempotent (upsert:true), so a
re-upload of the same image is a harmless overwrite"). Archaeology
(cit: commit `99bfbec7`, PR #224, 2026-05-30): the docstring, the
bucket, the three policies, and the upsert flag all landed in ONE
commit that "mirrored the attachments migration" - where the
three-policy shape is safe because those buckets use row-id keys with
distinct keys per re-upload. The mirror was applied without adapting
for the content-addressed key. The DB-level dedup
(`recipe_image_upsert`'s `(user_id, sha256)` unique key,
supabase/schema.sql:~3156) runs AFTER the storage upload, too late to
prevent it.

The link-table hazard is covered server-side: `recipe_attach_photos`
skips duplicates explicitly ("if the same image is already on this
recipe, attaching it again is a no-op rather than a primary-key
violation", supabase/schema.sql:~3885-3895), and
`recipe_version_images`' composite PK `(recipe_version_id, image_id)`
(supabase/schema.sql:2943-2969) makes double-linking impossible. The
frontend dedup below is a UX guard (skip the redundant upload, tell
the user), not a correctness dependency.

### Adjacent defect discovered: `grocery-item-images` (same class)

Pre-mortem lens finding, verified: the `grocery-item-images` bucket
(supabase/schema.sql:4508-4542) is content-addressed
(`<user_id>/<sha256>`, comment at :4514-4515), has the same
three-policy block with no UPDATE (:4520-4542), and its upload in
src/lib/supabase/grocery.ts:627-632 uses `upsert: true` with a
docstring claiming idempotence (:612-617). The consumer is reachable
today: Groceries.svelte `onPickPhoto` (:447-479) uploads on every pick
and its catch (:473) leaks the raw RLS string, same shape as the
cookbook defect. `wiki-record-files` (the bucket the draft had
mis-cited) is at supabase/schema.sql:13432-13455 and IS safe: row-id
keys (`<user_id>/<file_id>/<filename>`, :13372), so re-uploads get
distinct keys and never take the UPDATE path.

This plan proposes: add the `grocery-item-images` UPDATE policy in the
same schema edit (same shape, same idempotence style). Everything else
grocery-side (error copy, dedup) routes to a follow-up - the
coordinator decides.

### Defect 3: plain-text export doubles the Instructions header

`recipeToPlainText` emits the block header `Instructions`
(src/lib/cooklang-render.ts:952), then, for each section bucket, the
marker `` lines.push(`== ${bucket.name} ==`) `` (src/lib/cooklang-render.ts:966).
When a recipe section is named "Instructions" the output contains:

```text
Instructions
== Instructions ==
1. ...
```

The `==` markers for genuine sub-sections are deliberate and
test-pinned (tests/cooklang.test.ts:641-642: the Instructions block
must contain `== Soup ==` and `== Finishing ==`; rationale in commit
`ba2460261`). The defect is only the name-collision case. The markdown
export renders proper headings and is untouched by this defect.

### Defect 4: use case misdescribes the empty-save gate

The "What changed?" textarea is `required`
(src/screens/Cookbook.svelte:2182) and the edit form has no
`novalidate` (src/screens/Cookbook.svelte:1974: `<form
class="cookbook-edit" onsubmit={onSave}>`). The browser's native
constraint validation refuses to submit an empty required field with
its own bubble, so the app-level fallback
('Describe what changed before saving.',
src/lib/ui/cookbook-screen.ts:161) is unreachable on the click path
for a truly empty field. One edge: native validation does not trim,
so a WHITESPACE-ONLY message passes it; `onSave` then trims to empty
(:437) and the fallback fires - which is exactly why the fallback
stays as defense in depth. The use case says "`Save` is blocked with
an inline error until `What changed?` is non-empty"
(docs/qa/use-cases/cookbook-recipe-lifecycle.md:111-112) - wrong
mechanism for the empty case.

## APPROACH

### Fix 1: disable Save during upload (one line)

src/screens/Cookbook.svelte:2190:

```svelte
<button type="submit" class="primary" disabled={saving || photosUploading}>
```

The `recipeSaveError` guard stays (defense in depth - the handler is
the authority; the binding is the affordance). The comment at
:241-243 and the use case promise at
cookbook-recipe-lifecycle.md:129-130 become true as written; no
rewording needed there. The guard's `photosUploading` branch is
already unit-covered: tests/cookbook-screen.test.ts:175-179 ("blocks
saving while a photo upload is in flight"). svelte-check (in
`mise run check`) catches a typo'd binding.

### Fix 2a: add the UPDATE policy (recipe-images, plus the grocery twin)

supabase/schema.sql, after the insert policy block (after :2933),
mirroring the sibling shape, house idempotence style
(`drop policy if exists` + recreate, per the schema header's pattern):

```sql
drop policy if exists "recipe-images bucket is self-updatable" on storage.objects;
create policy "recipe-images bucket is self-updatable" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'recipe-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'recipe-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
```

USING gates which rows may be updated; WITH CHECK gates the new row
version. The key is content-addressed and never changes owner, so both
clauses carry the same self-prefix predicate (this `using` +
`with check` pairing matches the schema's table-level update-policy
convention, e.g. schema.sql:96 and :410). If the coordinator approves
the grocery addition, an identical block for `grocery-item-images`
follows right after (bucket name substituted).

No other bucket needs UPDATE: `documents`, `attachments`, and
`wiki-record-files` use row-id keys where a re-upload gets a distinct
key (docs/dev/file-storage.md:39-42; wiki-record-files verified at
schema.sql:13354-13437), so their uploads never take the UPDATE path.

Pin test (safe-to-modify dependency): the existing schema guardrail
tests never parse `storage.objects` policies (tests/schema-grants.test.ts
covers grant placement only; the missing policy passed every gate -
it is live proof of the gap). Add a NEW spec file
tests/schema-storage-policies.test.ts following the schema-grants
scanner idiom ("conservative scanner, not a SQL parser",
tests/schema-grants.test.ts:28-31 - schema-grants itself stays
grant-placement-scoped): every `storage.objects` policy for a
content-addressed bucket (`recipe-images`, `grocery-item-images`)
must exist for select/insert/update/delete, each carrying the
self-prefix predicate. This turns the whole defect class into a gate
failure.

Deploy: schema re-applies via the sync-supabase CI job on merge. For
local QA, re-apply with `mise run dev-sql < supabase/schema.sql`
(idempotent; coordinate the SERIALIZATION window with the coordinator.
Garrick owns turn-driving, which is a separate kind of window.)

After this lands, the docstring at src/lib/supabase/cookbook.ts:586-588
becomes true in its upsert half. Its "and the one-time migrate" half
is stale (the migrate caller is retired - grep finds no remaining
caller of `uploadRecipeImageObject` beyond the `upsertRecipeImage`
wrapper), so M1 trims the docstring to name only the live caller.

### Fix 2b: dedup in the pick loop

In `onPickPhotos` (src/screens/Cookbook.svelte:556-627), two guards:

1. **Intra-batch byte-identical files**: a batch-local
   `Map<string, string>` (downscaled-bytes sha256 -> imageId). After
   the sha is computed (src/screens/Cookbook.svelte:593; the storage
   key and the RPC both key on the DOWNSCALED bytes' sha - raw-file
   sha would neither match the key nor dedup two picks whose raw
   bytes differ in EXIF but downscale identically) and before the
   upload, a map hit reuses the imageId and skips the upload + RPC.
   The map is SET only after the RPC succeeds, so a failed upload
   never poisons the map. The map is deliberately BATCH-local, not
   session-scoped: a session map keyed by sha cannot be seeded from
   the recipe's stored photos (`RecipePhotoMeta` carries no sha -
   src/lib/supabase/types/cookbook.ts:124-128), so a cross-batch
   re-pick cannot know the sha matches until the RPC dedups; only
   the already-added imageId guard (below) covers cross-batch.
2. **Already-drafted image**: after the imageId is known (fresh or
   reused), if `draftPhotos` already holds that imageId, skip
   appending the draft and push a visible note to `photoErrors`:
   `` `${file.name}: this photo was already added.` `` ("already
   added" is deliberate wording - it covers both an intra-batch
   duplicate and a re-pick of a photo already on the recipe). A
   silent skip would read as the file being ignored. Scope verified
   by the pre-mortem lens: `draftPhotos` is cleared/reseeded per
   recipe on openEdit/openNew (Cookbook.svelte:397, :427), so the
   check cannot false-positive across recipes.

Pure-primitive dependency (safe-to-modify finding; the module's own
contract at src/lib/ui/cookbook-screen.ts:1-6 is "Pure functions
only - the screen composes these"): the dedup DECISION is a pure
primitive in src/lib/ui/cookbook-screen.ts, unit-tested in
tests/cookbook-screen.test.ts next to the `photoPickVerdict` block
(:246-296), e.g.

```ts
export function photoDuplicateVerdict(args: {
  name: string;
  imageId: string;
  photos: readonly DraftPhoto[];
}): { kind: 'append' } | { kind: 'skip'; note: string };
```

The loop change stays thin composition (map lookup, primitive call);
the `photoLinkPayload` projection (`{id, label}`,
src/lib/ui/cookbook-screen.ts:252) and `DraftPhoto` (:215) are
unchanged; `RecipePhotoMeta` carries no sha
(src/lib/supabase/types/cookbook.ts:124-128), so the imageId check
(post-RPC) is the authority and the sha map only short-circuits the
redundant upload within one batch.

### Fix 2c: friendly storage-error copy

New pure primitive in src/lib/ui/cookbook-screen.ts, following the
`photoDecodeErrorLine` sibling (:302-304: takes a filename, returns
the full display line - filename, colon-space separator, message):

```ts
export function photoUploadErrorLine(name: string, err: unknown): string
```

Behavior: when the error message contains 'row-level security',
return `` `${name}: could not upload photo. Try re-adding it.` ``.
All other errors pass through as today (`` `${name}: ${errMsg(err)}` ``) -
RPC validation messages are intentional copy, not leaks. The message
flatten (Error -> .message, String fallback) is inlined in the
primitive: `errMsg` is screen-local
(src/screens/Cookbook.svelte:281-283, whose comment anticipates a
`$lib` home "when justified") and Groceries.svelte has its own copy
(:319); promoting it would widen the diff into grocery surface, which
this session excludes. The catch at src/screens/Cookbook.svelte:615-619
calls the new primitive instead of building the line inline.
`console.error(err)` in the catch keeps the raw error diagnosable in
the browser console; the UI stays VISIBLE (the error line still
renders - nothing is swallowed).

Unit tests in tests/cookbook-screen.test.ts: RLS message maps to
friendly copy; non-RLS message passes through; filename prefix kept;
non-Error rejection values handled.

### Fix 3: suppress the marker only on collision

src/lib/cooklang-render.ts:965-967 becomes: emit the marker only when
`bucket.name !== 'Instructions'` (exact match with the block header
emitted at :952). A comment names the collision being avoided. Genuine
sub-sections keep markers; the existing pins at
tests/cooklang.test.ts:641-642 stay green unchanged. New test in
tests/cooklang.test.ts: a recipe with a section named Instructions
renders the block header once and no `== Instructions ==` line; a
sibling non-colliding section still gets its marker.

Case sensitivity: exact match only. A section named "instructions"
(lowercase) emits `== instructions ==`, which does not read as a
doubled header; widening to case-insensitive would eat a genuine
lowercase sub-section's marker for no visible win.

### Fix 4: reword the use case

docs/qa/use-cases/cookbook-recipe-lifecycle.md:111-112: replace the
"inline error" sentence with the true story - Save is blocked by the
browser's native required-field validation (a bubble on the `What
changed?` field). Qualify honestly: a whitespace-only message passes
native validation and still triggers the app inline error.

### Docs

- docs/dev/file-storage.md:25-26: "Each has three `storage.objects`
  RLS policies (select / insert / delete)" - reword to note the two
  content-addressed buckets (`recipe-images`, `grocery-item-images`)
  carry a fourth (update) because their same-key re-uploads via
  `upsert: true` take the UPDATE path. The doc's bucket table
  (:31-37) also never lists `grocery-item-images` and its heading
  says "The three buckets" while listing four - add the grocery row
  and fix the heading in the same edit, so the reworded sentence
  references a bucket the doc actually introduces.
- docs/dev/cookbook.md: extend the photo gotchas with one bullet:
  pick-time dedup (byte-identical files and already-added photos are
  skipped with a visible note) and the storage-error mapping. Keep it
  to the shape, not a mechanism tour.
- docs/user/cookbook.md:404-412 (photo editing section): add one
  sentence - picking a photo that was already added is skipped with a
  note, and a failed upload shows a friendly error line under the
  grid. (User-visible copy change; both-tier doc rule.)
- docs/qa/use-cases/cookbook-recipe-lifecycle.md step (7): add one
  expected clause for the duplicate-skip note (re-picking an
  already-added photo shows the note, adds no second thumbnail), so
  the new user-visible behavior has a repeatable check.

### QA plan

Use cases: cookbook-recipe-lifecycle.md (photo steps 7-8) and
cookbook-save-validation.md is NOT affected (validator flow,
untouched). Protocol: ZZQA-CB fixture prefix, singleton Playwright
browser via `playwright_browser_run_code_unsafe` with explicit
own-page selection from `page.context().pages()`, own Vite from this
worktree (`mise run dev-frontend`, free port), `http://[::1]` origin,
nak-local-config.json copied from /Users/jeff.ober/dev/nak for the
config-seeding step, dev@nak.local sign-in, delete only ZZQA-CB rows.
Photo QA needs NO chat turns (file upload + dev-sql / PostgREST
verification) - so no turn-driving window from garrick is required; a
SERIALIZATION window (shared-stack schema re-apply) is still requested
from the coordinator before any browser or dev-sql work.

- Baseline (pre-change, on this worktree at 5eee96fa + local schema
  re-apply): re-pick an already-stored photo via the UI, observe the
  raw RLS error (defect 2 repro; this also observes the
  Storage-maps-upsert-to-UPDATE behavior the plan asserts). Log the
  row.
- Post-change, UI path: fresh upload; INTRA-BATCH duplicate (two
  byte-identical files in ONE pick dialog) - one upload, one draft,
  no error; CROSS-BATCH re-pick of an already-added photo (a second
  Add-photo action) - the upload RUNS (the batch sha map is empty in
  the new call; the already-added guard fires only after the RPC
  returns the existing imageId), succeeds through the new UPDATE
  policy, and the skip note appears. This one action exercises BOTH
  Fix 2a (the re-upload succeeding where baseline RLS-failed) and
  Fix 2b (the visible note, no duplicate draft). Save-during-upload
  disabled button (defect 1); plain-text export collision check
  (defect 3: a recipe with an Instructions section exported via Copy
  plain text); the native-validation bubble (defect 4). Log the row.
- Post-change, POLICY path (belt-and-suspenders verifier for
  acceptance criterion 2, independent of UI dedup): from the page
  context, re-PUT the same object bytes to the same storage key via
  the storage REST endpoint with the signed-in user's token
  (PostgREST-style fetch per the QA memory: config + token from
  localStorage) and expect success - the exact request that
  RLS-failed at baseline. Log the row.
- Storage rows verified via `mise run dev-sql` (recipe_images +
  storage.objects agreement); delete only ZZQA-CB rows.

### Milestones

- M0: this plan committed to the branch; refined to consensus;
  coordinator approval (including the grocery-policy scope call). No
  code before approval.
- M1: defect 1 (one line) + defect 2a (policies, per coordinator's
  grocery call) + schema pin test + defect 2b (pure dedup primitive +
  thin loop composition) + 2c (error-copy primitive) + unit tests +
  docstring trim. `mise run check` green before commit.
- M2: defect 3 (collision suppression) + tests. Gate green.
- M3: docs (file-storage.md, cookbook.md dev + user, use-case
  rewording). Gate green.
- M4: QA baseline + post-change passes, results rows logged; diff
  summary + test results + QA rows messaged to the coordinator.
  Never declare done before the coordinator's review.

### Acceptance criteria

- Save is disabled while an upload is in flight (binding), and the
  handler guard still blocks if reached.
- Re-uploading already-stored bytes succeeds when exercised directly
  against the storage API (no RLS failure, no raw Postgres string
  anywhere in the UI).
- Two byte-identical files in one pick produce ONE upload and ONE
  draft; re-picking an already-added photo in a LATER pick shows a
  visible note and adds no duplicate draft (that redundant upload
  still runs and must succeed through the new policy; only the
  intra-batch duplicate is skipped pre-upload).
- A storage failure renders friendly copy with the filename prefix,
  and the failure remains visible.
- A recipe section named Instructions no longer doubles the header in
  the plain-text export; genuine section markers are unchanged; the
  pinned sub-section tests stay green.
- The use case describes the native validation bubble.
- Both doc tiers updated; `mise run check` green at every commit.
- The schema pin test fails if a content-addressed bucket's storage
  policies lose the update member or the self-prefix predicate.

## Risks and notes

- The UPDATE policy widens write access on the buckets: any
  authenticated user can update objects under their own top-level
  folder only - the same predicate the insert policy enforces. The
  content-addressed key makes the update a no-op overwrite of the
  caller's own bytes. Single-user app; risk accepted.
- Re-applying schema.sql on the shared local stack is idempotent but
  touches shared state - serialization window required (per the
  QA-protocol memory's stack-restart and serialization rules; NOT a
  turn-driving window).
- The Storage-maps-upsert-onto-UPDATE behavior is an external API
  contract asserted from Supabase's documented behavior, not from
  repo code; the QA baseline repro observes it directly before the
  fix depends on it.
- Deploy ordering has one reverse dependency: the cross-batch
  re-pick path (which lets the redundant upload RUN, then skips the
  draft) needs the new policy applied before the frontend ships, or
  the re-pick RLS-fails again. Moot under this repo's single
  schema+frontend deploy train (sync-supabase and Pages publish in
  one workflow run), noted for any future split.
- `recipe_image_upsert`'s DB dedup still runs after the storage
  upload; the intra-batch sha map only removes redundant uploads, it
  does not replace the RPC dedup.
- The function-side attach path (recipe_photos attach op) needs no
  frontend-style dedup: `recipe_attach_photos` skips duplicate image
  ids server-side (verified in the RPC body).

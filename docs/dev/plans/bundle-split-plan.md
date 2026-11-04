# Bundle split: main chunk under the 750 kB advisory - fix plan

Status: DONE - implemented and verified. Round 1 = deep-mode 7-lens
fan-out (evidence + consistency audits FAILed on premise wording and
figure units, all folded in). Round 2 = fresh reviewer: no blockers,
both audits PASS, all milestones CORRECT. Round 3 = fresh reviewer on
the coordinator-decision delta: no blockers, both audits PASS. M2
implemented @ d69679e0, M3 docs @ 496588c9; all verification steps
passed (results in the M2 section below; offline-pass row logged in
docs/qa/use-cases/offline-cache.md). Coordinator gate cleared
(cookbook-photo-fixes + sweep-validator-fixes landed 27d21fc6 /
44a03528). Branch based on **5eee96fa**; the four commits that landed
on main since touch none of this change's surface (verified by diff).
Awaiting coordinator diff review before landing.

## Decisions (resolved, do not re-litigate)

1. SCOPE = two vendor chunks only (vendor-supabase, vendor-svelte). The
   deferred alternatives stay listed below with their rationales - that
   is the record of why the modest shape is deliberate.
2. TWO NAMED CHUNKS, not one merged vendor: the families update on
   independent cadences, so a one-line dep bump re-downloads one family,
   not both. Independent hashing.
3. Acceptance evidence = a per-chunk before/after table (see M2 step 2).
4. The implementation gate stands: no M2 code until the coordinator
   confirms the two in-flight fix branches have landed.

The main JavaScript entry chunk is 882.51 kB minified (882,508 bytes; gzip
259.09) at this base (`dist/assets/index-cAGzcDIM.js`). The Rollup advisory fires on every build.
The chunk crossed 750 kB on 2026-06-28 and crept to 895 kB by 2026-11-02;
the tool-combo consolidation pulled it back ~13 kB. The growth is
distributed feature creep across the shared core.

Jeff approved splitting the bundle, not raising `chunkSizeWarningLimit`
(`vite.config.ts:184`).

## Measurement (what occupies the entry chunk)

Method: `NAK_BUNDLE_STATS=1 mise run build` (the visualizer is already a
devDependency, `vite.config.ts:282-291`), then parsed `dist/stats.html` per
module. The parser is `scratch/stats-parse.mjs` (gitignored scratch dir).

Units, stated once to prevent drift: the occupancy table below is in
**rendered kB** (post-transform, pre-minification; the chunk totals 2321.4
kB rendered vs 882.51 kB minified, factor ~0.38, so only proportions
matter). The lazy-chunk paragraph below and the baseline asset table in
premise 8 are in **minified kB** (build-output sizes as Vite prints them).
Both columns are decimal kB (1000 bytes per kB), matching how Vite prints
asset sizes and how the advisory threshold measures - 882,508 bytes prints
as 882.51 kB.

| group | rendered kB | share | notes |
|---|---|---|---|
| supabase-js family | 746.3 | 32% | auth-js 340.7, postgrest-js 124.5, storage-js 94.2, realtime-js 80.5, phoenix 52.7, supabase-js 23.0, functions-js 14.9, iceberg-js 15.5 |
| svelte 5 runtime | 241.2 | 10% | 66 files, framework internals only |
| Chat.svelte | 475.2 | 20% | the only big screen statically in the entry (`src/App.svelte:30`) |
| src/components | 172.3 | 7% | AssistantBody 19.7, ArtifactsList 12.8, TopicsFilter 10.8, ToolCalls 10.6, etc. |
| src/lib/supabase/ + supabase.ts | 185.2 | 8% | the data-layer facade modules |
| marked + dompurify | 104.2 | 4.5% | statically imported by `src/lib/markdown.ts:28-29` |
| src/lib/tools/ | 79.6 | 3.4% | tool schemas |
| src/lib/ui/ + chat/ + models/ + everything else | ~300 | ~13% | long tail |

Already lazy and NOT in the entry: pdf 476.82 kB, highlight.js core
114.17 kB (+ per-grammar chunks), katex (marked-katex-extension dynamic,
`src/lib/markdown.ts:123`), per-screen route chunks (Settings 83.97,
Cookbook 82.01, Wiki 70.66 kB...), per-doc chunks. The repo splits well;
the entry is the shared core.

Dependency provenance (verified in node_modules): `@supabase/phoenix` is a
dependency of realtime-js; `iceberg-js` is a dependency of storage-js. Both
ride in only because the supabase client does.

## Verified premises

1. `chunkSizeWarningLimit: 750` at `vite.config.ts:184`; the advisory does
   not fail the gate but must be grepped per CLAUDE.md ("Read the warnings").
2. Only TWO screens are statically imported in the entry: Chat.svelte
   (the big one, 475.2 kB rendered) at `src/App.svelte:30` and Setup.svelte
   (8.6 kB rendered) at `src/App.svelte:29`. Every other screen - 15 of
   them - uses the type-only lazy dynamic-import pattern
   (`src/screens/Chat.svelte:139-152`, `:319`).
3. `manualChunks` does not exist anywhere in `vite.config.ts` today.
4. The chunk-filename router (`vite.config.ts:138-174`) routes ONLY
   highlight.js grammars, docs markdown, and src/screens facades into the
   runtime-cached buckets (`assets/hljs/`, `assets/docs/`,
   `assets/screens/`; precache ignores them at `vite.config.ts:270-274`).
   Anything else - including any new vendor chunk - falls to
   `assets/[name]-[hash].js` and is precached.
5. `src/sw.ts` runtime-caches only the ignored buckets on first fetch
   (stale-while-revalidate); the Cookbook/Wiki precache exception is
   documented at `vite.config.ts:157-169`.
6. The supabase family is statically imported everywhere (no dynamic
   import of any @supabase module in src/), so folding it into a manual
   chunk cannot trip Rollup's "dynamically imported but also statically
   imported" split-defeating warning.
7. highlight.js, katex, marked-katex-extension, and pdfjs ARE dynamically
   imported - any manualChunks rule must NOT match them or it would drag
   the lazy graph back into an eager chunk.
8. Baseline asset table (5eee96fa, minified kB as Vite prints them):
   index-cAGzcDIM.js 882.51 (gzip 259.09), pdf-D35c9CSk.js 476.82
   (142.05), highlight-DAnaZ2sO.js 114.17 (37.39), Settings 83.97,
   Cookbook 82.01, Wiki 70.66, index-BdpFVF2I.js 259.78 - that second
   index chunk is the LAZY katex + marked-katex-extension graph (katex
   dominates), not the preload graph. Rest small. Precache: 75 entries,
   ~2862 KiB (byte-summed 2865.19; manifest count is the load-bearing
   figure). The rendered-total in the occupancy table is parser-dependent
   (2321.4 vs 2377.1 under decimal aggregation); proportions are exact
   and are what the plan consumes.

## Decision: vendor manualChunks, not code-motion splits

Evaluated and rejected:

- **Lazy-import the markdown render stack behind first assistant render**
  (marked + dompurify ~40 kB minified). Numerically dead on arrival for
  the advisory: 882.51 - 40 = ~842 kB, still over 750. It cannot meet
  acceptance even alone, and it puts a dependent fetch + an
  unrendered-markdown flash on the hottest render path in the app (every
  assistant message). Highlight.js and katex are already lazy (and katex
  already sits in its own lazy chunk, premise 8), which covers the heavy
  tail of markdown rendering.
- **Lazy-loading the supabase data layer** (dynamic-import the client
  facade). The data layer is needed by the auth bootstrap, realtime
  subscription, and the chat send path. Deferring it trades a waterfall on
  startup and on send for chunk size - exactly the failure mode the
  mission forbids.
- **Route-splitting Chat.svelte** (~180 kB minified). The lazy pattern
  exists and works for 15 screens, but Chat is the default screen: a
  dynamic import there makes first paint dependent-fetch the app's primary
  surface. Deferred as a follow-up if creep re-fills the entry; not
  needed to meet the acceptance.

Adopted: **selective `manualChunks` vendor split**. Zero code motion, zero
runtime behavior change, zero new waterfalls - the chunk is still
statically imported and loads in the same request fan-out (Vite emits
modulepreload for the entry's static graph). It changes chunk boundaries
and therefore the precache manifest, which is fine and expected: all
content-hashed, the prompt-mode SW update flow in `src/lib/update.svelte.ts`
is unchanged, and one such manifest-changing migration already shipped
clean through the banner flow when the bucket router landed (commit
`ec498742`). Bonus: vendor chunks change hash only when their dependency
graph changes, so app-only deploys stop re-downloading ~375 kB of
unchanged vendor code (283 + 92, the two M2 chunks) during PWA updates.

The rule is selective, not "all of node_modules": highlight.js, katex,
marked-katex-extension, and pdfjs are dynamically imported and must stay
out of any eager vendor chunk (premise 7).

## Milestones

### M1 - Plan (this commit)

Plan doc + measurement committed; coordinator review via refinement loop
before M2.

### M2 - vendor chunks in vite.config.ts

Add to `build.rollupOptions.output`, carrying the same rationale-comment
treatment the repo's other chunk-boundary code has
(`vite.config.ts:101-149`) - the comment must state the dynamic-import
exclusion rule and the selective-on-purpose reasoning:

```ts
manualChunks(id) {
  if (id.includes('node_modules')) {
    if (id.includes('/@supabase/') || id.includes('/iceberg-js/')) return 'vendor-supabase';
    if (id.match(/\/node_modules\/svelte\//)) return 'vendor-svelte';
  }
}
```

- `vendor-supabase`: ~283 kB minified (32% rendered share). Splits the
  single largest group out.
- `vendor-svelte`: ~92 kB minified (10%). Svelte runtime changes only when
  its dependency graph does (the svelte package plus whatever Rollup
  co-locates with it, currently esm-env); its hash is the most stable of
  all.
- Expected entry: ~882.51 - 375 = ~505 kB minified. Both vendor chunks far
  under 750. No chunk over 750 at all (pdf 477 is the largest lazy one).

Both land in the default precache bucket per the chunkFileNames fallthrough
(premise 4). Verification results (all executed 2026-11-03 on the local
stack, commit 496588c9+):

1. `mise run check` green, exit 0, zero eslint warnings.
2. Per-chunk acceptance table (minified kB, gzip in parens):

   | chunk | before | after |
   |---|---|---|
   | entry index | 882.51 (259.09) | 620.07 (183.26) |
   | vendor-supabase | - | 196.92 (51.79) |
   | vendor-svelte | - | 66.39 (25.07) |
   | pdf (lazy) | 476.82 (142.05) | 476.82 (142.05) unchanged |
   | biggest remaining lazy (katex graph) | 256.93 (77.35) | 256.93 (77.35) unchanged |

   Acceptance line: entry and both vendor chunks under 750; zero chunks
   over 750 anywhere; vendor hashes independent (separate manualChunks
   targets, confirmed as distinct files in the manifest).
3. Standalone build grep: the 750 kB advisory is GONE and there are NO
   `(!)` warnings of any kind - no split-defeating dynamic-import
   warnings (premise 6 held).
4. Both vendor chunk filenames appear in the generated precache manifest
   (dist/sw.js) and in dist/index.html's modulepreload list (the
   no-waterfall claim is checked, not asserted). They are NOT in
   assets/hljs, assets/docs, or assets/screens. Precache: 75 -> 76
   entries, 2862 -> 2411.86 KiB (the entry shrink dominates).
5. Preview smoke on [::1]:4173: app boots with ZERO console errors; a
   real chat turn rendered a markdown table (3 rows) and a fenced code
   block; Settings-reachable UI renders. No TDZ errors.
6. Scoped offline pass per offline-cache.md steps 3-4: offline reload of
   the app root renders the full shell from the new precache (zero
   dynamic-import failures); the LOCKED/SAVED OFFLINE wiki bucket and
   the FAVORITES recipe bucket list the marked records and both open
   offline. Results row logged in the use case.

### M3 - docs

`docs/dev/build-deploy.md` gains a chunking-structure subsection: the
bucket map (default precache vs hljs/docs/screens runtime cache), the
vendor chunks and their matcher rule with the dynamic-import caveat, a
note that worker bundles never see these `manualChunks` rules (workers
build through Vite's separate worker pipeline; this config's `worker`
block sets only `plugins` and `format`, `vite.config.ts:83-97`), which
is why the pdfjs worker and the svelte-rune-importing toolboxes are
unaffected, and the measurement
recipe (`NAK_BUNDLE_STATS=1`). Also fix the stale claim in
`docs/dev/testing.md:362-366` that a clean tree already trips the
chunk-size advisory - after this change it does not, and testing.md is
exactly the doc a future session greps before deciding whether a new
warning is theirs. `docs/user/` unaffected - no observable behavior
change.

## Acceptance

- Advisory stops firing: no chunk over 750 kB in the build output (pdf
  477 remains the largest lazy chunk, well under the limit).
- No new chunk over the limit, no waterfall added on first paint or on
  the chat send path (static imports only; no dynamic import introduced).
- `mise run check` green; no `(!)` build warnings beyond deliberate,
  documented ones.
- Precache bucket boundaries preserved (hljs/docs/screens stay
  runtime-cached; Cookbook/Wiki screens stay precached).
- docs/dev/build-deploy.md updated.

## Risks

- **Rollup manualChunks pitfalls**: splitting modules with circular
  imports across chunks can surface TDZ errors ("Cannot access ... before
  initialization"). Two directions, both covered: (a) vendor-to-src
  cycles - the supabase family imports nothing from src/, and the svelte
  runtime imports nothing from src/; both are leaf vendor graphs, the
  safe class. (b) Entry-to-vendor cycles via an UNMATCHED shared module -
  a node_modules dep that matches neither matcher (e.g. svelte's
  `esm-env`) could land in the entry while a vendor chunk needs it at
  module init, creating a chunk-level cycle. This is verified reality,
  not just theory: realtime-js and storage-js depend on `tslib` and
  realtime-js on `ws`, and neither matches either matcher - their chunk
  placement is Rollup's discretion (`ws` is Node-only and should
  tree-shake out of the browser graph; M2 verification includes
  confirming that in the emitted vendor-supabase chunk). If placement
  drifts, M2 step 5's preview smoke is the catcher. That smoke is
  REQUIRED for exactly this reason.
- **Chunk graph drift**: a future dependency change that makes something
  dynamic-import supabase would now emit a split-defeating warning - the
  gate grep makes that visible immediately.
- **Merge-conflict surface**: `vite.config.ts` plus two docs files; the
  most conflict-prone files (Chat.svelte, screens) are untouched, which
  is also why this branch goes last in the desk queue.
- **Rollback**: revert the single M2 commit (`git revert`) and rebuild -
  chunk boundaries return to the pre-split graph, precache manifest
  reverts on the next deploy through the normal prompt-mode update flow.
  No state to re-apply: the change is build-config only.

## Open questions for the coordinator

All resolved by the coordinator (chat 2058): scope approved
(vendor-chunks-only), two named chunks over one merged vendor, per-chunk
acceptance table. Remaining archaeology unknown, for Jeff if it ever
matters: git history shows manualChunks was never tried or discussed -
every prior size fix was code motion. If Jeff remembers a prior reason to
reject the vendor-chunk approach, the plan should hear it before M2; no
record exists either way.

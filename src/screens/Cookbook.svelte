<script lang="ts">
  /*
   * Recipe panel - inline recipe viewer. Three panes that share one
   * shell:
   *
   *   list   - empty/unselected state shown when no recipe is selected.
   *            The sidebar RecipeList component is the actual browse
   *            surface; clicking a recipe there sets route.recipe and
   *            mounts this panel on the detail pane. There is no
   *            explicit "deselect" gesture from the user side - the
   *            list pane appears on first load with no route.recipe,
   *            after a delete (the recipe is gone, we have to land
   *            somewhere), or via browser back / forward.
   *   detail - rendered Cooklang output + Copy + Edit + Delete.
   *   edit   - title / source / source_url / cooklang textarea form.
   *
   * Pane state is local ($state), not routed. route.recipe is the only
   * routed key: null means "nothing selected" (list/empty pane), non-null
   * means "show this recipe's detail". Closing a recipe is implicit -
   * pick another from the sidebar to navigate, or switch tabs to leave
   * the panel entirely. The shell-level onDeselect callback (see Props
   * below) opens the mobile drawer when this happens so the list is
   * reachable without a swipe.
   *
   * Data source is `cookbook.recipes` from the cookbook store (see
   * `src/lib/cookbook-store.svelte.ts`). We load on mount and listen
   * for `COOKBOOK_CHANGE_EVENT` so an LLM `recipe_save` call mid-
   * session refreshes the detail automatically.
   */
  import { app } from '$lib/state.svelte';
  import { route, navigate } from '$lib/routing.svelte';
  import {
    cookbook,
    loadRecipes,
    loadRecipePhotos,
  } from '$lib/cookbook-store.svelte';
  import { onCookbookChange } from '$lib/cookbook-events';
  import { getRecipeCached, offlineStatus } from '$lib/offline-sync.svelte';
  import {
    cooklangToHtml,
    parseCooklang,
    recipeToHtml,
    recipeToc,
    recipeToMarkdown,
    recipeToPlainText,
  } from '$lib/cooklang';
  import { MAX_RECIPE_COOKLANG_CHARS, MAX_RECIPE_TITLE_CHARS } from '$lib/recipe-limits';
  import {
    recipeSourceLine,
    recipeTocVisible,
    wrapIndex,
    swipeNavStep,
    isCommitAnimating,
    lightboxTrackStyle,
    photoOpenAriaLabel,
    LIGHTBOX_SLIDE_MS,
    type LightboxSlidePhase,
  } from '$lib/ui/recipe-detail';
  import {
    MAX_PHOTO_UPLOAD_MB,
    MAX_RECIPE_PHOTOS,
    bookmarkAriaLabel,
    bookmarkButtonTitle,
    editRecipeDraft,
    formatVersionDate,
    historySummaryLabel,
    modifyActionTitle,
    moveDraftPhoto,
    newRecipeDraft,
    photoDecodeErrorLine,
    photoLinkPayload,
    photoPickVerdict,
    ratingChangeMessage,
    recipeSaveError,
    resolveActiveRecipe,
    seedDraftPhotos,
    suggestedRevertMessage,
    trimmedOrNull,
    versionRowState,
    type DraftPhoto,
  } from '$lib/ui/cookbook-screen';
  import type { GroceryItem, Recipe, RecipeVersion } from '$lib/supabase';
  import { onGroceryChange, emitGroceryChange } from '$lib/grocery-events';
  import {
    groceryItemFromIngredient,
    normalizeGroceryName,
    partitionIngredientsForAdd,
    recipeCheckboxItemIds,
  } from '$lib/ui/grocery-list';
  import {
    arrayBufferToBase64,
    dataUrlFor,
    formatBytes,
    maybeDownscaleImage,
    sha256Hex,
    validateFile,
  } from '$lib/attachments';
  import RecipeRating from '../components/RecipeRating.svelte';

  interface Props {
    // When Chat.svelte's top-bar "new recipe" button flips this to true,
    // the panel opens the edit form for a new recipe and resets it.
    triggerNew?: boolean;
    // Fired when the user closes a recipe and the panel returns to the
    // empty/list state. The shell uses this to auto-open the sidebar
    // drawer on mobile so the recipe list (which lives in the drawer
    // on narrow viewports) is reachable without a swipe gesture.
    onDeselect?: () => void;
  }
  let { triggerNew = $bindable(false), onDeselect }: Props = $props();

  type Pane = 'list' | 'detail' | 'edit';
  // 'list' is the empty/unselected state shown when route.recipe is null.
  // route.recipe drives initial pane on mount and stays in sync via the
  // $effect below (browser back / forward, drawer navigation).
  let pane = $state<Pane>(route.recipe ? 'detail' : 'list');

  // --- detail / edit pane state ---
  let activeId = $state<string | null>(route.recipe);
  // The "All recipes" list is paginated, so the selected recipe may
  // live past the window the sidebar has paged in - reached via a deep
  // link or a navigation from a tool result rather than a click on a
  // loaded row. This holds a by-id fetch for exactly that case so the
  // detail pane resolves instead of falling back to the empty state.
  let fetchedRecipe = $state<Recipe | null>(null);
  $effect(() => {
    const id = activeId;
    if (!id || !app.supabase) {
      fetchedRecipe = null;
      return;
    }
    // Already in memory (browse window OR a cached Upcoming / Favorites
    // bucket) - no fallback fetch needed, and that copy stays
    // authoritative below. Offline this is the path that matters: the
    // recipe the user picked from the saved list lives in a bucket, not
    // in the (empty) browse window. `fetched: null` asks only "is the
    // id already in the loaded sets".
    if (
      resolveActiveRecipe(id, cookbook.recipes, cookbook.upcoming, cookbook.favorites, null)
    ) {
      fetchedRecipe = null;
      return;
    }
    // Read-through the offline cache: online it fetches + refreshes the
    // cached copy; offline it serves the cached row so a favorited /
    // upcoming recipe still opens with no network. getRecipeCached
    // never throws (it swallows the network error and falls back), but
    // keep the catch as a belt-and-suspenders against an IndexedDB
    // failure.
    let cancelled = false;
    void getRecipeCached(app.supabase, id)
      .then((res) => {
        if (!cancelled) fetchedRecipe = res.row;
      })
      .catch(() => {
        if (!cancelled) fetchedRecipe = null;
      });
    return () => {
      cancelled = true;
    };
  });
  // Store row wins when present - it's the freshest copy after an edit;
  // the by-id fallback only fills in when the row is outside the loaded
  // page window.
  const activeRecipe = $derived(
    resolveActiveRecipe(
      activeId,
      cookbook.recipes,
      cookbook.upcoming,
      cookbook.favorites,
      fetchedRecipe
    )
  );

  // --- edit pane draft state (shared across new + edit) ---
  let draftTitle = $state('');
  let draftSource = $state('');
  let draftSourceUrl = $state('');
  let draftCooklang = $state('');
  // Rating draft for the edit pane. Null = unrated; 1-5 set. Mirrored
  // into the form's RecipeRating component so both create and update
  // flows persist the rating in the same write as everything else.
  let draftRating = $state<number | null>(null);
  // Required "What changed?" note. Lands on a new row in
  // `recipe_versions` so the user (and the LLM) can scan past edits
  // by intent in the History panel. Validated non-empty before save.
  let draftChangeMessage = $state('');
  let editError = $state<string | null>(null);
  let saving = $state(false);
  let copyFeedback = $state<string | null>(null);

  // Working photo set for the edit pane - see DraftPhoto in
  // $lib/ui/cookbook-screen for the lifecycle (labels stay in memory
  // until Save so the History panel shows one row per overall edit).
  let draftPhotos = $state<DraftPhoto[]>([]);
  // True while a photo upload (downscale + sha256 + upsert) is in
  // flight. Save is disabled while this is true so the user can't
  // submit a stale draft that's missing the in-flight photo.
  let photosUploading = $state(false);
  // Per-photo error messages from the file-picker path (size cap,
  // unreadable image, RPC failure). Surfaced under the photo grid;
  // cleared on the next add or on save.
  let photoErrors = $state<string[]>([]);

  // Lightbox state for the detail-pane strip. `null` = closed; an
  // index = the photo at that position is being viewed full-size.
  // Click a thumb to open; Escape, click outside, or click the close
  // button to dismiss.
  let lightboxIndex = $state<number | null>(null);

  // --- history state (lazy per detail pane) ---
  // null until the first listRecipeVersions resolves; an empty array
  // afterwards if the recipe somehow has no versions (shouldn't happen
  // post-rollout, but we render a graceful empty state either way).
  let versions = $state<RecipeVersion[] | null>(null);
  let versionsLoading = $state(false);
  let versionsError = $state<string | null>(null);
  // null = viewing the live recipe; non-null = showing the snapshot for
  // that version id read-only with revert / back-to-current actions.
  let viewingVersionId = $state<string | null>(null);

  // Computed preview HTML for the edit pane. We debounce via derived —
  // Svelte only reruns when draftCooklang actually changes — so typing
  // in the textarea doesn't stall on large recipes. The parser is
  // synchronous and fast; even a 20 KiB recipe parses in single-digit ms.
  const editPreviewHtml = $derived(cooklangToHtml(draftCooklang));

  async function refresh(): Promise<void> {
    if (!app.supabase) return;
    await loadRecipes(app.supabase);
  }

  // Catch-block helper: surface the message from any thrown value
  // (Error or otherwise). Same shape repeats throughout the codebase;
  // local for now until a $lib home is justified.
  function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  // Lazy: only load history when the user actually opens a detail
  // pane. `cookbook.recipes[]` deliberately stays free of versions so
  // the bulk recipe-list fetch keeps its slim shape.
  async function loadVersions(recipeId: string): Promise<void> {
    if (!app.supabase) return;
    versionsLoading = true;
    versionsError = null;
    try {
      versions = await app.supabase.listRecipeVersions(recipeId);
    } catch (err) {
      versionsError = errMsg(err);
    } finally {
      versionsLoading = false;
    }
  }

  function clearVersionState(): void {
    versions = null;
    versionsError = null;
    viewingVersionId = null;
  }

  // URL-driven sync. Single source of truth for landing the local
  // pane+activeId on whatever route.recipe says: a sidebar click, a
  // browser back / forward, openList() after a delete, all flow
  // through here. Edit / new panes are intentionally not routed -
  // they're transient form states, not bookmarkable.
  $effect(() => {
    const id = route.recipe;
    if (id === activeId) return;
    if (id === null) {
      pane = 'list';
      activeId = null;
      editError = null;
      copyFeedback = null;
      lightboxIndex = null;
      clearVersionState();
      // Recipe was deselected. On mobile the list lives in the
      // drawer rather than a persistent column, so the shell auto-
      // opens the drawer here - otherwise the empty pane dead-ends
      // until the user swipes or taps the menu.
      onDeselect?.();
    } else {
      activeId = id;
      pane = 'detail';
      copyFeedback = null;
      lightboxIndex = null;
      clearVersionState();
    }
  });

  // Load versions + photos for whatever recipe the detail pane is
  // showing. Deliberately separate from the URL-sync effect above:
  // that effect early-returns when route.recipe already equals
  // activeId, which is exactly the cold-refresh case - activeId is
  // seeded from route.recipe at declaration (see the `let activeId`
  // above), so a hard reload of a detail URL short-circuits the sync
  // effect and the loads would never fire from there. Driving them
  // off activeId + app.supabase here lands the fetch both on
  // navigation and on a cold refresh, the latter once the Supabase
  // client finishes connecting (app.supabase is null for the first
  // beat of a refresh). Reads only activeId / pane / app.supabase, so
  // it runs once per recipe and once when the client lands - the
  // loaders mutate versions / cookbook.photos, which this effect does
  // not read, so there is no feedback loop.
  $effect(() => {
    const id = activeId;
    if (pane !== 'detail' || !id || !app.supabase) return;
    void loadVersions(id);
    void loadRecipePhotos(app.supabase, id);
  });

  // Photos linked to the recipe currently shown in the detail pane.
  // `undefined` = the cache slot has never been touched (we render an
  // empty strip placeholder until the load resolves). `null` = a load
  // is in flight. An empty array = loaded with no photos. The strip
  // hides itself entirely when the array is empty so a recipe with
  // no photos doesn't reserve dead space above the metadata.
  const activePhotos = $derived.by(() =>
    activeId ? cookbook.photos[activeId] ?? undefined : undefined
  );

  // --- pane transitions ---
  // Just clears the routed key; the URL-sync effect above runs the
  // pane-reset and onDeselect notification once route.recipe lands as
  // null. Keeping the cleanup in one place means a delete (the only
  // caller today) and a browser-back deselect both go through the
  // same code path.
  function openList(): void {
    navigate({ recipe: null });
  }

  function openNew(): void {
    activeId = null;
    // Clear the routed recipe too. Without this, opening "new" while a
    // recipe is already open leaves route.recipe pointing at the old
    // recipe; the URL-sync effect then sees route.recipe !== activeId
    // (now null) and immediately snaps activeId/pane back to that
    // recipe's detail view, so the new-recipe form never appears. A
    // brand-new unsaved recipe is correctly unrouted until the save
    // navigates to its id.
    navigate({ recipe: null });
    // Seed choices (Cooklang scaffold, unrated, default change
    // message) documented on newRecipeDraft.
    const seed = newRecipeDraft();
    draftTitle = seed.title;
    draftSource = seed.source;
    draftSourceUrl = seed.sourceUrl;
    draftCooklang = seed.cooklang;
    draftRating = seed.rating;
    draftChangeMessage = seed.changeMessage;
    editError = null;
    draftPhotos = [];
    photoErrors = [];
    pane = 'edit';
  }

  async function openEdit(): Promise<void> {
    const r = activeRecipe;
    if (!r) return;
    // Seed choices (empty-string sentinels for nullable fields, blank
    // change message) documented on editRecipeDraft.
    const seed = editRecipeDraft(r);
    draftTitle = seed.title;
    draftSource = seed.source;
    draftSourceUrl = seed.sourceUrl;
    draftCooklang = seed.cooklang;
    draftRating = seed.rating;
    draftChangeMessage = seed.changeMessage;
    editError = null;
    photoErrors = [];

    // Seed draftPhotos from the loaded photo cache. If the cache hasn't
    // resolved yet (rare - the detail pane fired the load on open and
    // edit usually opens after the user has been on detail for a beat),
    // wait for it before seeding so the draft doesn't start empty and
    // accidentally clear the photo set on save.
    if (cookbook.photos[r.id] === undefined && app.supabase) {
      await loadRecipePhotos(app.supabase, r.id);
    }
    const loaded = cookbook.photos[r.id] ?? [];
    draftPhotos = seedDraftPhotos(loaded);
    pane = 'edit';
  }

  async function onSave(e: Event): Promise<void> {
    e.preventDefault();
    if (!app.supabase) return;
    const title = draftTitle.trim();
    const cooklang = draftCooklang;
    const changeMessage = draftChangeMessage.trim();
    const validationError = recipeSaveError({
      title,
      cooklang,
      changeMessage,
      photosUploading,
    });
    if (validationError) {
      editError = validationError;
      return;
    }
    // Capture the recipe id and pane we started in. The save's
    // post-await tail compares against the current state to detect
    // whether the user navigated to a different recipe mid-save (a
    // sidebar click on mobile, browser back/forward, etc). If they
    // did, the route-sync effect has already loaded the new recipe
    // and switched pane='detail'; we leave their context alone
    // rather than ripping them back to the saved recipe. The
    // id-keyed RPC below has already landed by the time we look,
    // so the saved data is safe either way.
    const startedAt = activeId;
    saving = true;
    editError = null;
    try {
      const source = trimmedOrNull(draftSource);
      const sourceUrl = trimmedOrNull(draftSourceUrl);
      // Always pass the current draft photo set (with labels) to the
      // save - the version snapshot needs to capture photos alongside
      // the rest of the editable state. The RPC's
      // `p_set_image_ids=true` mode handles unchanged sets (re-link
      // the same ids), mutated sets (add/remove/reorder), AND label
      // edits the same way, so we don't diff against the prior state
      // in the client. Labels are kept in memory on `draftPhotos`
      // until this save fires so the user can type without each
      // keystroke landing a version row.
      const photos = photoLinkPayload(draftPhotos);
      let savedId: string;
      if (startedAt) {
        await app.supabase.updateRecipe(
          startedAt,
          {
            title,
            cooklang,
            source,
            source_url: sourceUrl,
            rating: draftRating,
            photos,
          },
          changeMessage
        );
        savedId = startedAt;
      } else {
        const row = await app.supabase.createRecipe(
          title,
          cooklang,
          source,
          sourceUrl,
          draftRating,
          changeMessage,
          photos
        );
        savedId = row.id;
      }
      // Cookbook list refresh is global - the saved recipe's row
      // may have shifted in the sort order regardless of where the
      // user has navigated. Always useful, so this runs before the
      // navigation gate below.
      await refresh();
      // The user can navigate to a different recipe mid-save. If
      // they did, leave them on whatever they navigated to - the
      // route-sync effect has already loaded that recipe's data
      // and set pane='detail'. Otherwise (still on the edit form
      // with the same activeId we captured) finish the save flow
      // normally: adopt the new id for create, reload per-recipe
      // state, flip to detail, sync the router.
      const stayedOnIt = pane === 'edit' && activeId === startedAt;
      if (!stayedOnIt) return;
      // Create flow lands us on a brand-new id; adopt it as the
      // active recipe. Update flow keeps the same activeId.
      if (startedAt === null) activeId = savedId;
      // Per-recipe reloads: History panel (so the just-saved
      // version is the latest entry) and photos (so the strip
      // reflects renumbered positions, deletions applied, and new
      // uploads appended). Parallel - they don't depend on each
      // other.
      await Promise.all([
        loadVersions(savedId),
        loadRecipePhotos(app.supabase, savedId),
      ]);
      pane = 'detail';
      photoErrors = [];
      // Reconcile the router so a refresh-from-here lands on this
      // recipe's detail. For create flow this writes the new id
      // into the URL; for update flow it's a no-op (the URL
      // already has this id).
      navigate({ recipe: savedId });
    } catch (err) {
      // Cross-recipe gate: if the user navigated away mid-save,
      // surfacing the error on whichever recipe they're now looking
      // at would be misattributed. openEdit clears editError on
      // entry, so a user returning to this recipe via Edit gets a
      // clean form - the catch path's banner is only useful if
      // they're still in this save's context.
      if (pane === 'edit' && activeId === startedAt) editError = errMsg(err);
    } finally {
      saving = false;
    }
  }

  // --- photo edit-pane handlers ---

  // Add user-picked files to the draft. For each:
  //   1. validate against the per-file size cap
  //   2. downscale via the same canvas helper the message-attachment
  //      composer uses (max 2048px on the long edge)
  //   3. base64-encode + sha256 the bytes
  //   4. upsert the image into the user's recipe-image library so we
  //      have a stable image_id to link
  //   5. append to draftPhotos
  // Errors per file land in `photoErrors` so a partial batch still
  // lets the good ones through. Sets `photosUploading` while the
  // batch is in flight so save is gated on completion.
  async function onPickPhotos(e: Event): Promise<void> {
    if (!app.supabase) return;
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0) return;
    photoErrors = [];
    photosUploading = true;
    try {
      for (const file of Array.from(files)) {
        // Pre-upload gates (photo cap, images only, size cap) live in
        // the verdict primitive; `cap` aborts the batch, `reject`
        // skips just this file.
        const verdict = photoPickVerdict({
          name: file.name,
          mimeType: file.type,
          sizeError: validateFile(file),
          draftCount: draftPhotos.length,
        });
        if (verdict.kind === 'cap') {
          photoErrors = [...photoErrors, verdict.error];
          break;
        }
        if (verdict.kind === 'reject') {
          photoErrors = [...photoErrors, verdict.error];
          continue;
        }
        try {
          const downscaled = await maybeDownscaleImage(file);
          if (!downscaled) {
            photoErrors = [...photoErrors, photoDecodeErrorLine(file.name)];
            continue;
          }
          const buffer = await downscaled.arrayBuffer();
          const base64 = arrayBufferToBase64(buffer);
          const sha = await sha256Hex(buffer);
          const imageId = await app.supabase.upsertRecipeImage(
            sha,
            downscaled.type,
            downscaled.size,
            base64
          );
          draftPhotos = [
            ...draftPhotos,
            {
              imageId,
              mimeType: downscaled.type,
              sizeBytes: downscaled.size,
              // We have the bytes in memory - render straight from a
              // data: URI, no signed-URL round-trip for a just-picked
              // photo.
              src: dataUrlFor(downscaled.type, base64),
              // New uploads start without a label; the user fills
              // the input below the thumb if they want a caption.
              label: '',
            },
          ];
        } catch (err) {
          photoErrors = [
            ...photoErrors,
            `${file.name}: ${errMsg(err)}`,
          ];
        }
      }
    } finally {
      photosUploading = false;
      // Clear the input value so picking the same file twice (e.g.
      // user removed it then changed their mind) re-fires `change`.
      input.value = '';
    }
  }

  function onRemoveDraftPhoto(index: number): void {
    draftPhotos = draftPhotos.filter((_, i) => i !== index);
  }

  function onMoveDraftPhoto(index: number, dir: -1 | 1): void {
    draftPhotos = moveDraftPhoto(draftPhotos, index, dir);
  }

  // --- lightbox ---

  // The lightbox is a 3-slide carousel: [prev | current | next]. The
  // track slides horizontally so a swipe can follow the finger and a
  // commit animates the neighbour into view. `slidePhase` drives the
  // track transform (see lightboxTrackStyle); `dragDx` is the live
  // finger offset during a drag.
  let slidePhase = $state<LightboxSlidePhase>('idle');
  let dragDx = $state(0);
  const lightboxTrackStyleStr = $derived(lightboxTrackStyle(slidePhase, dragDx));

  // Single-finger drag bookkeeping. A second touch is a pinch-zoom, so
  // we abandon the drag the instant it lands and never call
  // preventDefault - the browser's native zoom and scroll stay intact.
  let swipeStartX = 0;
  let swipeStartY = 0;
  let dragging = false;

  // Pending index swap at the end of a commit animation. Held so a
  // close (or recipe change) mid-slide can cancel it before it fires
  // and re-opens the lightbox on a now-stale index.
  let commitTimer: ReturnType<typeof setTimeout> | null = null;

  function clearCommitTimer(): void {
    if (commitTimer !== null) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
  }

  // Reset all carousel state to its resting shape. Called on open (so a
  // reopen never inherits a stale phase) and whenever the lightbox
  // closes (so a pending commit timer can't fire on a closed viewer).
  function resetSlideState(): void {
    clearCommitTimer();
    slidePhase = 'idle';
    dragDx = 0;
    dragging = false;
  }

  function openLightbox(index: number): void {
    resetSlideState();
    lightboxIndex = index;
  }

  function closeLightbox(): void {
    lightboxIndex = null;
  }

  // Tear down any in-flight slide whenever the lightbox closes, by any
  // path - close button, Escape, or the selected recipe changing out
  // from under it (which nulls lightboxIndex directly). Without this a
  // commit timer queued just before the close would fire and re-open
  // the viewer on a stale index.
  $effect(() => {
    if (lightboxIndex === null) resetSlideState();
  });

  // Page by `delta` with a slide animation, looping the photo set. The
  // track animates one slide over; LIGHTBOX_SLIDE_MS later we swap the
  // index and snap back to center - invisibly, because the slid-to
  // photo already fills the slot we land on. Shared by the arrows, the
  // arrow keys, and a committed swipe.
  function animateStep(delta: number): void {
    if (lightboxIndex === null || isCommitAnimating(slidePhase)) return;
    const photos = activePhotos;
    if (!Array.isArray(photos) || photos.length < 2) return;
    const target = wrapIndex(lightboxIndex, delta, photos.length);
    slidePhase = delta > 0 ? 'to-next' : 'to-prev';
    clearCommitTimer();
    commitTimer = setTimeout(() => {
      commitTimer = null;
      lightboxIndex = target;
      slidePhase = 'idle';
      dragDx = 0;
    }, LIGHTBOX_SLIDE_MS + 40);
  }

  // Ease an under-threshold drag back to center.
  function cancelDrag(): void {
    slidePhase = 'cancel';
    dragDx = 0;
    clearCommitTimer();
    commitTimer = setTimeout(() => {
      commitTimer = null;
      slidePhase = 'idle';
    }, LIGHTBOX_SLIDE_MS + 40);
  }

  function onLightboxTouchStart(e: TouchEvent): void {
    // Don't start a drag on top of a commit animation, and treat any
    // multi-touch as a pinch: snap to center so the image is square for
    // zooming.
    if (isCommitAnimating(slidePhase)) return;
    if (e.touches.length !== 1) {
      dragging = false;
      resetSlideState();
      return;
    }
    dragging = true;
    swipeStartX = e.touches[0]!.clientX;
    swipeStartY = e.touches[0]!.clientY;
  }

  function onLightboxTouchMove(e: TouchEvent): void {
    if (!dragging) return;
    // A second finger joining mid-drag is a pinch starting; abandon the
    // drag and snap to center so native zoom takes over cleanly.
    if (e.touches.length > 1) {
      dragging = false;
      resetSlideState();
      return;
    }
    const photos = activePhotos;
    if (!Array.isArray(photos) || photos.length < 2) return;
    dragDx = e.touches[0]!.clientX - swipeStartX;
    slidePhase = 'drag';
  }

  function onLightboxTouchEnd(e: TouchEvent): void {
    if (!dragging) return;
    dragging = false;
    const t = e.changedTouches[0];
    if (!t) {
      if (slidePhase === 'drag') cancelDrag();
      return;
    }
    const step = swipeNavStep(swipeStartX, swipeStartY, t.clientX, t.clientY);
    if (step === 0) {
      // Tap or too-short drag. Only animate back if we actually moved;
      // a clean tap leaves the phase idle and lets the click handler
      // (dismiss / button) run.
      if (slidePhase === 'drag') cancelDrag();
      return;
    }
    animateStep(step);
  }

  // Persist a rating change made on the detail pane. Click-to-rate is
  // a one-step gesture, so we don't ask the user for a change message;
  // we generate a parseable one ("Rated 4 stars." / "Cleared rating.")
  // that lands in the History panel like any other version. This
  // intentionally creates a version row - the user's request was
  // explicit on capturing the rating in the version log.
  async function onRateActive(next: number | null): Promise<void> {
    if (!app.supabase || !activeId) return;
    const r = activeRecipe;
    if (!r) return;
    if (r.rating === next) return; // no-op, also defensive vs. double-fire
    const msg = ratingChangeMessage(next);
    try {
      await app.supabase.updateRecipe(activeId, { rating: next }, msg);
      await Promise.all([refresh(), loadVersions(activeId)]);
    } catch (err) {
      // Surface failures in the same banner the edit pane uses; we're
      // on the detail pane and don't have a dedicated rating-error
      // slot, but editError is already in scope and visible if the
      // user opens edit afterward. For the read-only rating row we
      // also fall through silently rather than rolling back the
      // optimistic stars - the next refresh will reconcile from the
      // store.
      editError = errMsg(err);
    }
  }

  // Toggle the recipe's "upcoming" bookmark - the user's mark for the
  // current grocery-shopping cycle. Goes through the dedicated
  // setRecipeUpcoming path so the update bypasses recipe_versions
  // (workflow state, not content) and leaves updated_at alone (a
  // toggle shouldn't bump the recipe to the top of the recency sort).
  // We refresh the cookbook store afterward so the drawer's Upcoming
  // section and the row's cart glyph reflect the new state on the
  // next animation frame.
  async function onToggleUpcoming(): Promise<void> {
    if (!app.supabase || !activeId) return;
    const r = activeRecipe;
    if (!r) return;
    try {
      await app.supabase.setRecipeUpcoming(activeId, !r.upcoming);
      await refresh();
    } catch (err) {
      // Same surface as the rating-row failure path: the editor's
      // banner is the only error slot wired up in detail mode, and
      // showing it there means the user sees the message the next
      // time they open Edit. The next refresh reconciles whichever
      // state actually landed.
      editError = errMsg(err);
    }
  }

  // Toggle the recipe's "favorite" bookmark. Parallel to upcoming:
  // bypasses recipe_versions and leaves updated_at alone so a toggle
  // does not reshuffle the recency sort. Drives the Favorites
  // section in the drawer listing and the thumbs-up glyph next to
  // the row's title.
  async function onToggleFavorite(): Promise<void> {
    if (!app.supabase || !activeId) return;
    const r = activeRecipe;
    if (!r) return;
    try {
      await app.supabase.setRecipeFavorite(activeId, !r.favorite);
      await refresh();
    } catch (err) {
      editError = errMsg(err);
    }
  }

  async function onDelete(id: string): Promise<void> {
    if (!app.supabase) return;
    // Confirm before destructive action — the tool-side delete has
    // the same semantic ("remove a recipe by id") but the UI path
    // needs a user-directed confirm since a misclick is easy.
    if (!window.confirm('Delete this recipe? This cannot be undone.')) return;
    try {
      await app.supabase.deleteRecipe(id);
      await refresh();
      // Only kick the user back to the list view if they're still
      // on the deleted recipe. If they navigated to a different
      // recipe mid-delete, openList() would obliterate that
      // navigation - the route-sync effect has already taken them
      // somewhere meaningful and we leave them there.
      if (route.recipe === id) openList();
    } catch (err) {
      // Same cross-recipe gate as onSave's catch - the editError
      // banner is misattributed if surfaced on a different recipe.
      if (route.recipe === id) editError = errMsg(err);
    }
  }

  // Shared clipboard write + 1500ms flash. The setTimeout's pane
  // guard is a tighter no-op for the case where the user navigates
  // away mid-timer; setting state on a torn-down component is
  // harmless in Svelte but the guard keeps dev tools clean.
  // clipboard.writeText can fail when the page isn't focused (Safari
  // quirk) or on permissioned browsers - the catch surfaces a clear
  // fallback rather than silently dropping.
  async function copyWithFeedback(text: string, successMsg: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copyFeedback = successMsg;
      setTimeout(() => {
        if (pane === 'detail') copyFeedback = null;
      }, 1500);
    } catch {
      copyFeedback = 'Could not copy — check browser permissions.';
    }
  }

  async function onCopyPlain(): Promise<void> {
    const r = activeRecipe;
    if (!r) return;
    const parsed = parseCooklang(r.cooklang);
    await copyWithFeedback(recipeToPlainText(r.title, parsed), 'Copied.');
  }

  async function onCopyMarkdown(): Promise<void> {
    const r = activeRecipe;
    if (!r) return;
    const parsed = parseCooklang(r.cooklang);
    const md = recipeToMarkdown(r.title, parsed, {
      source: r.source,
      sourceUrl: r.source_url,
    });
    await copyWithFeedback(md, 'Markdown copied.');
  }

  async function onCopyCooklang(): Promise<void> {
    const r = activeRecipe;
    if (!r) return;
    await copyWithFeedback(r.cooklang, 'Cooklang source copied.');
  }

  // --- effects ---

  // Initial load + refetch on COOKBOOK_CHANGE_EVENT (fires on tool-path
  // recipe_* writes too, so the panel stays in sync without a manual
  // refresh). Photos refetch on every event because a tool-driven
  // recipe_photos_attach mid-conversation should refresh the strip
  // without the user navigating away. Best-effort; failures fall
  // back to "what's already cached."
  $effect(() => {
    void refresh();
    const off = onCookbookChange(() => {
      void refresh();
      if (activeId && app.supabase) {
        void loadRecipePhotos(app.supabase, activeId);
      }
    });
    return () => off();
  });

  // Chat.svelte's top-bar "new recipe" button sets triggerNew = true.
  // The $bindable prop lets this effect reset it (two-way).
  $effect(() => {
    if (triggerNew) {
      openNew();
      triggerNew = false;
    }
  });

  // Combined window key handler.
  //   Escape ladders: lightbox -> strip, edit -> detail-or-empty.
  //     Detail intentionally does nothing on Escape - the panel
  //     matches chats / journal in that there's no explicit "deselect"
  //     gesture, you switch by picking another recipe from the sidebar.
  //   ArrowLeft / ArrowRight page through the lightbox when open.
  function onWindowKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (lightboxIndex !== null) {
        closeLightbox();
        return;
      }
      if (pane === 'edit') {
        pane = activeId ? 'detail' : 'list';
      }
      return;
    }
    if (lightboxIndex !== null && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      animateStep(e.key === 'ArrowLeft' ? -1 : 1);
    }
  }

  // Parse the live recipe once and feed both projections off it - the
  // rendered HTML and the table of contents walk the same AST, and
  // recipeToc's link ids are produced by the same `tocHeadingId` the
  // renderer stamps on its headings, so the two stay in lockstep.
  const parsedDetail = $derived.by(() => {
    const r = activeRecipe;
    return r ? parseCooklang(r.cooklang) : null;
  });
  // Grocery checkboxes render on EVERY recipe's live detail view.
  // They were originally gated on the upcoming / favorite bookmarks,
  // but a recipe's grocery items outlive its bookmark (un-bookmarking
  // deliberately leaves the list alone), and gating left those items
  // manageable only from the Groceries tab - an inconsistency worse
  // than the extra checkboxes on recipes nobody is shopping for.
  const detailHtml = $derived(
    parsedDetail
      ? recipeToHtml(parsedDetail, { ingredientCheckboxes: true })
      : ''
  );
  const detailToc = $derived(parsedDetail ? recipeToc(parsedDetail) : []);
  // Hide the TOC below two jump targets - a lone "Instructions" link
  // with nothing to skip past is noise, not navigation. Threshold
  // policy lives on recipeTocVisible.
  const showDetailToc = $derived(recipeTocVisible(detailToc));

  // The rendered-recipe container, bound so a TOC click can resolve its
  // target id within this pane's output. Scoping the lookup here keeps it
  // from matching the same ids in the edit-pane preview or a past-version
  // render, which carry the identical anchor scheme.
  let detailRenderEl = $state<HTMLDivElement | null>(null);

  function scrollToHeading(id: string): void {
    const el = detailRenderEl?.querySelector(`#${CSS.escape(id)}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // --- grocery-bridge state (the ingredient checkboxes) ---

  // Grocery rows linked to the open recipe. A checkbox mirrors the
  // matched row's `needed` flag - "is this on my list right now" -
  // so removing or buying the item on the list side unchecks it
  // here. Refetched on recipe change and on the grocery change
  // event, which also covers the invalidation trigger's wipe after
  // a recipe edit.
  let recipeGroceryItems = $state<GroceryItem[]>([]);

  async function loadRecipeGroceryItems(): Promise<void> {
    const id = activeId;
    if (!id || !app.supabase) {
      recipeGroceryItems = [];
      return;
    }
    try {
      recipeGroceryItems = await app.supabase.listGroceryItemsForRecipe(id);
    } catch {
      // Non-fatal for the recipe view - the checkboxes just render
      // unchecked until the next successful refetch.
      recipeGroceryItems = [];
    }
  }

  $effect(() => {
    // Reads activeId so a recipe switch refetches.
    void activeId;
    void loadRecipeGroceryItems();
    return onGroceryChange(() => void loadRecipeGroceryItems());
  });

  // Sync the rendered checkboxes' checked state from the grocery rows.
  // The render is an {@html} string, so state can't ride the markup -
  // this effect walks the mounted inputs after every render/data
  // change. Keyed by normalized ingredient name because ingredients
  // have no stable id (they are parsed out of the cooklang source).
  $effect(() => {
    const el = detailRenderEl;
    void detailHtml;
    const items = recipeGroceryItems;
    if (!el || !parsedDetail) return;
    const entries = recipeCheckboxItemIds(parsedDetail.ingredients, items);
    for (const input of el.querySelectorAll<HTMLInputElement>('input.cook-buy')) {
      const name = input.dataset.ing ?? '';
      // Checked = the matched row is on the current list. A row that
      // was bought or removed on the list side reads unchecked here;
      // re-checking revives it (see onRenderChange).
      input.checked = entries.get(normalizeGroceryName(name))?.needed === true;
    }
  });

  // "Add all to grocery list": batch the whole ingredient set onto
  // the list - revive rows that exist but aren't needed, insert the
  // rest - then one refetch + one event nudge. Idempotent (already-
  // needed rows are skipped), so a double-tap is harmless.
  let addAllBusy = $state(false);

  function onAddAllIngredients(): void {
    const recipe = activeRecipe;
    const parsed = parsedDetail;
    if (!recipe || !parsed || !app.supabase || addAllBusy) return;
    const supabase = app.supabase;
    addAllBusy = true;
    void (async () => {
      try {
        const entries = recipeCheckboxItemIds(parsed.ingredients, recipeGroceryItems);
        const { reviveIds, create } = partitionIngredientsForAdd(
          parsed.ingredients,
          entries
        );
        for (const id of reviveIds) {
          await supabase.setGroceryItemNeeded(id, true);
        }
        for (const ingredient of create) {
          await supabase.createGroceryItem(
            groceryItemFromIngredient(ingredient, {
              id: recipe.id,
              title: recipe.title,
            })
          );
        }
      } finally {
        await loadRecipeGroceryItems();
        emitGroceryChange();
        addAllBusy = false;
      }
    })();
  }

  // Delegated change handler for the grocery checkboxes ({@html}
  // markup can't carry Svelte handlers). Checking inserts a grocery
  // item carrying the cooklang quantity verbatim plus a note naming
  // this recipe; unchecking deletes the row. Either way the rows
  // refetch and the checked-state effect reconciles the DOM - on a
  // failed write that reconcile is also what rolls the checkbox back.
  function onRenderChange(e: Event): void {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.classList.contains('cook-buy')) return;
    const recipe = activeRecipe;
    const parsed = parsedDetail;
    if (!recipe || !parsed || !app.supabase) return;
    const supabase = app.supabase;
    const key = normalizeGroceryName(target.dataset.ing ?? '');
    void (async () => {
      try {
        const existing = recipeCheckboxItemIds(parsed.ingredients, recipeGroceryItems);
        const entry = existing.get(key);
        if (target.checked) {
          if (entry) {
            // A row already exists (bought on a past trip, or removed
            // from the list without deleting) - revive it instead of
            // inserting a duplicate.
            if (!entry.needed) await supabase.setGroceryItemNeeded(entry.id, true);
          } else {
            const ingredient = parsed.ingredients.find(
              (i) => normalizeGroceryName(i.name) === key
            );
            if (ingredient) {
              await supabase.createGroceryItem(
                groceryItemFromIngredient(ingredient, {
                  id: recipe.id,
                  title: recipe.title,
                })
              );
            }
          }
        } else if (entry) {
          // Un-planning deletes the row outright (rather than flipping
          // needed false) so the wipe-on-recipe-edit story stays
          // simple: rows linked to a recipe are exactly the checked
          // set plus what was bought for it.
          await supabase.deleteGroceryItem(entry.id);
        }
      } finally {
        await loadRecipeGroceryItems();
        // Nudge an open Groceries tab in this same client immediately -
        // the realtime echo also arrives, but round-trips noticeably.
        emitGroceryChange();
      }
    })();
  }

  // The version row currently being viewed read-only, or null when the
  // detail pane is showing the live recipe.
  const viewedVersion = $derived.by<RecipeVersion | null>(() => {
    if (!viewingVersionId || !versions) return null;
    return versions.find((v) => v.id === viewingVersionId) ?? null;
  });

  // Render-time HTML for the read-only past version. Goes through the
  // exact same `cooklangToHtml` as the live recipe so what the user
  // saw when they saved that version is what they see when they
  // browse back to it.
  const viewedHtml = $derived(
    viewedVersion ? cooklangToHtml(viewedVersion.cooklang) : ''
  );

  function onViewVersion(versionId: string): void {
    viewingVersionId = versionId;
    copyFeedback = null;
  }

  function onBackToCurrent(): void {
    viewingVersionId = null;
  }

  // Revert: copy the chosen version's content into a new edit. We use
  // window.prompt for the change message to mirror the existing
  // window.confirm pattern on Delete - both are interrupting flows the
  // user explicitly initiated, and a full inline form for a one-line
  // note would be overkill. The default text is a sensible "reverted
  // to <date>" string so the user can hit Enter and move on.
  async function onRevert(v: RecipeVersion): Promise<void> {
    if (!app.supabase || !activeId) return;
    const suggested = suggestedRevertMessage(v.created_at);
    const msg = window.prompt(
      'Describe this revert (required):',
      suggested
    );
    if (msg === null) return; // user cancelled
    const trimmed = msg.trim();
    if (trimmed.length === 0) {
      versionsError = 'A change message is required to revert.';
      return;
    }
    try {
      await app.supabase.revertRecipe(activeId, v.id, trimmed);
      viewingVersionId = null;
      await refresh();
      await loadVersions(activeId);
    } catch (err) {
      versionsError = errMsg(err);
    }
  }

  // Click an instruction step to move a theme-tinted highlight onto
  // it — a light "I'm on this step" marker for the reader cooking
  // along. Single-highlight: clicking a new step moves the marker;
  // clicking the already-active step clears it. Delegation walks up
  // from the click target to the nearest `<li>`, then verifies that
  // li is inside an `ol.cook-steps` (so clicks on ingredient lists
  // or cookware don't highlight). We clear across every `cook-steps`
  // in the container, not just the clicked `<ol>`, because sectioned
  // recipes split steps into one `<ol>` per section — "one at a
  // time" is one-per-recipe, not one-per-section. The state lives on
  // the DOM via a class; no reactive state, no persistence —
  // switching recipes replaces the HTML and wipes the highlight.
  function onRenderClick(e: MouseEvent): void {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const li = target.closest('li');
    if (!li) return;
    const ol = li.parentElement;
    if (!ol || !ol.classList.contains('cook-steps')) return;
    const container = e.currentTarget;
    if (!(container instanceof Element)) return;
    // Capture before clearing so "click the active step to clear it"
    // still works — otherwise the clear would remove the class and we
    // couldn't tell the re-toggle case apart from a fresh click.
    const wasActive = li.classList.contains('is-active');
    for (const prev of container.querySelectorAll('ol.cook-steps li.is-active')) {
      prev.classList.remove('is-active');
    }
    if (!wasActive) li.classList.add('is-active');
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="cookbook-panel">
  <section class="cookbook-body">
      {#if pane === 'list'}
        <!-- Empty/unselected state. The sidebar RecipeList is the browse
             surface; clicking a recipe there selects it and switches this
             panel to the detail pane. The "+ New recipe" button in
             Chat.svelte's top-bar (above this panel) is the create
             entry point. On mobile the list lives in a drawer rather
             than a persistent left column, so the shell auto-opens
             that drawer when this pane appears (see Cookbook's
             onDeselect prop) - the wording still works because an open
             drawer also reads as "the list on the left." -->
        <p class="subtle cookbook-empty-hint">
          Select a recipe from the list on the left, or click <strong>+ New recipe</strong> above.
        </p>
      {:else if pane === 'detail'}
        {#if activeRecipe}
          {@const r = activeRecipe}
          {@const v = viewedVersion}
          <div class="cookbook-detail">
            <div class="cookbook-detail-header">
              <h2>{v ? v.title : r!.title}</h2>
              <!-- Rating row. On the live recipe the widget is
                   interactive - clicking a star persists immediately
                   with an auto-generated change_message ("Rated 4
                   stars."). When viewing a past version we render the
                   snapshot's rating read-only so history reads
                   honestly. -->
              <div class="cookbook-detail-rating">
                {#if v}
                  <RecipeRating value={v.rating} size={20} />
                {:else}
                  <RecipeRating
                    value={r!.rating}
                    onChange={onRateActive}
                    size={20}
                  />
                {/if}
              </div>
              {#if v}
                <!-- Read-only past-version view. Title above swaps to
                     the snapshot's title; this banner says when and
                     why, with controls to bail back to the live recipe
                     or roll forward into a revert. The history list
                     below the body stays visible so the user can
                     hop between snapshots without leaving the pane. -->
                <p class="subtle cookbook-version-banner-meta">
                  Viewing version from
                  <strong>{formatVersionDate(v.created_at)}</strong> —
                  <em>{v.change_message}</em>
                </p>
              {:else if recipeSourceLine(r!).kind !== 'none'}
                {@const sourceLine = recipeSourceLine(r!)}
                <p class="subtle">
                  {#if sourceLine.kind === 'link'}
                    <a
                      href={sourceLine.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >{sourceLine.label}</a>
                  {:else if sourceLine.kind === 'text'}
                    {sourceLine.text}
                  {/if}
                </p>
              {/if}
            </div>
            {#if v}
              <!-- Version-mode actions. Distinct from the live action
                   bar below: read-only viewing has only "back to
                   current" and "revert"; copy / edit / delete only
                   make sense on the live recipe. -->
              <div class="cookbook-actions">
                <button
                  type="button"
                  class="secondary"
                  onclick={onBackToCurrent}
                >← Back to current</button>
                <button
                  type="button"
                  class="primary"
                  onclick={() => onRevert(v)}
                >Revert to this version</button>
              </div>
              <div class="cookbook-render">
                {@html viewedHtml}
              </div>
            {:else}
            <!-- Icon-only action bar. Each button carries a `title` +
                 `aria-label` so the purpose stays discoverable without
                 the visual weight of text labels - the seven actions
                 are common enough that the clipboard / cart /
                 thumbs-up / pencil / trash glyphs read at a glance,
                 especially on mobile where the text-label version
                 wrapped to a second row.

                 Buttons are split into three behavior groups: copy
                 actions, bookmark toggles, edit/delete. Each group
                 is a `.cookbook-action-group` (Bootstrap-style merged
                 buttons: no gap inside, square inner corners, shared
                 border via -1px overlap), and the groups themselves
                 sit with the normal 0.35rem gap between them. On a
                 narrow viewport the whole GROUPS wrap as units
                 instead of individual icons, so a wrap point never
                 splits "copy plain" from "copy markdown" mid-action. -->
            <div class="cookbook-actions">
              <!-- Copy group: plain text, Markdown, raw Cooklang. -->
              <div class="cookbook-action-group" role="group" aria-label="Copy actions">
                <button
                  type="button"
                  class="secondary icon-btn"
                  onclick={onCopyPlain}
                  title="Copy as plain text (AnyList-friendly)"
                  aria-label="Copy as plain text"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                </button>
                <!-- Markdown copy. The glyph is the canonical Markdown
                     logo shape - rounded rect with an "M" stroke on
                     the left and a down-arrow on the right -
                     simplified to stroke-only so it matches the rest
                     of the icon bar's weight. The "M" is two
                     diagonals + a baseline, the arrow is a vertical
                     with two chevron strokes. -->
                <button
                  type="button"
                  class="secondary icon-btn"
                  onclick={onCopyMarkdown}
                  title="Copy as Markdown"
                  aria-label="Copy as Markdown"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="2" y="6" width="20" height="12" rx="2" ry="2" />
                    <path d="M6 15V9l2.5 3L11 9v6" />
                    <path d="M16 9v6" />
                    <path d="M14 13l2 2 2-2" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="secondary icon-btn"
                  onclick={onCopyCooklang}
                  title="Copy Cooklang source"
                  aria-label="Copy Cooklang source"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="16 18 22 12 16 6" />
                    <polyline points="8 6 2 12 8 18" />
                  </svg>
                </button>
              </div>
              <!-- Bookmark group: upcoming + favorite. The two flags
                   that surface as drawer sections (Upcoming /
                   Favorites at the top of the listing). Active state
                   = filled glyph + accent border, set per-button on
                   `.cookbook-action-upcoming.active` /
                   `.cookbook-action-favorite.active`. -->
              <div class="cookbook-action-group" role="group" aria-label="Bookmark toggles">
                <button
                  type="button"
                  class="secondary icon-btn cookbook-action-upcoming"
                  class:active={r!.upcoming}
                  onclick={onToggleUpcoming}
                  disabled={!offlineStatus.online}
                  title={bookmarkButtonTitle(offlineStatus.online, r!.upcoming, 'upcoming')}
                  aria-label={bookmarkAriaLabel(r!.upcoming, 'upcoming')}
                  aria-pressed={r!.upcoming}
                >
                  {#if r!.upcoming}
                    <!-- Filled cart: solid body so the active state
                         reads loudly even at 16px. -->
                    <svg width="16" height="16" viewBox="0 0 24 24"
                         fill="currentColor" stroke="currentColor"
                         stroke-width="1.5" stroke-linecap="round"
                         stroke-linejoin="round" aria-hidden="true">
                      <circle cx="9" cy="21" r="1.5" />
                      <circle cx="20" cy="21" r="1.5" />
                      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"
                            fill="none" />
                      <path d="M7 7h15l-1.5 7h-12z" />
                    </svg>
                  {:else}
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <circle cx="9" cy="21" r="1" />
                      <circle cx="20" cy="21" r="1" />
                      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
                    </svg>
                  {/if}
                </button>
                <button
                  type="button"
                  class="secondary icon-btn cookbook-action-favorite"
                  class:active={r!.favorite}
                  onclick={onToggleFavorite}
                  disabled={!offlineStatus.online}
                  title={bookmarkButtonTitle(offlineStatus.online, r!.favorite, 'favorite')}
                  aria-label={bookmarkAriaLabel(r!.favorite, 'favorite')}
                  aria-pressed={r!.favorite}
                >
                  {#if r!.favorite}
                    <svg width="16" height="16" viewBox="0 0 24 24"
                         fill="currentColor" stroke="currentColor"
                         stroke-width="1.5" stroke-linecap="round"
                         stroke-linejoin="round" aria-hidden="true">
                      <path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3z" />
                      <path d="M7 11l4-7a2 2 0 0 1 4 0v4h5a2 2 0 0 1 2 2.4l-2 7A2 2 0 0 1 18 20H7z" />
                    </svg>
                  {:else}
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3z" />
                      <path d="M7 11l4-7a2 2 0 0 1 4 0v4h5a2 2 0 0 1 2 2.4l-2 7A2 2 0 0 1 18 20H7z" />
                    </svg>
                  {/if}
                </button>
              </div>
              <!-- Modify group: edit and delete. Delete keeps its
                   warn-stroke hover via `.cookbook-action-danger`. -->
              <div class="cookbook-action-group" role="group" aria-label="Modify actions">
                <button
                  type="button"
                  class="secondary icon-btn"
                  onclick={openEdit}
                  disabled={!offlineStatus.online}
                  title={modifyActionTitle(offlineStatus.online, 'edit')}
                  aria-label="Edit recipe"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="secondary icon-btn cookbook-action-danger"
                  onclick={() => onDelete(r!.id)}
                  disabled={!offlineStatus.online}
                  title={modifyActionTitle(offlineStatus.online, 'delete')}
                  aria-label="Delete recipe"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
                    <path d="M10 11v6M14 11v6" />
                    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                  </svg>
                </button>
              </div>
              <!-- aria-live so screen readers hear the "Copied." flash.
                   Reserves its grid slot when empty so the button row
                   doesn't jump when the message appears and fades. -->
              <span class="subtle copy-feedback" aria-live="polite">
                {copyFeedback ?? ''}
              </span>
            </div>
            <!-- Photo strip. Sits ABOVE the cooklang render so the
                 thumbnails appear just above the metadata block (where
                 servings lives) without the strip having to live inside
                 the cooklang HTML. The cooklang module stays the source
                 of truth for recipe text; photos live alongside it.
                 The strip hides itself when the recipe has no photos
                 so it doesn't reserve dead space. -->
            {#if Array.isArray(activePhotos) && activePhotos.length > 0}
              <div class="recipe-photos-strip" role="list">
                {#each activePhotos as p, i (p.id)}
                  <figure class="photo-thumb-figure">
                    <button
                      type="button"
                      class="photo-thumb"
                      onclick={() => openLightbox(i)}
                      title={p.label ?? 'Open photo'}
                      aria-label={photoOpenAriaLabel(i, activePhotos.length, p.label)}
                    >
                      <img
                        src={p.url}
                        alt={p.label ?? ''}
                        title={p.label ?? ''}
                        loading="lazy"
                      />
                    </button>
                    {#if p.label}
                      <figcaption class="photo-thumb-caption">
                        <em>{p.label}</em>
                      </figcaption>
                    {/if}
                  </figure>
                {/each}
              </div>
            {:else if !offlineStatus.online}
              <!-- Photos are signed-URL blobs we don't cache (text and
                   metadata only), so they can't load with no network.
                   Say so rather than showing broken image icons. -->
              <p class="subtle recipe-photos-offline">
                Photos are only available online.
              </p>
            {/if}
            <!-- Table of contents. A jump menu over the rendered body:
                 top-level Ingredients / Instructions plus a sub-entry per
                 section heading. Each link scrolls to the matching `<h3>`
                 / `<h4>` by id (shared with the renderer via
                 `tocHeadingId`). Hidden below two targets, where a single
                 link has nothing to jump past. -->
            {#if showDetailToc}
              <nav class="cookbook-toc" aria-label="Recipe contents">
                <ul class="cookbook-toc-list">
                  {#each detailToc as entry (entry.id)}
                    <li>
                      <button
                        type="button"
                        class="cookbook-toc-link"
                        onclick={() => scrollToHeading(entry.id)}
                      >{entry.label}</button>
                      {#if entry.sections.length > 0}
                        <ul class="cookbook-toc-sublist">
                          {#each entry.sections as sec (sec.id)}
                            <li>
                              <button
                                type="button"
                                class="cookbook-toc-link cookbook-toc-sublink"
                                onclick={() => scrollToHeading(sec.id)}
                              >{sec.label}</button>
                            </li>
                          {/each}
                        </ul>
                      {/if}
                    </li>
                  {/each}
                </ul>
              </nav>
            {/if}
            <!-- The parsed HTML is produced from trusted source (the
                 user's own Cooklang text, escaped in recipeToHtml via
                 `esc()`), so rendering with `{@html}` is safe. We still
                 wrap in a scoped container so any future style leak
                 stays contained to `.cookbook-render`. -->
            <!-- Click-to-highlight instruction steps. Event delegation
                 on the container, because the inner DOM is produced by
                 `{@html}` and isn't directly bindable. We only react to
                 clicks inside `ol.cook-steps` so ingredient chips,
                 metadata, etc. stay inert. Highlight state is kept as
                 a class on the DOM node — no Svelte state — which means
                 switching recipes (a full `{@html}` re-render) naturally
                 resets the highlights, and there's nothing to persist.
                 The same container is bound to `detailRenderEl` so a TOC
                 click can resolve its target id within this render. -->
            {#if parsedDetail && parsedDetail.ingredients.length > 0}
              <!-- Batch shortcut for the per-row checkboxes below.
                   Rendered by the template (not the {@html} body)
                   because it needs Svelte state for the busy gate. -->
              <div class="cookbook-add-all-row">
                <button
                  type="button"
                  class="cookbook-add-all"
                  disabled={addAllBusy}
                  onclick={onAddAllIngredients}
                >{addAllBusy ? 'Adding...' : 'Add all to grocery list'}</button>
              </div>
            {/if}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="cookbook-render"
              bind:this={detailRenderEl}
              onclick={onRenderClick}
              onchange={onRenderChange}
            >
              {@html detailHtml}
            </div>
            {/if}
            <!-- History panel. Lazy-loaded on detail open; collapsed by
                 default so the recipe stays the focal point. Clicking a
                 row swaps the body above into the read-only past
                 version, with revert / back-to-current controls in the
                 banner. The "current state" header at the top of the
                 list is non-interactive and just anchors the user when
                 they're scanning back through edits. -->
            <details class="cookbook-history" open={viewingVersionId !== null}>
              <summary>
                {historySummaryLabel(versions ? versions.length : null)}
              </summary>
              {#if versionsLoading}
                <p class="subtle">Loading history…</p>
              {:else if versionsError}
                <p class="error">{versionsError}</p>
              {:else if versions && versions.length > 0}
                <ul class="cookbook-history-list">
                  {#each versions as ver, i (ver.id)}
                    {@const row = versionRowState(i, ver.id, viewingVersionId)}
                    <li>
                      <button
                        type="button"
                        class="cookbook-history-row"
                        class:is-active={row.isViewing}
                        class:is-current={row.isCurrentShown}
                        onclick={() =>
                          row.isCurrent ? onBackToCurrent() : onViewVersion(ver.id)}
                      >
                        <span class="cookbook-history-date">
                          {formatVersionDate(ver.created_at)}
                          {#if row.isCurrent}<span class="cookbook-history-badge">current</span>{/if}
                        </span>
                        <span class="cookbook-history-message">
                          {ver.change_message}
                        </span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {:else if versions}
                <p class="subtle">No history yet.</p>
              {/if}
            </details>
          </div>
        {:else}
          <p class="subtle">Recipe not found.</p>
        {/if}
      {:else if pane === 'edit'}
        <form class="cookbook-edit" onsubmit={onSave}>
          <div class="form-row">
            <label for="cb-title">Title</label>
            <input
              id="cb-title"
              type="text"
              bind:value={draftTitle}
              maxlength={MAX_RECIPE_TITLE_CHARS}
              required
            />
          </div>
          <div class="form-row">
            <label for="cb-source">Source <span class="subtle">(optional)</span></label>
            <input
              id="cb-source"
              type="text"
              bind:value={draftSource}
              maxlength={400}
              placeholder="e.g. NYT Cooking — Alison Roman"
            />
          </div>
          <div class="form-row">
            <label for="cb-source-url">Source URL <span class="subtle">(optional)</span></label>
            <input
              id="cb-source-url"
              type="url"
              bind:value={draftSourceUrl}
              maxlength={2000}
              placeholder="https://…"
            />
          </div>
          <div class="form-row">
            <!-- The rating control isn't tied to a single <input>, so
                 we use a div instead of <label> to avoid the Svelte
                 a11y warning about unassociated labels. The widget
                 itself carries an aria-label so screen readers still
                 announce the control. -->
            <div class="form-label">Rating <span class="subtle">(optional)</span></div>
            <RecipeRating
              value={draftRating}
              onChange={(next) => (draftRating = next)}
              size={22}
            />
          </div>
          <div class="form-row">
            <!-- Stand-in label, same reasoning as the rating row above:
                 the file input is the only focusable target, but the
                 grid below it is the more meaningful "field" the user
                 sees, so we use a div instead of a <label> attached to
                 the bare input. -->
            <div class="form-label">
              Photos <span class="subtle">(optional, up to {MAX_RECIPE_PHOTOS})</span>
            </div>
            <div class="recipe-photos-edit">
              {#each draftPhotos as p, i (p.imageId + ':' + i)}
                <div class="recipe-photo-edit-cell">
                  <img
                    src={p.src}
                    alt={p.label}
                    loading="lazy"
                  />
                  <div class="recipe-photo-edit-cell-actions">
                    <button
                      type="button"
                      class="secondary icon-btn"
                      onclick={() => onMoveDraftPhoto(i, -1)}
                      disabled={i === 0}
                      title="Move left"
                      aria-label="Move photo left"
                    >‹</button>
                    <button
                      type="button"
                      class="secondary icon-btn"
                      onclick={() => onMoveDraftPhoto(i, 1)}
                      disabled={i === draftPhotos.length - 1}
                      title="Move right"
                      aria-label="Move photo right"
                    >›</button>
                    <button
                      type="button"
                      class="secondary icon-btn cookbook-action-danger"
                      onclick={() => onRemoveDraftPhoto(i)}
                      title="Remove photo"
                      aria-label="Remove photo"
                    >×</button>
                  </div>
                  <!-- Optional caption. Edits stay in memory until
                       the user clicks Save - then the whole photo
                       set (with labels) lands in one version row.
                       maxlength matches the schema cap below in
                       the dev docs (200 chars). -->
                  <input
                    type="text"
                    class="recipe-photo-edit-label"
                    bind:value={draftPhotos[i]!.label}
                    maxlength={200}
                    placeholder="Caption (optional)"
                    aria-label="Photo {i + 1} caption"
                  />
                  <span class="subtle recipe-photo-edit-meta">
                    {formatBytes(p.sizeBytes)}
                  </span>
                </div>
              {/each}
              {#if draftPhotos.length < MAX_RECIPE_PHOTOS}
                <label class="recipe-photo-edit-add">
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onchange={onPickPhotos}
                    disabled={photosUploading}
                  />
                  <span aria-hidden="true">+</span>
                  <span class="subtle">
                    {photosUploading ? 'Uploading…' : 'Add photo'}
                  </span>
                </label>
              {/if}
            </div>
            {#if photoErrors.length > 0}
              <ul class="error recipe-photo-errors">
                {#each photoErrors as msg}
                  <li>{msg}</li>
                {/each}
              </ul>
            {/if}
            <p class="subtle cookbook-change-message-hint">
              Images are downscaled to {MAX_PHOTO_UPLOAD_MB}MB max
              and stored alongside the recipe. Photo edits land in the
              History panel like any other change.
            </p>
          </div>
          <div class="cookbook-edit-panes">
            <div class="form-row cookbook-edit-source-col">
              <label for="cb-cooklang">Cooklang source</label>
              <textarea
                id="cb-cooklang"
                class="cookbook-edit-textarea"
                bind:value={draftCooklang}
                maxlength={MAX_RECIPE_COOKLANG_CHARS}
                spellcheck="false"
                required
              ></textarea>
              <p class="subtle cookbook-syntax-hint">
                Syntax: <code>@ingredient{'{'}1%cup{'}'}</code>,
                <code>#cookware{'{'}{'}'}</code>,
                <code>~timer{'{'}30%min{'}'}</code>,
                <code>&gt;&gt; servings: 4</code>.
              </p>
            </div>
            <div class="cookbook-edit-preview-col">
              <div class="form-label">Preview</div>
              <div class="cookbook-render cookbook-edit-preview">
                {@html editPreviewHtml}
              </div>
            </div>
          </div>
          <!-- Change-message input sits last, right above Save, so the
               required "What changed?" note is the final thing the user
               fills in before committing the edit. -->
          <div class="form-row">
            <label for="cb-change-message">What changed?</label>
            <input
              id="cb-change-message"
              type="text"
              bind:value={draftChangeMessage}
              maxlength={500}
              placeholder="e.g. Doubled the recipe; fixed step 3"
              required
            />
            <p class="subtle cookbook-change-message-hint">
              A one-line note for this recipe's history. Required.
            </p>
          </div>
          {#if editError}<p class="error">{editError}</p>{/if}
          <div class="cookbook-actions">
            <button type="submit" class="primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              class="secondary"
              onclick={() => (pane = activeId ? 'detail' : 'list')}
            >Cancel</button>
          </div>
        </form>
      {/if}
    </section>
</div>

<!-- Lightbox. Mounted only while open so the DOM stays clean.
     A 3-slide carousel - [prev | current | next] - whose track
     slides under the finger on a swipe and animates one slide over on
     a commit (swipe past threshold, arrow, or arrow key). Click the
     dim area around the photo to dismiss; clicking the image keeps it
     open. The close button is the redundant escape hatch. -->
{#if lightboxIndex !== null && Array.isArray(activePhotos) && activePhotos.length > 0}
  {@const len = activePhotos.length}
  {@const p = activePhotos[lightboxIndex]}
  {@const prevP = activePhotos[wrapIndex(lightboxIndex, -1, len)]}
  {@const nextP = activePhotos[wrapIndex(lightboxIndex, 1, len)]}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="recipe-lightbox-backdrop"
    onclick={(e) => {
      // Dismiss on a click in the dim area, not on the photo. The
      // viewport and slides are pointer-events:none so a click on the
      // dark surround falls through to the backdrop (target ===
      // currentTarget here); only the <img> opts back into pointer
      // events, so a click on the photo lands on the image and leaves
      // the viewer open. Escape and the close button are the keyboard
      // and explicit-control paths.
      if (e.target === e.currentTarget) closeLightbox();
    }}
    ontouchstart={onLightboxTouchStart}
    ontouchmove={onLightboxTouchMove}
    ontouchend={onLightboxTouchEnd}
    role="dialog"
    aria-modal="true"
    aria-label="Photo viewer"
    tabindex="-1"
  >
    <!-- The viewport clips the track; the track is a flex row of three
         viewport-width slides. It renders behind the chrome (close,
         arrows, caption, counter), which all come after it in the DOM
         so they stack on top and stay clickable. -->
    <div class="recipe-lightbox-viewport">
      <div class="recipe-lightbox-track" style={lightboxTrackStyleStr}>
        <div class="recipe-lightbox-slide">
          {#if len > 1 && prevP}
            <img class="recipe-lightbox-img" src={prevP.url} alt={prevP.label ?? ''} />
          {/if}
        </div>
        <div class="recipe-lightbox-slide">
          {#if p}
            <img
              class="recipe-lightbox-img"
              src={p.url}
              alt={p.label ?? ''}
              title={p.label ?? ''}
            />
          {/if}
        </div>
        <div class="recipe-lightbox-slide">
          {#if len > 1 && nextP}
            <img class="recipe-lightbox-img" src={nextP.url} alt={nextP.label ?? ''} />
          {/if}
        </div>
      </div>
    </div>
    <button
      type="button"
      class="recipe-lightbox-close"
      onclick={closeLightbox}
      title="Close"
      aria-label="Close photo viewer"
    >×</button>
    {#if len > 1}
      <!-- Edge-pinned, vertically-centered paging arrows. Mounted only
           for multi-photo recipes; a single photo has nothing to page
           to. Looping is handled by animateStep, so both arrows are
           always live - there is no disabled end state. -->
      <button
        type="button"
        class="recipe-lightbox-nav prev"
        onclick={() => animateStep(-1)}
        title="Previous photo"
        aria-label="Previous photo"
      >‹</button>
      <button
        type="button"
        class="recipe-lightbox-nav next"
        onclick={() => animateStep(1)}
        title="Next photo"
        aria-label="Next photo"
      >›</button>
    {/if}
    {#if p?.label}
      <!-- Caption pinned above the counter so the two pieces of chrome
           don't overlap on narrow viewports. The italic treatment
           matches the thumb-strip caption so the same text reads
           consistently across the strip and the lightbox. Tied to the
           current photo, so it updates when a slide commits. -->
      <span class="recipe-lightbox-caption" aria-live="polite">
        <em>{p.label}</em>
      </span>
    {/if}
    {#if len > 1}
      <span class="subtle recipe-lightbox-counter" aria-live="polite">
        {lightboxIndex + 1} / {len}
      </span>
    {/if}
  </div>
{/if}

<style>
  /* Inline recipe panel. Fills the main content area as a flex column;
     the parent .chat already handles overall column layout. */
  .cookbook-panel {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    background: var(--surface);
  }
  /* Hint text shown when no recipe is selected. Sits inside the
     scrollable .cookbook-body so it occupies the same slot the detail
     content would. */
  .cookbook-empty-hint {
    padding: 2rem 1.5rem;
    text-align: center;
  }
  .cookbook-body {
    padding: 1.5rem 2rem;
    overflow: auto;
    flex: 1;
  }

  /* Two-column ingredient list on wide panels. CSS columns keeps the
     natural list flow so items read top-to-bottom in each column rather
     than left-to-right across the row. The 480px threshold is roughly
     where a two-column list stops feeling crowded — below it we let the
     list collapse back to one column. avoid-column-break on li prevents
     a single ingredient from being split across columns. */
  @media (min-width: 700px) {
    .cookbook-render :global(ul.cook-ingredients) {
      column-count: 2;
      column-gap: 2rem;
    }
    .cookbook-render :global(ul.cook-ingredients li) {
      break-inside: avoid;
    }
  }
  /* Rating row sits between the title and the source line on the
     detail pane. Small top gap so it doesn't crowd the h2; bottom
     margin matches the existing source-paragraph rhythm. */
  .cookbook-detail-rating {
    margin: 0.1rem 0 0.5rem;
  }
  /* Stand-in for a <label> on rows where the labelled element isn't
     a single focusable input (the rating widget; the rendered preview
     div) - a real <label> would trip a11y_label_has_associated_control.
     Matches sibling label typography so the form stays visually
     balanced. */
  .form-label {
    display: block;
    font-size: 0.85rem;
    font-weight: 600;
    margin-bottom: 0.25rem;
  }
  .cookbook-detail-header h2 {
    margin: 0 0 0.25rem;
  }
  .cookbook-detail-header p {
    margin: 0 0 0.75rem;
    font-size: 0.85rem;
    /* Source line carries free-text / imported strings; an unbroken
       token (e.g. a bare domain pasted as the name) would otherwise
       span the whole app width and force a horizontal scroll on a
       narrow viewport. */
    overflow-wrap: anywhere;
  }
  .cookbook-actions {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    margin: 0.75rem 0;
    flex-wrap: wrap;
  }
  /* Bootstrap-style merged button group. Buttons inside touch each
     other with a -1px left margin on every non-first child so adjacent
     borders overlap into a single 1px seam instead of doubling up;
     the inner corners square off and only the outer corners stay
     rounded, so the group reads as one unit. The OUTER .cookbook-
     actions container keeps its 0.35rem gap, so groups wrap as units
     on narrow viewports - the actual fix for the mobile wrap problem
     this commit is about. */
  .cookbook-action-group {
    display: inline-flex;
    gap: 0;
  }
  .cookbook-actions :global(.cookbook-action-group > button.icon-btn:not(:first-child)) {
    margin-left: -1px;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }
  .cookbook-actions :global(.cookbook-action-group > button.icon-btn:not(:last-child)) {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  /* Bring the hovered / focused / active button above its siblings so
     its accent (or warn) border shows across the full perimeter
     instead of being clipped by the next button's left border at the
     seam. Without z-index the later sibling's static border would
     stack on top regardless of which one was hovered. */
  .cookbook-actions :global(.cookbook-action-group > button.icon-btn:hover),
  .cookbook-actions :global(.cookbook-action-group > button.icon-btn:focus-visible),
  .cookbook-actions :global(.cookbook-action-group > button.icon-btn.active) {
    position: relative;
    z-index: 1;
  }
  /* Scoped fill for the recipe-detail action strip (edit / copy /
     copy-source / trash). The global `.icon-btn` stays transparent so
     other icon buttons in the app (drawer header, composer, …) are
     untouched. Here we want the buttons to feel a bit more tactile:
     a --bg-2 tile at rest so they stand off the recipe surface, an
     --accent-weak wash on hover with the --accent border for a
     confident "pressable" state. */
  .cookbook-actions :global(button.icon-btn) {
    background: var(--bg-2);
  }
  .cookbook-actions :global(button.icon-btn:hover),
  .cookbook-actions :global(button.icon-btn:focus-visible) {
    background: var(--accent-weak);
    border-color: var(--accent);
  }
  /* Danger tint on Delete — only the stroke shifts to the warn color
     on hover / focus so the button's resting state matches its
     neighbors. Matches the Thread drawer's "danger" menu-item
     pattern (secondary chrome, red stroke on interaction). The
     selector chain mirrors the `.cookbook-actions :global(...)` rule
     above so this wins on specificity and overrides the accent-weak
     hover wash for the delete button only. Resting tile stays
     --bg-2 so the warn stroke reads against a consistent fill. */
  .cookbook-actions :global(button.icon-btn.cookbook-action-danger:hover),
  .cookbook-actions :global(button.icon-btn.cookbook-action-danger:focus-visible) {
    background: var(--bg-2);
    color: var(--warn, #c0392b);
    border-color: var(--warn, #c0392b);
  }
  /* Active state for the Upcoming toggle: accent wash + accent border
     so the on/off distinction reads at a glance against the rest of
     the icon row, which all share the --bg-2 resting tile. Selector
     mirrors the danger override above so it wins on specificity
     against the .cookbook-actions :global(button.icon-btn) rule. */
  .cookbook-actions :global(button.icon-btn.cookbook-action-upcoming.active),
  .cookbook-actions :global(button.icon-btn.cookbook-action-favorite.active) {
    background: var(--accent-weak);
    border-color: var(--accent);
    color: var(--accent);
  }
  /* Reserve a slot for the "Copied." flash so the button row stays
     stable when the message appears and vanishes. The empty-state
     min-width is rough parity with the longest flash text. */
  .copy-feedback {
    font-size: 0.85rem;
    min-width: 6rem;
    min-height: 1.1em;
  }

  /* Table of contents. A compact inset card above the rendered recipe;
     its links scroll the body below to the matching section heading. The
     accent-weak left rule on the sublist gives the per-section entries
     hierarchy under their Ingredients / Instructions parent without a
     second indent level competing with the recipe content. Lives in the
     scroll flow (not sticky) so it reads as "contents of what follows". */
  .cookbook-toc {
    margin: 0.25rem 0 1rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-2);
  }
  .cookbook-toc-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .cookbook-toc-sublist {
    list-style: none;
    margin: 0.1rem 0 0.3rem;
    padding: 0 0 0 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
    border-left: 2px solid var(--accent-weak);
  }
  /* Override the global filled-button base: these are text links wearing
     a button for the click semantics, so background / padding / radius /
     font-size all get pulled back to a link's weight. */
  .cookbook-toc :global(button.cookbook-toc-link) {
    background: transparent;
    border: 0;
    padding: 0.15rem 0.3rem;
    border-radius: var(--radius-sm);
    color: var(--accent);
    font-size: 0.9rem;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }
  .cookbook-toc :global(button.cookbook-toc-link:hover),
  .cookbook-toc :global(button.cookbook-toc-link:focus-visible) {
    background: var(--accent-weak);
    color: var(--text);
  }
  .cookbook-toc :global(button.cookbook-toc-sublink) {
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--text);
  }
  /* Rendered-recipe typography. Shared by the detail pane and the
     edit-time preview column — both wrap the {@html} output in
     `.cookbook-render`, so "what you see while editing" stays an
     honest preview of the saved view. Every color below resolves
     through theme variables (`--accent`, `--accent-weak`, `--bg-2`,
     `--border`, `--muted`, `--text`), so the six accent palettes ×
     light/dark combinations all flow through without extra work.

     The reader-content text-shadow thickener for `.cookbook-render` is
     applied globally in src/styles.css (see "Main-section reader-content
     thickener"), not here, so all main-section content shares one weight
     step. */

  /* Metadata strip — a row of chip-cards. Each `.cook-meta-item`
     stacks a tiny uppercase label (dt) over a bolder value (dd).
     flex-wrap keeps overflow honest when a recipe declares many
     extra metadata keys (cuisine, course, …) beyond the usual
     servings / prep / cook trio. */
  .cookbook-render :global(dl.cook-metadata) {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0.25rem 0 1rem;
  }
  .cookbook-render :global(dl.cook-metadata .cook-meta-item) {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.1rem;
    padding: 0.35rem 0.65rem;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    min-width: 3.5rem;
  }
  .cookbook-render :global(dl.cook-metadata dt) {
    margin: 0;
    font-size: 0.68rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .cookbook-render :global(dl.cook-metadata dd) {
    margin: 0;
    font-weight: 600;
    font-size: 0.95rem;
    color: var(--text);
  }

  /* Section heading (Ingredients / Cookware / Instructions). Promoted
     from "muted label" to "new section" — accent color plus a thin
     accent-weak rule. The letter-spacing and uppercase are preserved
     from the old style so the page still reads as a recipe card, not
     a blog post. */
  .cookbook-render :global(h3) {
    margin: 1.25rem 0 0.5rem;
    padding-bottom: 0.35rem;
    font-size: 0.95rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent);
    border-bottom: 1px solid var(--accent-weak);
  }

  /* Per-section subheading inside Ingredients / Instructions
     (e.g. "Soup" / "Finishing" / "For serving"). An accent bar on the
     left gives the subsections hierarchy without competing with the
     h3 above. */
  .cookbook-render :global(h4.cook-section) {
    margin: 0.9rem 0 0.35rem;
    padding: 0 0 0 0.55rem;
    font-size: 0.9rem;
    border-left: 3px solid var(--accent);
    color: var(--text);
  }

  /* Ingredient / cookware bullets — drop the browser disc in favour
     of a small accent dot drawn via ::before. `top` is set in `em`
     so the marker tracks line-height regardless of font-size. */
  .cookbook-render :global(ul.cook-ingredients),
  .cookbook-render :global(ul.cook-cookware) {
    list-style: none;
    margin: 0.25rem 0 0.75rem;
    padding: 0;
  }
  .cookbook-render :global(ul.cook-ingredients li),
  .cookbook-render :global(ul.cook-cookware li) {
    position: relative;
    padding: 0.15rem 0 0.15rem 1rem;
  }
  .cookbook-render :global(ul.cook-ingredients li::before),
  .cookbook-render :global(ul.cook-cookware li::before) {
    content: '';
    position: absolute;
    left: 0.2rem;
    top: 0.7em;
    width: 0.35rem;
    height: 0.35rem;
    border-radius: var(--radius-round);
    background: var(--accent);
    opacity: 0.75;
  }

  /* Quantity chip — tiny inline pill that picks up the accent tint.
     Lets a skimming eye lock onto the numbers first ("1 cup… 2 tsp…")
     before resolving the ingredient name. `tabular-nums` keeps mixed
     quantities like "1½" and "6-8" visually even. */
  .cookbook-render :global(.cook-qty) {
    display: inline-block;
    padding: 0.05rem 0.45rem;
    margin-right: 0.25rem;
    background: var(--accent-weak);
    color: var(--text);
    border-radius: var(--radius-pill);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  /* "(optional)" tag emitted by recipeToHtml for `@?ingredient`
     references - muted and small so required items read first when
     the eye scans the list. */
  .cookbook-render :global(.cook-optional) {
    color: var(--muted);
    font-size: 0.85em;
    font-style: italic;
  }

  /* Grocery checkbox on bookmarked recipes' ingredient rows. Sized as
     a thumb target (matching the grocery list's own checkboxes) and
     vertically centered against the qty pill so a tall row reads as
     one line. */
  .cookbook-render :global(.cook-buy) {
    width: 1.05rem;
    height: 1.05rem;
    margin-right: 0.35rem;
    vertical-align: -0.15rem;
    accent-color: var(--accent);
    cursor: pointer;
  }

  /* The whole row is the toggle target (native label semantics) -
     the pointer cursor advertises that the text is tappable too,
     which matters for thumbs that would otherwise aim at the tiny
     box. */
  .cookbook-render :global(.cook-buy-label) {
    cursor: pointer;
  }

  /* Batch add-all shortcut above the rendered recipe, tucked toward
     the reading column's right edge so it reads as an action on the
     content below rather than part of the action bar above. */
  .cookbook-add-all-row {
    display: flex;
    justify-content: flex-end;
    margin: 0.25rem 0;
  }
  .cookbook-add-all {
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--accent);
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .cookbook-add-all:disabled {
    opacity: 0.6;
    cursor: default;
  }

  /* Instruction steps — replace the browser-default "1." marker with
     a circular accent-weak badge via CSS counters. The hanging indent
     keeps multi-line step text flowing under itself instead of
     crashing into the badge. */
  .cookbook-render :global(ol.cook-steps) {
    list-style: none;
    counter-reset: cook-step;
    margin: 0.35rem 0 0.75rem;
    padding: 0;
  }
  .cookbook-render :global(ol.cook-steps li) {
    counter-increment: cook-step;
    position: relative;
    padding: 0.15rem 0 0.6rem 2.1rem;
    line-height: 1.45;
    /* Hint that the step is tappable — click toggles `.is-active`. The
       `onRenderClick` handler in this component only reacts to clicks
       inside `ol.cook-steps`, so the cursor stays accurate. */
    cursor: pointer;
  }
  .cookbook-render :global(ol.cook-steps li::before) {
    content: counter(cook-step);
    position: absolute;
    left: 0;
    top: 0;
    width: 1.5rem;
    height: 1.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--accent-weak);
    color: var(--text);
    font-size: 0.8rem;
    font-weight: 700;
    border-radius: var(--radius-round);
  }
  /* Highlighted step — a soft accent-weak wash that tells the reader
     "this is the step I'm on" while cooking. Full-bleed padding so the
     tint extends to the badge edge on the left and the pane edge on
     the right, making the active step the obvious focal point at a
     glance. Inherits the theme accent, so a blue theme gets a blue
     wash and a red theme gets a red wash — no per-theme overrides
     needed. */
  .cookbook-render :global(ol.cook-steps li.is-active) {
    background: var(--accent-weak);
    border-radius: var(--radius-md);
    margin: 0 -0.4rem;
    padding-right: 0.4rem;
    padding-left: 2.5rem;
  }
  .cookbook-render :global(ol.cook-steps li.is-active::before) {
    left: 0.4rem;
  }
  .cookbook-edit-panes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }
  @media (max-width: 800px) {
    .cookbook-edit-panes {
      grid-template-columns: 1fr;
    }
  }
  .cookbook-edit-textarea {
    width: 100%;
    min-height: 260px;
    font-size: 0.85rem;
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    resize: vertical;
  }
  .cookbook-syntax-hint {
    font-size: 0.75rem;
    margin: 0.25rem 0 0;
  }
  .cookbook-syntax-hint code {
    background: var(--border);
    padding: 0 0.25rem;
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
  }
  .cookbook-edit-preview {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.5rem 0.75rem;
    min-height: 260px;
    max-height: 320px;
    overflow: auto;
    background: var(--bg);
  }
  .cookbook-change-message-hint {
    font-size: 0.75rem;
    margin: 0.25rem 0 0;
  }
  /* Version banner sits in the detail-header slot when viewing a past
     snapshot. Renders as a muted line under the title rather than a
     full alert pill - the action bar below is the load-bearing
     affordance and we don't want to compete with it visually. */
  .cookbook-version-banner-meta {
    margin: 0 0 0.75rem;
    font-size: 0.85rem;
  }
  /* History panel. Lives at the bottom of the detail pane, collapsed
     by default. Border-top reads as "the recipe ends here, history
     starts below"; the summary stays muted so the recipe content
     keeps visual priority. */
  .cookbook-history {
    margin-top: 1.25rem;
    border-top: 1px solid var(--border);
    padding-top: 0.75rem;
  }
  .cookbook-history > summary {
    cursor: pointer;
    font-weight: 600;
    font-size: 0.9rem;
    color: var(--muted);
    user-select: none;
    padding: 0.25rem 0;
  }
  .cookbook-history > summary:hover {
    color: var(--text);
  }
  .cookbook-history-list {
    list-style: none;
    padding: 0;
    margin: 0.5rem 0 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .cookbook-history-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    width: 100%;
    padding: 0.5rem 0.6rem;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    color: var(--text);
    text-align: left;
    cursor: pointer;
    font-size: 0.85rem;
  }
  .cookbook-history-row:hover {
    background: var(--bg-2);
    border-color: var(--border);
  }
  /* Currently-viewed past version: accent-weak fill + accent border so
     it's obvious which row the body above is mirroring. */
  .cookbook-history-row.is-active {
    background: var(--accent-weak);
    border-color: var(--accent);
  }
  /* The latest row when no past version is being viewed - subtle tint
     that signals "this is what you're looking at" without competing
     with the detail body. */
  .cookbook-history-row.is-current {
    background: var(--bg-2);
    border-color: var(--border);
  }
  .cookbook-history-date {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 600;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .cookbook-history-badge {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-pill);
    background: var(--accent-weak);
    color: var(--text);
  }
  .cookbook-history-message {
    color: var(--text);
  }

  /* Photo strip on the detail pane. Sits as a sibling above the
     cooklang-render div so the thumbnails appear over the metadata
     block (where servings is) without the strip having to live
     inside the {@html} output. Wraps to multiple rows on narrow
     panels - we deliberately don't horizontal-scroll so every photo
     is reachable without a swipe gesture, which mobile users miss. */
  .recipe-photos-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.25rem 0 1rem;
  }
  /* Wrapper so the optional caption sits directly under the thumb
     and the strip wraps as a unit (thumb + caption together) rather
     than splitting a caption away from its image at a wrap point.
     Reset the default <figure> margin so the wrapper doesn't push
     the strip's own gap. */
  .photo-thumb-figure {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    width: 96px;
    margin: 0;
  }
  .photo-thumb {
    width: 96px;
    height: 96px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-2);
    cursor: pointer;
    overflow: hidden;
    /* Reset the surrounding button reset so focus rings still land
       cleanly on the tile and not on its inner image. */
    display: block;
  }
  .photo-thumb:hover,
  .photo-thumb:focus-visible {
    border-color: var(--accent);
  }
  .photo-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  /* Caption under the thumbnail. Italic per the spec; muted colour
     so the recipe text below stays the focal point. The two-line
     clamp keeps a long caption from pushing the strip's row height
     past what the thumbnail establishes - the full text is still
     visible on hover (img title) and in the lightbox. */
  .photo-thumb-caption {
    margin: 0.25rem 0 0;
    font-size: 0.75rem;
    color: var(--muted);
    text-align: center;
    line-height: 1.25;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  /* Edit pane photo grid. Shares the thumb visual with the detail
     strip but adds a per-cell action toolbar (move left / right /
     remove) and a size hint underneath. The "+ Add photo" tile is a
     <label> wrapping a hidden file input so the whole tile is the
     click target. */
  .recipe-photos-edit {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.25rem 0 0.25rem;
  }
  .recipe-photo-edit-cell {
    width: 110px;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .recipe-photo-edit-cell img {
    width: 110px;
    height: 110px;
    object-fit: cover;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-2);
    display: block;
  }
  .recipe-photo-edit-cell-actions {
    display: flex;
    gap: 0.15rem;
    justify-content: center;
  }
  /* Tighter icon-button styling for the per-cell actions - the cell
     is small and four chunky buttons would crowd the tile. */
  .recipe-photo-edit-cell-actions :global(button.icon-btn) {
    background: var(--bg-2);
    padding: 0.1rem 0.4rem;
    font-size: 1rem;
    line-height: 1;
    min-width: 1.6rem;
  }
  .recipe-photo-edit-cell-actions :global(button.icon-btn:disabled) {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .recipe-photo-edit-meta {
    text-align: center;
    font-size: 0.7rem;
  }
  /* In-memory caption input. Slim styling so two adjacent cells fit
     side-by-side on narrow viewports the same way they did before
     the input arrived. The text typed here doesn't save until the
     user clicks Save - matches the form's "everything moves on
     submit" model. */
  .recipe-photo-edit-label {
    width: 100%;
    box-sizing: border-box;
    padding: 0.2rem 0.35rem;
    font-size: 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
  }
  .recipe-photo-edit-label:focus-visible {
    outline: none;
    border-color: var(--accent);
  }
  .recipe-photo-edit-add {
    width: 110px;
    height: 110px;
    border: 1px dashed var(--border);
    border-radius: var(--radius);
    background: var(--bg-2);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    cursor: pointer;
    color: var(--muted);
    font-size: 1.5rem;
    line-height: 1;
  }
  .recipe-photo-edit-add:hover,
  .recipe-photo-edit-add:focus-within {
    border-color: var(--accent);
    color: var(--text);
  }
  /* Hide the file input itself - the surrounding <label> is the
     visible target. Width/height 0 + opacity 0 instead of
     `display:none` so keyboard focus still lands on it. */
  .recipe-photo-edit-add input[type='file'] {
    width: 0;
    height: 0;
    opacity: 0;
    position: absolute;
  }
  .recipe-photo-errors {
    margin: 0.5rem 0;
    padding-left: 1.25rem;
    font-size: 0.85rem;
  }

  /* Lightbox. Full-viewport dim backdrop with the photo centered.
     The image caps at 95vw/85vh so a portrait photo doesn't push
     the close button or counter off the screen on small viewports. */
  .recipe-lightbox-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: rgba(0, 0, 0, 0.85);
  }
  /* Clips the carousel track so the parked prev/next slides and any
     mid-drag overscroll stay hidden. Fills the backdrop; the chrome
     (close, arrows, caption, counter) are siblings rendered after it,
     so they sit on top without being clipped. */
  .recipe-lightbox-viewport {
    position: absolute;
    inset: 0;
    overflow: hidden;
    /* Let clicks on the dim surround fall through to the backdrop's
       dismiss handler; only the <img> below opts back in, so clicking
       the photo keeps the viewer open while clicking around it closes
       it. Touch events still reach the backdrop's swipe handlers via
       bubbling, so this doesn't affect the gesture. */
    pointer-events: none;
  }
  /* Flex row of three viewport-width slides. Its own box width is one
     viewport, so the percentage transforms in lightboxTrackStyle land
     exactly on slide boundaries. transform + transition are supplied
     inline per phase. will-change keeps the slide on its own layer so
     the finger-follow stays smooth on mobile. */
  .recipe-lightbox-track {
    display: flex;
    width: 100%;
    height: 100%;
    will-change: transform;
  }
  .recipe-lightbox-slide {
    flex: 0 0 100%;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    /* The 1rem gutter that used to live on the backdrop's padding;
       keeps the image off the very edge on small screens. */
    padding: 1rem;
  }
  .recipe-lightbox-img {
    max-width: 95vw;
    max-height: 85vh;
    object-fit: contain;
    border-radius: var(--radius-md);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    cursor: default;
    /* Re-enable pointer events the viewport turned off, so a click on
       the photo registers on the image (target !== backdrop) and does
       not dismiss the viewer. */
    pointer-events: auto;
    /* Suppress the browser's native image-drag ghost so a mouse drag
       across the photo doesn't fight the swipe affordance. */
    user-select: none;
    -webkit-user-drag: none;
  }
  .recipe-lightbox-close {
    position: absolute;
    top: 0.75rem;
    right: 1rem;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: var(--radius-round);
    border: 1px solid rgba(255, 255, 255, 0.4);
    background: rgba(0, 0, 0, 0.4);
    color: white;
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
    /* Flex-center the glyph. A bare button lays the U+00D7 out on the
       text baseline with the button's default padding, which parked
       the x high and left of the circle's center. Centering both axes
       and zeroing the padding pins it to the middle regardless of the
       glyph's own metrics. */
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }
  .recipe-lightbox-close:hover,
  .recipe-lightbox-close:focus-visible {
    background: rgba(0, 0, 0, 0.7);
    border-color: white;
  }
  /* Paging arrows pinned to the left/right edges of the viewport and
     centered vertically. translateY(-50%) re-centers against the
     button's own height after top:50% anchors its top edge. The wide
     hit target (the button is taller than the glyph) keeps them
     thumb-reachable on mobile. */
  .recipe-lightbox-nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 2.75rem;
    height: 3.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(255, 255, 255, 0.4);
    background: rgba(0, 0, 0, 0.4);
    color: white;
    font-size: 2rem;
    line-height: 1;
    padding: 0;
    cursor: pointer;
  }
  .recipe-lightbox-nav.prev {
    left: 0;
    border-left: none;
    border-radius: 0 var(--radius-md) var(--radius-md) 0;
  }
  .recipe-lightbox-nav.next {
    right: 0;
    border-right: none;
    border-radius: var(--radius-md) 0 0 var(--radius-md);
  }
  .recipe-lightbox-nav:hover,
  .recipe-lightbox-nav:focus-visible {
    background: rgba(0, 0, 0, 0.7);
    border-color: white;
  }
  .recipe-lightbox-counter {
    position: absolute;
    bottom: 1rem;
    left: 50%;
    transform: translateX(-50%);
    color: rgba(255, 255, 255, 0.85);
    font-size: 0.85rem;
    background: rgba(0, 0, 0, 0.4);
    padding: 0.2rem 0.6rem;
    border-radius: var(--radius-pill);
  }
  /* Lightbox caption. Sits above the counter so the two pieces of
     chrome don't overlap on narrow viewports. max-width caps the
     line length on a wide-screen so a long caption doesn't extend
     off-image; max-height plus overflow lets the caption scroll
     if the user wrote a paragraph rather than a phrase. */
  .recipe-lightbox-caption {
    position: absolute;
    bottom: 3rem;
    left: 50%;
    transform: translateX(-50%);
    color: rgba(255, 255, 255, 0.95);
    font-size: 0.95rem;
    background: rgba(0, 0, 0, 0.5);
    padding: 0.35rem 0.75rem;
    border-radius: var(--radius-md);
    max-width: min(80ch, 90vw);
    max-height: 6rem;
    overflow: auto;
    text-align: center;
    line-height: 1.35;
  }
</style>

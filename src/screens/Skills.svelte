<script lang="ts">
  /*
   * Skills panel - the main-panel surface for the Skills drawer tab.
   * Mounted when `drawerTab === 'skills'`. Sibling of Memories.svelte
   * and Wiki.svelte: the sidebar `SkillList` is the browse surface,
   * this panel renders one skill at a time keyed by `route.skill`,
   * and with no selection it renders the paged browse list plus the
   * create button (there is no changelog to default to).
   *
   * A small state machine over `route.skill` plus local mode; the
   * full precedence list lives in the `skillsPanelSurface` docstring
   * in `$lib/ui/skills`. Which surface renders is decided by that
   * function (pure, tested); this file is the reactive wire-up:
   *
   *   - list     : browse rows + New skill (default; also where a
   *                failed open-skill fetch lands, notice in tow)
   *   - create   : empty form
   *   - detail   : the open skill, body rendered as markdown
   *   - edit     : form over the open skill
   *   - loading  : open-skill fetch in flight
   *
   * Realtime + bus handling: the skill-events bus is coarse -
   * "something changed", no payload - so on each event the panel
   * refreshes the listing and refetches the open skill, then
   * classifies it. A DELETE (getSkill null) wins over everything:
   * detail / edit / confirm-delete collapse to the list with a
   * "removed elsewhere" notice, and tearing the confirm strip down
   * first is what prevents a double delete. An UPDATE never clobbers
   * an open edit form - the local Save wins on submit (no version
   * column, last write wins, same as every other nak panel).
   *
   * Browser writes go through the facade (`saveSkill` / `deleteSkill`
   * - the user's session client, RLS in force), which stamps
   * `last_author = 'user'`; no tool harness on this path.
   */
  import { app } from '$lib/state.svelte';
  import { route, navigate } from '$lib/routing.svelte';
  import {
    skillsStore,
    runSkillsSearch,
    refreshSkillsListing,
    loadMoreSkills,
    patchSkillRow,
    removeSkillRow,
  } from '$lib/skills-store.svelte';
  import {
    MAX_SKILL_NAME_CHARS,
    MAX_SKILL_DESCRIPTION_CHARS,
    MAX_SKILL_BODY_CHARS,
  } from '$lib/skills';
  import { emitSkillChange, onSkillChange } from '$lib/skill-events';
  // Panel-side UI-behavior primitives - every display decision this
  // screen makes (surface selection, action-status vocabulary, form
  // validation, notice copy, formatters) lives in the companion
  // module; this file is Svelte wire-up.
  import {
    SEARCH_FILTERED_HINT,
    SKILL_NOT_FOUND_NOTICE,
    SKILL_REMOVED_ELSEWHERE_NOTICE,
    type SkillActionStatus,
    type SkillsOpenState,
    type SkillsPanelMode,
    type SkillsPanelSurface,
    isDuplicateSkillNameError,
    lastAuthorLabel,
    panelEmptyMessage,
    searchExcludesOpenSkill,
    skillActionNotice,
    skillFormError,
    skillsPanelSurface,
  } from '$lib/ui/skills';
  import { rowSnippet } from '$lib/ui/skills-list';
  // Reused from the memories panel rather than copied: identical
  // longhand "N min ago" vocabulary, and the memories module's own
  // docstring records why its samskara twin isn't shared (different
  // vocabulary) - the sharing line falls exactly here.
  import { relativeTime } from '$lib/ui/memories';
  import { infiniteScroll } from '$lib/actions/infinite-scroll';
  import type { Skill } from '$lib/supabase';
  import Markdown from '../components/Markdown.svelte';
  import Scanner from '../components/Scanner.svelte';

  // --- Open-skill fetch -------------------------------------------

  // The full row for the routed skill. Store rows are the body-less
  // summary projection (bodies load on demand everywhere in this
  // feature), so the detail view resolves through getSkill rather
  // than the listing.
  let openSkill = $state<Skill | null>(null);
  let openState = $state<SkillsOpenState>('idle');

  $effect(() => {
    const id = route.skill;
    const supabase = app.supabase;
    if (!id || !supabase) {
      openSkill = null;
      openState = 'idle';
      return;
    }
    let cancelled = false;
    openState = 'loading';
    void supabase
      .getSkill(id)
      .then((row) => {
        if (cancelled) return;
        if (row) {
          openSkill = row;
          openState = 'ok';
        } else {
          // getSkill null for the open id (stale URL, deleted
          // elsewhere, account switch - RLS makes the three
          // indistinguishable) lands on the list with a notice.
          // `notice` is deliberately NOT reset here: it must survive
          // the route clears that follow the realtime-DELETE collapse
          // and the confirmed delete.
          openSkill = null;
          openState = 'missing';
          notice = SKILL_NOT_FOUND_NOTICE;
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        openSkill = null;
        openState = 'error';
        notice = `Couldn't load that skill - ${
          err instanceof Error ? err.message : String(err)
        }`;
      });
    return () => {
      cancelled = true;
    };
  });

  // --- Panel mode, form, delete strip ------------------------------

  let mode = $state<SkillsPanelMode>('list');
  // Which surface opened the confirm-delete strip, so Cancel returns
  // there (back to whichever of detail / edit opened it).
  let confirmDelete = $state<'detail' | 'edit' | null>(null);
  // Why the panel is showing the list instead of a detail: not-found,
  // removed-elsewhere, or a load failure. Set only at the moments
  // those happen; cleared by the route-teardown effect below and by
  // startCreate.
  let notice = $state<string | null>(null);
  let actionStatus = $state<SkillActionStatus>({ kind: 'idle' });
  const actionNotice = $derived(skillActionNotice(actionStatus));

  let formName = $state('');
  let formDescription = $state('');
  let formBody = $state('');

  function clearForm(): void {
    formName = '';
    formDescription = '';
    formBody = '';
  }

  // Route teardown: a navigation TO a skill row (sidebar click or
  // panel row click) discards unsaved panel state - same semantics
  // as Cancel then click. Only real navigations count: clearing the
  // route (startCreate, confirmed delete, the realtime DELETE
  // collapse) is always paired with the caller's own state writes,
  // and re-running here would clobber them.
  let lastRoutedSkill: string | null = null;
  $effect(() => {
    const id = route.skill;
    const prev = lastRoutedSkill;
    lastRoutedSkill = id;
    if (id === null || id === prev) return;
    mode = 'list';
    confirmDelete = null;
    notice = null;
    actionStatus = { kind: 'idle' };
    clearForm();
  });

  // Initial fetch of the listing. The sidebar's debounced effect
  // covers query changes; this fires the very first load when the
  // panel mounts so the user lands on a non-empty list. The store's
  // `loaded`-gate stops an empty account from re-firing forever.
  $effect(() => {
    if (!app.supabase) return;
    if (!skillsStore.loaded && !skillsStore.loading) {
      void runSkillsSearch(app.supabase);
    }
  });

  function pickSkill(id: string): void {
    navigate({ skill: id });
  }

  function startCreate(): void {
    // Clear a stale routed id (a not-found notice leaves one behind)
    // so the form is the whole surface and Cancel returns to a clean
    // list.
    if (route.skill) navigate({ skill: null });
    mode = 'create';
    confirmDelete = null;
    notice = null;
    actionStatus = { kind: 'idle' };
    clearForm();
  }

  function startEdit(): void {
    if (!openSkill) return;
    formName = openSkill.name;
    formDescription = openSkill.description;
    formBody = openSkill.body;
    mode = 'edit';
    confirmDelete = null;
    actionStatus = { kind: 'idle' };
  }

  function cancelForm(): void {
    // No walking away mid-write - the Supabase call is in flight and
    // the UI must stay paired with its outcome (the memories panel's
    // cancelEdit rationale, copied).
    if (actionStatus.kind === 'saving') return;
    // Create lands on the list; edit lands back on the detail of the
    // still-open skill - mode 'list' covers both because the surface
    // derives from route.skill.
    mode = 'list';
    clearForm();
    actionStatus = { kind: 'idle' };
    // A remote update that landed while the edit form was open was
    // skipped by the classification listener (an open edit form is
    // never clobbered), so the in-memory row still holds the
    // pre-form snapshot. Refetch so the detail the user returns to
    // reflects current truth; best-effort, a failure leaves the
    // snapshot standing (the next bus event retries).
    const id = route.skill;
    const supabase = app.supabase;
    if (id && supabase) {
      void supabase
        .getSkill(id)
        .then((row) => {
          if (route.skill !== id) return;
          if (row) {
            openSkill = row;
            openState = 'ok';
          }
        })
        .catch(() => {
          // Intentional silence: cancel is not a reporting surface,
          // and the pre-form snapshot is a valid fallback view.
        });
    }
  }

  async function saveForm(): Promise<void> {
    if (mode !== 'create' && mode !== 'edit') return;
    if (!app.supabase) return;
    const editingId = mode === 'edit' && openSkill ? openSkill.id : undefined;
    const name = formName.trim();
    const description = formDescription.trim();
    // The body is taken verbatim - trailing whitespace in an
    // instruction body is the author's call.
    const body = formBody;
    const validationError = skillFormError(
      name,
      description,
      body,
      skillsStore.results,
      editingId,
    );
    if (validationError) {
      actionStatus =
        validationError.kind === 'duplicate-name'
          ? { kind: 'duplicate-name' }
          : { kind: 'error', action: 'save', message: validationError.message };
      return;
    }
    actionStatus = { kind: 'saving' };
    try {
      const saved = await app.supabase.saveSkill({
        id: editingId,
        name,
        description,
        body,
      });
      // The store patch / row removal is id-keyed and safe, but the
      // panel-state writes race navigation: the user may have opened
      // another skill (or left to the list) while the save was in
      // flight, and a late write for the old target would mislabel
      // whatever is open now. Re-check that the panel still shows
      // the target before touching it (the classification listener's
      // guard pattern); the route-teardown effect already reset the
      // panel for whatever is open instead.
      const panelStillOnTarget = editingId
        ? route.skill === editingId
        : route.skill === null;
      if (editingId) {
        // Edit save: re-render the detail from this write, not a
        // refetch, and patch the listing row so the new name shows
        // without a round trip.
        patchSkillRow(saved.id, {
          name: saved.name,
          description: saved.description,
          updated_at: saved.updated_at,
          last_author: saved.last_author,
        });
        if (panelStillOnTarget) {
          openSkill = saved;
          openState = 'ok';
        }
      } else if (panelStillOnTarget) {
        // Create save: navigate to the new id; the route-watch fetch
        // above loads its detail.
        navigate({ skill: saved.id });
      }
      if (panelStillOnTarget) {
        mode = 'list';
        clearForm();
      }
      // Reset unconditionally: a stuck 'saving' would wedge every
      // later form. Not exclusively owned by this flight - if the
      // user navigated and started ANOTHER save while this one was
      // in flight, this reset clears that newer flight's 'saving'
      // status early (its buttons re-enable mid-write). Harmless:
      // a double submit is last-write-wins on edit and bounces off
      // 23505 into the named duplicate status on create.
      actionStatus = { kind: 'idle' };
      // Emit last: by now route/mode hold the post-save truth, so
      // the classification listener below reads a consistent view
      // (and its refetch, if any, lands identical data).
      emitSkillChange();
    } catch (err) {
      // Stay in the form on failure (create/edit holds); the named
      // duplicate status covers both the client-side catch and the
      // PostgREST 23505 that slips past it.
      const msg = err instanceof Error ? err.message : String(err);
      actionStatus = isDuplicateSkillNameError(msg)
        ? { kind: 'duplicate-name' }
        : { kind: 'error', action: 'save', message: msg };
    }
  }

  function requestDelete(): void {
    if (!openSkill) return;
    confirmDelete = mode === 'edit' ? 'edit' : 'detail';
    actionStatus = { kind: 'idle' };
  }

  function cancelDelete(): void {
    confirmDelete = null;
    if (actionStatus.kind === 'error' && actionStatus.action === 'delete') {
      actionStatus = { kind: 'idle' };
    }
  }

  async function confirmDeleteSkill(): Promise<void> {
    if (!openSkill || !app.supabase) return;
    const id = openSkill.id;
    actionStatus = { kind: 'deleting' };
    try {
      await app.supabase.deleteSkill(id);
      // The row removal is id-keyed and safe. The panel-state writes
      // below race navigation: if the user opened another skill while
      // the delete was in flight, the route-teardown effect already
      // reset the panel for it, and nulling the open skill here would
      // mislabel whatever is open now (the classification listener's
      // guard pattern).
      removeSkillRow(id);
      const stillOpen = route.skill === id;
      if (stillOpen) {
        navigate({ skill: null });
        openSkill = null;
        openState = 'idle';
        mode = 'list';
        confirmDelete = null;
        notice = null;
        clearForm();
      }
      // Unconditional: a stuck 'deleting' would wedge every later
      // form; the same newer-flight caveat as the save reset above
      // applies and is equally harmless.
      actionStatus = { kind: 'idle' };
      emitSkillChange();
    } catch (err) {
      // Leave the strip open with the error - the user can retry or
      // cancel (the wiki delete-confirm shape).
      actionStatus = {
        kind: 'error',
        action: 'delete',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // --- Skill-event classification (realtime + panel writes) -------

  // The panel is the bus's listing consumer (the store itself never
  // subscribes, matching the memories panel's shape). On each event:
  // refresh the listing, then reclassify the open skill.
  $effect(() => {
    return onSkillChange(() => {
      const supabase = app.supabase;
      // Listing refresh. Every emitter - the panel's own writes and
      // Chat.svelte's realtime relay of the server-side skills tool -
      // means "the listing may be stale": a create lands a new browse
      // row, an edit renames one in place, a delete drops one, and a
      // search re-runs. Browse regime keeps the scrolled depth
      // (refreshSkillsListing's one-query refresh); search regime
      // just re-runs.
      if (supabase) {
        void (skillsStore.query.trim().length > 0
          ? runSkillsSearch(supabase)
          : refreshSkillsListing(supabase));
      }
      const id = route.skill;
      // No open skill, nothing to classify. (Panel-originated events
      // usually take this path too: save navigated already or edit
      // mode guards the UPDATE branch below.)
      if (!id || !supabase) return;
      void supabase
        .getSkill(id)
        .then((row) => {
          // The user may have navigated while the classifying fetch
          // was in flight; a late write for the old id would
          // mislabel whatever is open now.
          if (route.skill !== id) return;
          if (row) {
            // UPDATE. An open edit form is never clobbered - skip
            // the refresh entirely; the local Save wins on submit
            // (last write wins). A confirm-delete strip over a row
            // that still exists stays up: in detail mode the data
            // behind it refreshes here, while in edit mode this
            // early return leaves the form's snapshot standing
            // (cancelForm refetches when the form closes).
            if (mode === 'edit') return;
            openSkill = row;
            openState = 'ok';
          } else {
            // DELETE - wins over every other panel state. Collapse
            // detail / edit / confirm-delete to the list with the
            // removed-elsewhere notice. Clearing confirmDelete
            // before anything else is the "never double-delete"
            // guarantee: the confirm button's render condition is
            // gone, and the handler's openSkill guard backs it up.
            confirmDelete = null;
            mode = 'list';
            openSkill = null;
            openState = 'missing';
            notice = SKILL_REMOVED_ELSEWHERE_NOTICE;
            clearForm();
            actionStatus = { kind: 'idle' };
            if (route.skill === id) navigate({ skill: null });
          }
        })
        .catch(() => {
          // Classification is best-effort: a failed refetch leaves
          // the current view standing; the next event retries.
        });
    });
  });

  const surface = $derived<SkillsPanelSurface>(
    skillsPanelSurface({
      mode,
      routedSkill: route.skill,
      openState,
    }),
  );

  // A search filters the listing surfaces only - the open detail
  // stays rendered even when its row fell out of the results, with
  // the clear-the-search hint explaining the row's absence.
  const selectionFiltered = $derived(
    surface === 'detail' &&
      searchExcludesOpenSkill(skillsStore.query, route.skill, skillsStore.results),
  );
</script>

<section class="skills-panel" aria-label="Skills">
  <div class="skills-body">
    {#if notice}
      <p class="subtle skills-notice">{notice}</p>
    {/if}
    {#if skillsStore.error}
      <p class="error">{skillsStore.error}</p>
    {/if}

    {#if confirmDelete && openSkill && (surface === 'detail' || surface === 'edit')}
      <!-- Inline confirm strip, rendered over whichever of detail /
           edit opened it; Cancel below returns there because opening
           the strip never touches `mode`. -->
      <div class="skills-confirm-strip" aria-live="polite">
        <p>Really delete "{openSkill.name}"? This cannot be undone.</p>
        <div class="row">
          <button
            type="button"
            class="danger"
            onclick={confirmDeleteSkill}
            disabled={actionStatus.kind === 'deleting'}
          >Delete</button>
          <button
            type="button"
            onclick={cancelDelete}
            disabled={actionStatus.kind === 'deleting'}
          >Cancel</button>
        </div>
        {#if actionNotice}
          <p class={actionNotice.className}>{actionNotice.text}</p>
        {/if}
      </div>
    {/if}

    {#if surface === 'create' || surface === 'edit'}
      <!-- One form serves both modes; the heading is the only
           difference. maxlength + the live counters mirror the
           canonical caps from $lib/skills, so the form rejects
           early instead of bouncing off a Supabase error. -->
      <div class="skills-edit">
        <h2>{surface === 'create' ? 'New skill' : 'Edit skill'}</h2>
        <div class="form-row">
          <label for="skill-name">Name</label>
          <input
            id="skill-name"
            type="text"
            maxlength={MAX_SKILL_NAME_CHARS}
            placeholder="e.g. release-notes"
            bind:value={formName}
          />
          <span class="subtle char-count">
            {formName.length}/{MAX_SKILL_NAME_CHARS}
          </span>
        </div>
        <div class="form-row">
          <label for="skill-description">Description</label>
          <input
            id="skill-description"
            type="text"
            maxlength={MAX_SKILL_DESCRIPTION_CHARS}
            placeholder="One to two sentences: when to use this"
            bind:value={formDescription}
          />
          <span class="subtle char-count">
            {formDescription.length}/{MAX_SKILL_DESCRIPTION_CHARS}
          </span>
        </div>
        <div class="form-row">
          <label for="skill-body">Body</label>
          <textarea
            id="skill-body"
            class="skills-body-edit"
            maxlength={MAX_SKILL_BODY_CHARS}
            placeholder="Markdown instructions, loaded when a task matches this skill"
            bind:value={formBody}
          ></textarea>
          <span class="subtle char-count">
            {formBody.length}/{MAX_SKILL_BODY_CHARS}
          </span>
        </div>
        <div class="skills-edit-footer">
          <div class="skills-save-state" aria-live="polite">
            {#if actionNotice}
              <span class={actionNotice.className}>{actionNotice.text}</span>
            {/if}
          </div>
          <div class="skills-edit-actions">
            <button
              type="button"
              class="secondary"
              onclick={cancelForm}
              disabled={actionStatus.kind === 'saving'}
            >Cancel</button>
            <button
              type="button"
              onclick={saveForm}
              disabled={actionStatus.kind === 'saving'}
            >{surface === 'create' ? 'Create' : 'Save'}</button>
          </div>
        </div>
      </div>
    {:else if surface === 'loading'}
      <p class="subtle">Loading that skill...</p>
    {:else if surface === 'detail'}
      <!-- Truthiness re-check is TypeScript narrowing only - the
           'detail' surface already implies the open skill resolved. -->
      {#if openSkill}
        {@const s = openSkill}
        <header class="skills-header">
          <h2 class="skills-title">{s.name}</h2>
          <div class="skills-actions">
            <button type="button" class="secondary" onclick={startEdit}>Edit</button>
            {#if !confirmDelete}
              <button type="button" class="secondary" onclick={requestDelete}>Delete</button>
            {/if}
          </div>
        </header>
        <!-- last_author is the whole v1 edit trail (no changelog
             table): every write path stamps who made it, so "last
             edited by you / by Nak" is the glanceable provenance. -->
        <p class="subtle skills-meta" title={s.updated_at}>
          Last edited by {lastAuthorLabel(s.last_author)} {relativeTime(s.updated_at)}
          &middot; created {relativeTime(s.created_at)}
        </p>
        <p class="skills-description">{s.description}</p>
        {#if selectionFiltered}
          <p class="subtle skills-filtered-hint">{SEARCH_FILTERED_HINT}</p>
        {/if}
        <div class="skills-content">
          <Markdown content={s.body} />
        </div>
      {/if}
    {:else}
      <!-- The list surface: the tab's default. Rows mirror the
           sidebar's (name + description snippet), the create
           affordance lives here because there is no changelog
           surface to host it, and the load-more sentinel below is
           the sidebar's twin so this list can also reach past the
           first page. -->
      <header class="skills-list-head">
        <h2>Skills</h2>
        <button type="button" class="secondary" onclick={startCreate}>New skill</button>
      </header>
      {#if skillsStore.loading && skillsStore.results.length === 0}
        <p class="subtle skills-empty">Loading skills...</p>
      {:else if skillsStore.results.length === 0}
        <p class="subtle skills-empty">{panelEmptyMessage(skillsStore.query)}</p>
      {:else}
        <ul class="skills-browse">
          {#each skillsStore.results as s (s.id)}
            <li>
              <button
                type="button"
                class="skills-browse-row"
                class:active={route.skill === s.id}
                aria-current={route.skill === s.id ? 'true' : undefined}
                onclick={() => pickSkill(s.id)}
              >
                <span class="skills-browse-name">{s.name}</span>
                {#if s.description}
                  <span class="skills-browse-snippet">{rowSnippet(s.description)}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
        {#if skillsStore.hasMore}
          <!-- Load-more sentinel. hasMore is forced false during a
               search (capped, unpaged), so this only appears in the
               browse regime. -->
          <div
            class="skills-list-sentinel"
            use:infiniteScroll={{ onHit: () => app.supabase && loadMoreSkills(app.supabase) }}
            aria-hidden="true"
          >
            {#if skillsStore.loadingMore}
              <Scanner label="Loading more skills" size={0.85} />
            {/if}
          </div>
        {/if}
      {/if}
    {/if}
  </div>
</section>

<style>
  .skills-panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .skills-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 1rem 1.25rem 2rem;
  }
  /* Why the panel is showing the list instead of a detail (stale
     link, removed elsewhere, load failure). Sits above whatever
     surface renders so it is seen once, not per row. */
  .skills-notice {
    margin: 0 0 0.75rem 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-2, var(--bg));
  }
  /* Confirm-delete strip - mirrors the wiki confirm-strip card. */
  .skills-confirm-strip {
    border: 1px solid var(--border);
    border-radius: var(--radius-md, var(--radius));
    padding: 1rem;
    margin-bottom: 1rem;
    background: var(--bg-2, var(--bg));
  }
  .skills-confirm-strip p {
    margin: 0 0 0.6rem 0;
  }
  /* Create / edit form - mirrors the memories edit card. */
  .skills-edit {
    border: 1px solid var(--border);
    border-radius: var(--radius-md, var(--radius));
    padding: 1rem;
    background: var(--bg-2, var(--bg));
  }
  .skills-edit h2,
  .skills-list-head h2 {
    margin: 0 0 0.75rem 0;
    font-size: 1.1rem;
    font-weight: 600;
  }
  .skills-edit .form-row {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-bottom: 0.75rem;
  }
  .skills-edit label {
    font-size: 0.8rem;
    color: var(--muted);
  }
  .skills-edit input,
  .skills-edit textarea {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.4rem 0.55rem;
    font: inherit;
    width: 100%;
  }
  .skills-body-edit {
    min-height: 10rem;
    resize: vertical;
    font-family: inherit;
  }
  .char-count {
    font-size: 0.75rem;
    align-self: flex-end;
  }
  .skills-edit-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .skills-save-state {
    font-size: 0.8rem;
    min-height: 1.1rem;
    flex: 1;
    min-width: 0;
  }
  .skills-edit-actions {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  /* Detail view. */
  .skills-header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.75rem;
    margin-bottom: 0.5rem;
  }
  .skills-title {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 600;
  }
  .skills-actions {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .skills-meta {
    margin: 0 0 0.75rem 0;
    font-size: 0.8rem;
  }
  /* The description is set off from the body: it is the trigger
     surface (what rides the per-turn index), not the instructions
     themselves. */
  .skills-description {
    margin: 0 0 0.75rem 0;
    font-style: italic;
  }
  .skills-filtered-hint {
    margin: 0 0 0.75rem 0;
    font-size: 0.8rem;
  }
  .skills-content {
    line-height: 1.6;
  }
  /* List surface. */
  .skills-list-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }
  .skills-empty {
    padding: 1.5rem 0;
    text-align: center;
  }
  .skills-browse {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .skills-browse-row {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    align-items: flex-start;
    text-align: left;
    width: 100%;
    padding: 0.55rem 0.7rem;
    border: 1px solid transparent;
    border-radius: var(--radius);
    background: transparent;
    color: var(--text);
    cursor: pointer;
    font-size: 0.9rem;
  }
  .skills-browse-row:hover {
    background: var(--surface);
  }
  .skills-browse-row.active {
    background: var(--accent-weak);
    border-color: var(--border);
  }
  .skills-browse-name {
    font-weight: 500;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .skills-browse-snippet {
    font-size: 0.8rem;
    color: var(--text-subtle, var(--text));
    opacity: 0.8;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Pagination sentinel - the sidebar's twin: a small box at the
     list tail the IntersectionObserver can catch as it nears the
     viewport. */
  .skills-list-sentinel {
    min-height: 1px;
    padding: 0.5rem 0;
  }
</style>

/**
 * UI-behavior primitives for the Skills detail panel. Pure functions
 * only - no runes, no Svelte imports, no DOM. The companion
 * `src/screens/Skills.svelte` composes these with its own
 * framework-native reactivity (the skillsStore reads, the open-skill
 * fetch, the skill-events classification listener, and the markup).
 *
 * Sibling modules split the skills surfaces: `skills-list.ts` owns
 * the sidebar listing. This module owns the decisions specific to
 * the panel: which body surface renders (the skillsPanelSurface
 * precedence list), the action-status vocabulary (including the
 * named 23505 duplicate-name status), form validation with per-field
 * caps, the notice copy, and the display formatters.
 *
 * Every cap comes from `$lib/skills` (the canonical constants the
 * wire schema and the edge tool share) rather than local copies -
 * the panel must reject at the same ceiling everyone else enforces.
 */

import {
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_NAME_CHARS,
} from '$lib/skills';
import type { SkillSummary } from '$lib/supabase';

// ---------------------------------------------------------------
// Panel surface selection
// ---------------------------------------------------------------

/**
 * The panel's local mode. `list` is the resting mode: with a routed
 * skill it renders that skill's detail, without one it renders the
 * browse list. `create` and `edit` mount the form (over nothing and
 * over the open skill respectively).
 */
export type SkillsPanelMode = 'list' | 'create' | 'edit';

/**
 * State of the open-skill fetch keyed by `route.skill`. `idle` means
 * no skill is routed; `missing` means getSkill returned null (stale
 * URL, deleted elsewhere, account switch); `error` means the fetch
 * itself failed. The surface function folds this into its fallback
 * row: any state where getSkill returns null lands on the list with
 * a notice.
 */
export type SkillsOpenState = 'idle' | 'loading' | 'ok' | 'missing' | 'error';

export type SkillsPanelSurface = 'list' | 'create' | 'loading' | 'detail' | 'edit';

/**
 * Which surface the panel body renders. Precedence, top to bottom:
 *
 *   - `create`: the local create mode wins while the form is open;
 *     the create button clears `route.skill` when it opens the form,
 *     so no detail competes with it.
 *   - `loading`: a skill is routed and its fetch is in flight with
 *     nothing rendered yet.
 *   - `edit`: the routed skill resolved AND the user opened the edit
 *     form over it.
 *   - `detail`: the routed skill resolved; the read view.
 *   - `list`: everything else - no selection, or a routed id whose
 *     fetch came back null / failed (the notice channel carries
 *     which of those happened; see notFoundNotice /
 *     removedElsewhereNotice).
 *
 * A routed skill that fails to resolve lands on `list` regardless of
 * mode: an edit form over a row that no longer exists has nothing to
 * save against, and the realtime-DELETE collapse clears the mode
 * before this can even be observed.
 */
export function skillsPanelSurface(view: {
  mode: SkillsPanelMode;
  routedSkill: string | null;
  openState: SkillsOpenState;
}): SkillsPanelSurface {
  if (view.mode === 'create') return 'create';
  if (view.routedSkill && view.openState === 'loading') return 'loading';
  if (view.routedSkill && view.openState === 'ok') {
    return view.mode === 'edit' ? 'edit' : 'detail';
  }
  return 'list';
}

/**
 * A search filters the listing surfaces only, never the open
 * detail: the detail stays rendered even when its row fell outside
 * the hits, and the panel shows the "clear the search" hint so the
 * row's absence reads as filtering, not as the skill vanishing.
 * True iff a search query is active AND the open id is missing from
 * the active result set. The query gate matters in the browse
 * regime: an open row that simply sits past the loaded browse
 * window is paging, not filtering, and must not get a
 * search-flavored hint.
 */
export function searchExcludesOpenSkill(
  query: string,
  id: string | null,
  results: Pick<SkillSummary, 'id'>[],
): boolean {
  if (id === null) return false;
  if (query.trim().length === 0) return false;
  return !results.some((r) => r.id === id);
}

// ---------------------------------------------------------------
// Notices (why the panel is showing the list instead of a detail)
// ---------------------------------------------------------------

/** Open-skill fetch came back null: stale link, deleted elsewhere,
 *  or an account switch (RLS makes the three indistinguishable). */
export const SKILL_NOT_FOUND_NOTICE =
  "That skill doesn't exist anymore. It may have been deleted, or the link is stale.";

/** Realtime classified the event as a DELETE of the open skill -
 *  which wins over every other panel state. */
export const SKILL_REMOVED_ELSEWHERE_NOTICE =
  'That skill was removed elsewhere.';

/** The open skill resolved but its row is filtered out of the
 *  listing surfaces' active search. Rendered alongside the detail,
 *  not instead of it. */
export const SEARCH_FILTERED_HINT =
  "This skill isn't in the current search results. Clear the search to see it in the list.";

// ---------------------------------------------------------------
// Action-status vocabulary
// ---------------------------------------------------------------

/**
 * Inline status for the panel's two write flows (the create / edit
 * form's Save, and the confirmed Delete). One vocabulary covers both
 * because only one action is ever in flight at a time: a single
 * skill is open, and its form and delete strip are mutually
 * exclusive surfaces.
 *
 * `duplicate-name` is a named status of its own: the unique
 * (user_id, lower(name)) constraint firing - either caught
 * client-side by skillFormError or surfacing as the PostgREST 23505
 * on save. It gets its own variant (not a generic error) because
 * the user's remedy is specific: pick a different name, or open the
 * existing skill and edit that one.
 *
 * There is no `saved` pulse: a successful save closes the form and
 * drops to the detail view (the Wiki panel's rationale - the form
 * closing IS the success signal, and a stale form left open invites
 * "did it actually save?" doubt).
 */
export type SkillActionStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'deleting' }
  | { kind: 'duplicate-name' }
  | { kind: 'error'; action: 'save' | 'delete'; message: string };

/**
 * The status line rendered in the form footer or the delete strip,
 * or null when idle. `className` matches the classes the panel's
 * stylesheet expects: informational states render subtle, errors use
 * the global `.error` helper.
 */
export function skillActionNotice(
  status: SkillActionStatus,
): { text: string; className: 'subtle' | 'error' } | null {
  if (status.kind === 'saving') return { text: 'Saving...', className: 'subtle' };
  if (status.kind === 'deleting') return { text: 'Deleting...', className: 'subtle' };
  if (status.kind === 'duplicate-name') {
    return {
      text: 'A skill with that name already exists. Names match case-insensitively.',
      className: 'error',
    };
  }
  if (status.kind === 'error') {
    const prefix = status.action === 'save' ? "Couldn't save" : "Couldn't delete";
    return { text: `${prefix} - ${status.message}`, className: 'error' };
  }
  return null;
}

/**
 * Does this save failure mean the (user_id, lower(name)) unique
 * constraint fired? Postgres surfaces 23505 to the browser client
 * as message text, not a structured code, so the check is textual -
 * same posture as the memories panel's duplicate-relation detector.
 */
export function isDuplicateSkillNameError(message: string): boolean {
  return (
    message.includes('23505') ||
    message.includes('duplicate key value') ||
    message.includes('unique constraint')
  );
}

// ---------------------------------------------------------------
// Form validation
// ---------------------------------------------------------------

/**
 * Validation outcome for the create / edit form. `duplicate-name`
 * is structured rather than a message string because the panel maps
 * it onto the NAMED duplicate action-status (with its own remedy
 * copy) instead of a generic error line.
 */
export type SkillFormError =
  | { kind: 'duplicate-name' }
  | { kind: 'field'; message: string };

/**
 * First validation error for the create / edit form, or null when
 * the draft is saveable. Check order matches the form's visual
 * order (name, description, body) so the reported error is always
 * the topmost offending field. Expects a pre-trimmed name and
 * description (the caller trims because it also sends the trimmed
 * text to the facade); the body is taken verbatim.
 *
 * The duplicate check is the client-side half of the 23505
 * handling: it catches a lower(name) collision against the loaded
 * rows before any round trip. It can only see the loaded browse window /
 * search set, so a duplicate past it still bounces off the DB
 * constraint - isDuplicateSkillNameError maps that failure onto the
 * same named status.
 *
 * `selfId` is the open skill's id in edit mode: keeping a skill's
 * own name must not read as a collision with itself.
 *
 * Caps are strict, with no allowance for old rows. The memories
 * body cap keeps extra headroom for rows written under a looser
 * earlier cap; no skills row can predate its cap, because the edge
 * tool and this panel enforce the same constants from day one.
 */
export function skillFormError(
  name: string,
  description: string,
  body: string,
  existing: Pick<SkillSummary, 'id' | 'name'>[],
  selfId?: string,
): SkillFormError | null {
  if (!name) return { kind: 'field', message: 'Name is required.' };
  if (name.length > MAX_SKILL_NAME_CHARS) {
    return {
      kind: 'field',
      message: `Name must be ${MAX_SKILL_NAME_CHARS} chars or fewer.`,
    };
  }
  const lowerName = name.toLowerCase();
  const clash = existing.some(
    (row) => row.id !== selfId && row.name.toLowerCase() === lowerName,
  );
  if (clash) return { kind: 'duplicate-name' };
  if (!description) {
    return { kind: 'field', message: 'Description is required.' };
  }
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    return {
      kind: 'field',
      message: `Description must be ${MAX_SKILL_DESCRIPTION_CHARS} chars or fewer.`,
    };
  }
  if (!body) return { kind: 'field', message: 'Body is required.' };
  if (body.length > MAX_SKILL_BODY_CHARS) {
    return {
      kind: 'field',
      message: `Body must be ${MAX_SKILL_BODY_CHARS} chars or fewer.`,
    };
  }
  return null;
}

// ---------------------------------------------------------------
// Display formatters
// ---------------------------------------------------------------

/**
 * Who last wrote the open skill's contents. The whole v1 edit trail
 * is this one column, so the label is the panel's "last edited by
 * you / by Nak" line - the persistent marker for model-authored
 * edits, chosen over a changelog table.
 */
export function lastAuthorLabel(lastAuthor: 'user' | 'assistant'): string {
  return lastAuthor === 'assistant' ? 'Nak' : 'you';
}

/**
 * Empty-state copy for the panel's list surface. Two readings share
 * the rendering: an active query that excluded everything ("no
 * matches"), and a cold account that has no skills at all (the
 * explainer pointing at the create button). Parallel to
 * `emptyMessage` in `skills-list.ts` - the sidebar's copy is terser
 * because it sits in a narrow column.
 */
export function panelEmptyMessage(query: string): string {
  const trimmed = query.trim();
  return trimmed.length > 0
    ? `No skills match "${trimmed}".`
    : 'Nothing here yet. Skills are reusable instructions for recurring tasks - create one with the New skill button.';
}

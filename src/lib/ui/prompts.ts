/*
 * Pure list-transform primitives for the Custom prompts settings pane.
 *
 * The pane keeps a local `SystemPrompt[]` working copy and pushes the
 * whole array to Supabase (debounced) on every change. Every mutation
 * the pane performs - add, edit one field, delete, reorder by drag -
 * is a next-state computation over that array, which the
 * frontend-organization convention keeps out of the .svelte file. The
 * Settings component calls these and then schedules the save; nothing
 * here touches persistence or component state.
 */
import type { SystemPrompt } from '$lib/supabase';

/** A fresh, empty prompt with a client-generated id. */
export function createPrompt(): SystemPrompt {
  return {
    id: crypto.randomUUID(),
    name: 'New prompt',
    body: '',
    enabledByDefault: false,
  };
}

/** Append a fresh prompt to the end of the list. */
export function addPrompt(list: SystemPrompt[]): SystemPrompt[] {
  return [...list, createPrompt()];
}

/** Patch one prompt in place by id, leaving the rest untouched. */
export function updatePrompt(
  list: SystemPrompt[],
  id: string,
  patch: Partial<SystemPrompt>
): SystemPrompt[] {
  return list.map((p) => (p.id === id ? { ...p, ...patch } : p));
}

/** Drop one prompt by id. */
export function deletePrompt(list: SystemPrompt[], id: string): SystemPrompt[] {
  return list.filter((p) => p.id !== id);
}

/**
 * Move the prompt at `from` to sit at index `to`, shifting the rest.
 * Out-of-range or no-op indices return the list unchanged (a new array
 * is still returned so callers can treat the result uniformly). This is
 * the array half of the drag-and-drop reorder; the .svelte handler maps
 * the dragged id and the drop-target id to these indices.
 */
export function reorderPrompts(
  list: SystemPrompt[],
  from: number,
  to: number
): SystemPrompt[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= list.length ||
    to >= list.length
  ) {
    return [...list];
  }
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Field-wise equality of two prompt lists. Backs the resync guard that
 * decides whether a fresh Supabase pull (app.systemPrompts) should
 * overwrite the local draft - comparing by value rather than reference
 * so a re-fetch that returned an identical array doesn't clobber the
 * draft and lose cursor position mid-edit.
 */
export function promptsMatch(a: SystemPrompt[], b: SystemPrompt[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => {
      const other = b[i];
      return (
        other.id === p.id &&
        other.name === p.name &&
        other.body === p.body &&
        other.enabledByDefault === p.enabledByDefault
      );
    })
  );
}

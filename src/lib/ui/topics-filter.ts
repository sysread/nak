/**
 * UI-behavior primitives for the conversation drawer's topic
 * filter. Pure functions only - no runes, no Svelte imports, no
 * reactive state. The companion `src/components/TopicsFilter.svelte`
 * composes these with its own framework-native reactivity (a
 * handful of `$state` / `$derived` declarations) to implement the
 * widget.
 *
 * Lives outside the `.svelte.ts` extension on purpose: this file is
 * what a port to another framework would carry across unchanged. The
 * decisions encoded here (sentinel-first option list, the sentinel's
 * "untagged" display label, the toggle add-or-remove semantics) are
 * not Svelte-specific - they're the topic-filter feature itself.
 *
 * Anything reactive belongs in the component: a single `open: boolean`
 * for the popover, the framework's reactive primitive over `topics` /
 * `selected`, and the document-level listeners that close on click-
 * outside or Escape. Those are framework glue and stay next to the
 * markup that needs them.
 */
import { UNTAGGED_TOPIC_SENTINEL } from '../supabase';

/**
 * Effective option list to render in the popover. The `(untagged)`
 * sentinel is always offered, even on accounts with zero tagged
 * threads - it lets the user see the "the agent hasn't reached me
 * yet" subset explicitly. Real topics come from the per-user
 * vocabulary, alphabetised at the supabase layer.
 */
export function computeOptions(
  topics: readonly string[]
): readonly string[] {
  return [UNTAGGED_TOPIC_SENTINEL, ...topics];
}

/**
 * Display label for a topic. The sentinel renders as plain "untagged"
 * without the parens - the parens are an internal-only marker that
 * keeps it from colliding with any real topic the model could emit.
 */
export function labelFor(topic: string): string {
  return topic === UNTAGGED_TOPIC_SENTINEL ? 'untagged' : topic;
}

/**
 * True only for the sentinel. Used by the component to attach the
 * muted-italic styling class to its row and pill.
 */
export function isUntagged(topic: string): boolean {
  return topic === UNTAGGED_TOPIC_SENTINEL;
}

/**
 * Next selection after the user clicks a row checkbox. Adds the
 * topic if absent, removes it if present. The relative order of
 * the other selections is preserved so the pill row doesn't jump
 * around when the user toggles an unrelated topic.
 */
export function selectionAfterToggle(
  selected: readonly string[],
  topic: string
): string[] {
  return selected.includes(topic)
    ? selected.filter((t) => t !== topic)
    : [...selected, topic];
}

/**
 * Next selection after the user clicks the X on a pill. Tolerant of
 * a topic that is not currently selected - the X click on a pill
 * that has already been removed by some other path (URL restore,
 * parallel mutation) resolves to a no-op-shaped array rather than
 * throwing.
 */
export function selectionAfterClearOne(
  selected: readonly string[],
  topic: string
): string[] {
  return selected.filter((t) => t !== topic);
}

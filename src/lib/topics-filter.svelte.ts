/**
 * UI-behavior context module for the conversation drawer's topic
 * filter. Owns the decisions a port of this widget to another
 * framework would still need to make: which options to offer, what
 * counts as an "active" filter, how a click on a row mutates the
 * selection, how the popover open flag transitions.
 *
 * Pairs with `src/components/TopicsFilter.svelte`, which keeps only
 * the Svelte-specific glue: prop wiring, DOM refs, document-level
 * click-outside and Escape listeners, the rendered markup. The
 * component instantiates one of these controllers per mount and
 * delegates every readable/mutator through it.
 *
 * Factory rather than module-level singleton because each mount is
 * parameterized by props (current topic vocabulary, current
 * selection, an `onChange` callback owned by the parent). The
 * factory's inputs are getter functions so updates to the parent's
 * reactive props flow through the controller's `$derived` values
 * without the controller having to subscribe to anything.
 *
 * Selection itself stays owned by the parent (Chat.svelte) because
 * a future URL-restore path may need to seed it from the address
 * bar without touching this controller; the controller only stores
 * the popover-open flag, which is purely local UI state.
 */
import { UNTAGGED_TOPIC_SENTINEL } from './supabase';

export interface TopicsFilterInputs {
  /** Current topic vocabulary - typically `await listUserTopics()`. */
  topics: () => readonly string[];
  /** Current selection, including the sentinel when active. */
  selected: () => readonly string[];
  /** Called with the next selection on every mutator. */
  onChange: (next: string[]) => void;
}

export interface TopicsFilterController {
  /** Whether the popover is open. Read by the component to gate the
   *  rendered menu; written by the component on trigger click /
   *  Escape / outside-click. */
  open: boolean;
  /** Effective option list in display order. Always carries the
   *  (untagged) sentinel up front so the user can pick the
   *  "agent hasn't reached me yet" subset on accounts where the
   *  vocabulary is still empty. */
  readonly options: readonly string[];
  /** True when at least one topic is selected. Drives the trigger's
   *  accent dot and decides whether the pill row renders at all. */
  readonly hasActive: boolean;
  /** O(1) selection lookup for row checkboxes and pill rendering. */
  readonly selectedSet: ReadonlySet<string>;
  /** Display text for a topic. The sentinel renders as plain
   *  "untagged" without the parens - the parens are an internal-
   *  only marker that keeps it from colliding with any real topic
   *  the agent could emit. */
  labelFor(topic: string): string;
  /** True for the sentinel row; used by the component to attach
   *  the muted-italic styling class. */
  isUntagged(topic: string): boolean;
  /** Flip a row's selected state. */
  toggle(topic: string): void;
  /** Remove a single active filter (pill-x click). */
  clearOne(topic: string): void;
  /** Drop every active filter (Clear-all link). */
  clearAll(): void;
  /** Convenience for the trigger's onclick. */
  toggleOpen(): void;
  /** Convenience for outside-click / Escape paths. */
  close(): void;
}

export function createTopicsFilter(
  inputs: TopicsFilterInputs
): TopicsFilterController {
  let open = $state(false);

  const selectedSet = $derived(new Set(inputs.selected()));
  const hasActive = $derived(inputs.selected().length > 0);
  const options = $derived<readonly string[]>([
    UNTAGGED_TOPIC_SENTINEL,
    ...inputs.topics(),
  ]);

  return {
    get open(): boolean {
      return open;
    },
    set open(next: boolean) {
      open = next;
    },
    get options(): readonly string[] {
      return options;
    },
    get hasActive(): boolean {
      return hasActive;
    },
    get selectedSet(): ReadonlySet<string> {
      return selectedSet;
    },
    labelFor(topic: string): string {
      return topic === UNTAGGED_TOPIC_SENTINEL ? 'untagged' : topic;
    },
    isUntagged(topic: string): boolean {
      return topic === UNTAGGED_TOPIC_SENTINEL;
    },
    toggle(topic: string): void {
      const current = inputs.selected();
      const next = selectedSet.has(topic)
        ? current.filter((t) => t !== topic)
        : [...current, topic];
      inputs.onChange(next);
    },
    clearOne(topic: string): void {
      inputs.onChange(inputs.selected().filter((t) => t !== topic));
    },
    clearAll(): void {
      inputs.onChange([]);
    },
    toggleOpen(): void {
      open = !open;
    },
    close(): void {
      open = false;
    },
  };
}

/**
 * Unit coverage for the topic-filter controller. The component just
 * wires markup to this controller, so all the actual "what should
 * happen when the user does X" decisions live here and are testable
 * without mounting any DOM.
 *
 * The controller is a Svelte 5 rune factory (uses $state / $derived)
 * so each `createTopicsFilter` call has to run inside an effect root
 * for the runes to allocate cleanly. The shared `withController`
 * helper wraps a test body in `$effect.root` and tears it down on
 * the way out.
 */
import { describe, it, expect, vi } from 'vitest';
import { UNTAGGED_TOPIC_SENTINEL } from '../src/lib/supabase';
import {
  createTopicsFilter,
  type TopicsFilterController,
} from '../src/lib/topics-filter.svelte';

interface Harness {
  controller: TopicsFilterController;
  /** Current selection - mutated by `onChange` so the next read
   *  of the controller's $derived values reflects the user's
   *  click. */
  selected: string[];
  onChange: ReturnType<typeof vi.fn>;
  setTopics(next: readonly string[]): void;
}

/**
 * Build a controller plus a settable selection / topic vocabulary,
 * run the test body inside an effect root, and tear down the root
 * afterward so we don't leak reactive scopes across tests.
 *
 * Inputs sit inside a `$state` box so the controller's `$derived`
 * values invalidate when the test body mutates them via onChange or
 * `setTopics`. A plain `let` rebind would update the captured
 * variable but the reactivity graph would never see the new shape,
 * leaving the next `selectedSet` / `options` read still pointed at
 * the prior value.
 */
function withController(
  init: { topics?: readonly string[]; selected?: readonly string[] },
  fn: (h: Harness) => void
): void {
  const box = $state<{ topics: readonly string[]; selected: string[] }>({
    topics: init.topics ?? [],
    selected: [...(init.selected ?? [])],
  });
  const onChange = vi.fn((next: string[]) => {
    box.selected = next;
  });

  const dispose = $effect.root(() => {
    const controller = createTopicsFilter({
      topics: () => box.topics,
      selected: () => box.selected,
      onChange,
    });

    fn({
      controller,
      get selected(): string[] {
        return box.selected;
      },
      onChange,
      setTopics(next): void {
        box.topics = next;
      },
    });
  });

  dispose();
}

describe('createTopicsFilter', () => {
  describe('options', () => {
    it('always prepends the (untagged) sentinel, even when vocabulary is empty', () => {
      withController({ topics: [] }, ({ controller }) => {
        expect(controller.options).toEqual([UNTAGGED_TOPIC_SENTINEL]);
      });
    });

    it('preserves vocabulary order, sentinel-first', () => {
      withController({ topics: ['baking', 'bread', 'pasta'] }, ({ controller }) => {
        expect(controller.options).toEqual([
          UNTAGGED_TOPIC_SENTINEL,
          'baking',
          'bread',
          'pasta',
        ]);
      });
    });

    it('reflects a vocabulary update without re-creating the controller', () => {
      withController({ topics: ['baking'] }, ({ controller, setTopics }) => {
        expect(controller.options).toEqual([UNTAGGED_TOPIC_SENTINEL, 'baking']);
        setTopics(['baking', 'bread']);
        expect(controller.options).toEqual([
          UNTAGGED_TOPIC_SENTINEL,
          'baking',
          'bread',
        ]);
      });
    });
  });

  describe('hasActive', () => {
    it('is false on an empty selection', () => {
      withController({}, ({ controller }) => {
        expect(controller.hasActive).toBe(false);
      });
    });

    it('is true once at least one topic is selected', () => {
      withController({ selected: ['baking'] }, ({ controller }) => {
        expect(controller.hasActive).toBe(true);
      });
    });

    it('flips true after toggling on, false after toggling off', () => {
      withController({ topics: ['baking'] }, ({ controller }) => {
        expect(controller.hasActive).toBe(false);
        controller.toggle('baking');
        expect(controller.hasActive).toBe(true);
        controller.toggle('baking');
        expect(controller.hasActive).toBe(false);
      });
    });
  });

  describe('labelFor / isUntagged', () => {
    it('renders the sentinel as plain "untagged" without parens', () => {
      withController({}, ({ controller }) => {
        expect(controller.labelFor(UNTAGGED_TOPIC_SENTINEL)).toBe('untagged');
      });
    });

    it('passes real topic names through unchanged', () => {
      withController({}, ({ controller }) => {
        expect(controller.labelFor('baking')).toBe('baking');
      });
    });

    it('flags only the sentinel as untagged', () => {
      withController({}, ({ controller }) => {
        expect(controller.isUntagged(UNTAGGED_TOPIC_SENTINEL)).toBe(true);
        expect(controller.isUntagged('baking')).toBe(false);
        // A real topic that happens to share a word with the
        // sentinel must still come back false - the check has to
        // be string equality, not substring or label compare.
        expect(controller.isUntagged('untagged')).toBe(false);
      });
    });
  });

  describe('toggle / clearOne / clearAll', () => {
    it('adds an unselected topic via onChange', () => {
      withController({ topics: ['baking', 'bread'] }, ({ controller, onChange }) => {
        controller.toggle('baking');
        expect(onChange).toHaveBeenCalledWith(['baking']);
      });
    });

    it('removes a selected topic via onChange', () => {
      withController(
        { topics: ['baking', 'bread'], selected: ['baking', 'bread'] },
        ({ controller, onChange }) => {
          controller.toggle('baking');
          expect(onChange).toHaveBeenCalledWith(['bread']);
        }
      );
    });

    it('toggling preserves the order of the other selections', () => {
      withController(
        { selected: ['baking', 'bread', 'pasta'] },
        ({ controller, onChange }) => {
          controller.toggle('bread');
          expect(onChange).toHaveBeenCalledWith(['baking', 'pasta']);
        }
      );
    });

    it('toggles the sentinel like any other option', () => {
      withController({}, ({ controller, onChange }) => {
        controller.toggle(UNTAGGED_TOPIC_SENTINEL);
        expect(onChange).toHaveBeenCalledWith([
          UNTAGGED_TOPIC_SENTINEL,
        ]);
      });
    });

    it('clearOne removes the named topic and leaves the rest', () => {
      withController(
        { selected: ['baking', 'bread'] },
        ({ controller, onChange }) => {
          controller.clearOne('baking');
          expect(onChange).toHaveBeenCalledWith(['bread']);
        }
      );
    });

    it('clearOne on a topic that is not selected emits an unchanged-shape array', () => {
      withController(
        { selected: ['baking'] },
        ({ controller, onChange }) => {
          // The mutator is deliberately tolerant - the X click on a
          // pill that has already been removed by some other path
          // (URL restore, parallel mutation) should resolve to a
          // no-op-shaped onChange rather than throw.
          controller.clearOne('bread');
          expect(onChange).toHaveBeenCalledWith(['baking']);
        }
      );
    });

    it('clearAll emits an empty array', () => {
      withController(
        { selected: ['baking', 'bread', UNTAGGED_TOPIC_SENTINEL] },
        ({ controller, onChange }) => {
          controller.clearAll();
          expect(onChange).toHaveBeenCalledWith([]);
        }
      );
    });
  });

  describe('selectedSet', () => {
    it('mirrors the current selection as a Set for O(1) lookup', () => {
      withController(
        { selected: ['baking', 'bread'] },
        ({ controller }) => {
          expect(controller.selectedSet.has('baking')).toBe(true);
          expect(controller.selectedSet.has('bread')).toBe(true);
          expect(controller.selectedSet.has('pasta')).toBe(false);
        }
      );
    });

    it('updates after a toggle-driven onChange', () => {
      withController({ topics: ['baking'] }, ({ controller }) => {
        expect(controller.selectedSet.has('baking')).toBe(false);
        controller.toggle('baking');
        expect(controller.selectedSet.has('baking')).toBe(true);
      });
    });
  });

  describe('open / toggleOpen / close', () => {
    it('starts closed', () => {
      withController({}, ({ controller }) => {
        expect(controller.open).toBe(false);
      });
    });

    it('toggleOpen flips the flag', () => {
      withController({}, ({ controller }) => {
        controller.toggleOpen();
        expect(controller.open).toBe(true);
        controller.toggleOpen();
        expect(controller.open).toBe(false);
      });
    });

    it('close pins the flag false regardless of previous state', () => {
      withController({}, ({ controller }) => {
        controller.close();
        expect(controller.open).toBe(false);
        controller.toggleOpen();
        controller.close();
        expect(controller.open).toBe(false);
      });
    });

    it('open is independently writable for component-side wiring', () => {
      withController({}, ({ controller }) => {
        controller.open = true;
        expect(controller.open).toBe(true);
        controller.open = false;
        expect(controller.open).toBe(false);
      });
    });
  });
});

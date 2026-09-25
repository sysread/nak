// Decides when the mobile drawer's section nav (Chats, Recipes, ...)
// steps aside for a focused search box. On a phone the nav stack is
// tall enough that the gap between it and the on-screen keyboard is
// shorter than the search input itself, so the input ends up under
// the keyboard. Collapsing the nav while a search box has focus lifts
// the input to the top of the drawer.
//
// The Chat screen wires these handlers onto the sidebar <aside> as
// focusin/focusout (both bubble, so every tab's search box - the
// chats search and each *List component's - is covered by one
// listener). styles.css hides .sidebar-nav under .search-focused on
// phones only; desktop ignores the flag.

/*
 * How long the nav stays collapsed after the search box loses focus.
 *
 * Tapping a result blurs the search box on the synthesized mousedown,
 * a beat BEFORE the click dispatches. Restoring the nav immediately
 * would push the whole list ~300px down between the two, so the click
 * lands on whatever row slid under the finger (or on nothing). The
 * delay lets the click finish against the layout the user saw.
 */
const RESTORE_DELAY_MS = 250;

function isSidebarSearchInput(target: EventTarget | null): boolean {
  // Duck-typed rather than `instanceof HTMLElement` so the unit tests
  // run in the node environment without a DOM.
  return (target as Element | null)?.classList?.contains('sidebar-search-input') === true;
}

type FocusLike = Pick<FocusEvent, 'target'>;

/*
 * Returns focusin/focusout handlers that report the collapsed state
 * through `setFocused`. Focus events from anything other than a
 * sidebar search input are ignored, so the topic filter and list-row
 * buttons do not toggle the nav. Caller owns calling `dispose` on
 * unmount to drop a pending restore.
 */
export function createSidebarSearchFocus(setFocused: (focused: boolean) => void) {
  let restoreTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelRestore = (): void => {
    if (restoreTimer === null) return;
    clearTimeout(restoreTimer);
    restoreTimer = null;
  };

  return {
    onFocusIn(e: FocusLike): void {
      if (!isSidebarSearchInput(e.target)) return;
      // Re-focusing within the restore window keeps the nav collapsed
      // instead of letting the stale timer flash it back in.
      cancelRestore();
      setFocused(true);
    },
    onFocusOut(e: FocusLike): void {
      if (!isSidebarSearchInput(e.target)) return;
      cancelRestore();
      restoreTimer = setTimeout(() => {
        restoreTimer = null;
        setFocused(false);
      }, RESTORE_DELAY_MS);
    },
    dispose: cancelRestore,
  };
}

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSidebarSearchFocus } from '../src/lib/ui/sidebar-search-focus';

// Minimal stand-ins for focus-event targets; the module duck-types on
// classList so no DOM is needed.
const target = (cls: string) => ({ target: { classList: { contains: (c: string) => c === cls } } as unknown as EventTarget });
const search = target('sidebar-search-input');
const other = target('thread');

describe('createSidebarSearchFocus', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('collapses immediately when a sidebar search input gains focus', () => {
    const set = vi.fn();
    createSidebarSearchFocus(set).onFocusIn(search);
    expect(set).toHaveBeenCalledWith(true);
  });

  it('ignores focus on anything that is not a sidebar search input', () => {
    const set = vi.fn();
    const f = createSidebarSearchFocus(set);
    f.onFocusIn(other);
    f.onFocusOut(other);
    vi.runAllTimers();
    expect(set).not.toHaveBeenCalled();
  });

  it('restores only after the delay, so a tap on a result is not shifted', () => {
    const set = vi.fn();
    const f = createSidebarSearchFocus(set);
    f.onFocusIn(search);
    f.onFocusOut(search);
    expect(set).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(249);
    expect(set).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(1);
    expect(set).toHaveBeenLastCalledWith(false);
  });

  it('refocusing within the delay cancels the pending restore', () => {
    const set = vi.fn();
    const f = createSidebarSearchFocus(set);
    f.onFocusIn(search);
    f.onFocusOut(search);
    f.onFocusIn(search);
    vi.runAllTimers();
    expect(set).not.toHaveBeenCalledWith(false);
  });

  it('dispose drops a pending restore', () => {
    const set = vi.fn();
    const f = createSidebarSearchFocus(set);
    f.onFocusIn(search);
    f.onFocusOut(search);
    f.dispose();
    vi.runAllTimers();
    expect(set).not.toHaveBeenCalledWith(false);
  });
});

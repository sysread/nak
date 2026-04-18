/**
 * Component test for ReasoningPicker — the per-thread reasoning-effort
 * dropdown shown in the composer bar. Mounted in isolation because
 * Chat.svelte (where it lives) is too coupled to the live `app` state
 * for an isolated mount under @testing-library/svelte.
 *
 * What this covers that the logic tests don't: the view surface. If a
 * future refactor drops the `aria-expanded` attribute, the `default`
 * badge on the user's current default level, or the `aria-checked`
 * marker on the selected level, those regressions surface here rather
 * than waiting for a human to click through a deploy.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/svelte';
import ReasoningPicker from '../src/components/ReasoningPicker.svelte';

afterEach(cleanup);

describe('ReasoningPicker', () => {
  it('shows the currently-resolved effort on the trigger button', () => {
    const { getByRole } = render(ReasoningPicker, {
      value: 'medium',
      defaultEffort: 'low',
      open: false,
      onToggle: () => {},
      onSelect: () => {},
    });
    // The accessible name carries the effort so screen readers and the
    // tooltip surface agree on what the button represents.
    expect(getByRole('button')).toHaveAttribute(
      'title',
      'Reasoning effort: Medium'
    );
    expect(getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not render the menu when closed', () => {
    const { queryByRole } = render(ReasoningPicker, {
      value: 'low',
      defaultEffort: 'low',
      open: false,
      onToggle: () => {},
      onSelect: () => {},
    });
    expect(queryByRole('menu')).toBeNull();
  });

  it('renders the three levels with the default badged and the current marked checked', () => {
    const { getByRole, getAllByRole, getAllByText } = render(ReasoningPicker, {
      value: 'high',
      defaultEffort: 'low',
      open: true,
      onToggle: () => {},
      onSelect: () => {},
    });
    expect(getByRole('menu')).toBeInTheDocument();
    const items = getAllByRole('menuitemradio');
    expect(items).toHaveLength(3);
    // Labels, in order, so a reordering regression fails here rather
    // than surfacing as a mysterious UX shift.
    expect(items.map((el) => el.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Low default',
      'Medium',
      'High',
    ]);
    // Exactly one `default` badge — on the user's default, not the
    // current thread value.
    expect(getAllByText('default')).toHaveLength(1);
    // Exactly one aria-checked row — the currently-resolved effort.
    const checked = items.filter((el) => el.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0].textContent).toContain('High');
  });

  it('fires onToggle when the trigger is clicked (does not call onSelect)', async () => {
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const { getByTitle } = render(ReasoningPicker, {
      value: 'low',
      defaultEffort: 'low',
      open: false,
      onToggle,
      onSelect,
    });
    await fireEvent.click(getByTitle('Reasoning effort: Low'));
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('fires onSelect with the chosen effort when a menu row is clicked', async () => {
    const onSelect = vi.fn();
    const { getByRole } = render(ReasoningPicker, {
      value: 'low',
      defaultEffort: 'low',
      open: true,
      onToggle: () => {},
      onSelect,
    });
    // Scope by role + accessible name so a label change in a sibling
    // row doesn't accidentally match this query.
    await fireEvent.click(getByRole('menuitemradio', { name: /Medium/ }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('medium');
  });

  it('still fires onSelect when the user reselects the current level', async () => {
    // The parent is responsible for deciding this is a no-op — the
    // component itself shouldn't swallow the event or the parent can't
    // distinguish "user clicked" from "user never opened the menu".
    const onSelect = vi.fn();
    const { getByRole } = render(ReasoningPicker, {
      value: 'medium',
      defaultEffort: 'low',
      open: true,
      onToggle: () => {},
      onSelect,
    });
    await fireEvent.click(getByRole('menuitemradio', { name: /Medium/ }));
    expect(onSelect).toHaveBeenCalledWith('medium');
  });
});

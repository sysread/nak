/**
 * Component test for VerbosityPicker — the per-thread text.verbosity
 * dropdown shown in the composer bar. Mirrors reasoning-picker.test.ts
 * so a future refactor that drops the `aria-expanded` attribute, the
 * `default` badge on the user's current default level, or the
 * `aria-checked` marker on the selected level surfaces here rather than
 * waiting for a human to click through a deploy.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/svelte';
import VerbosityPicker from '../src/components/VerbosityPicker.svelte';

afterEach(cleanup);

describe('VerbosityPicker', () => {
  it('shows the currently-resolved verbosity on the trigger button', () => {
    const { getByRole } = render(VerbosityPicker, {
      value: 'medium',
      defaultVerbosity: 'low',
      open: false,
      onToggle: () => {},
      onSelect: () => {},
    });
    expect(getByRole('button')).toHaveAttribute('title', 'Verbosity: Medium');
    expect(getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not render the menu when closed', () => {
    const { queryByRole } = render(VerbosityPicker, {
      value: 'low',
      defaultVerbosity: 'low',
      open: false,
      onToggle: () => {},
      onSelect: () => {},
    });
    expect(queryByRole('menu')).toBeNull();
  });

  it('renders the three levels with the default badged and the current marked checked', () => {
    const { getByRole, getAllByRole, getAllByText } = render(VerbosityPicker, {
      value: 'high',
      defaultVerbosity: 'medium',
      open: true,
      onToggle: () => {},
      onSelect: () => {},
    });
    expect(getByRole('menu')).toBeInTheDocument();
    const items = getAllByRole('menuitemradio');
    expect(items).toHaveLength(3);
    expect(items.map((el) => el.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Low',
      'Medium default',
      'High',
    ]);
    // Exactly one `default` badge — on the user's default, not the
    // current thread value.
    expect(getAllByText('default')).toHaveLength(1);
    // Exactly one aria-checked row — the currently-resolved verbosity.
    const checked = items.filter((el) => el.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0].textContent).toContain('High');
  });

  it('fires onToggle when the trigger is clicked (does not call onSelect)', async () => {
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const { getByTitle } = render(VerbosityPicker, {
      value: 'low',
      defaultVerbosity: 'low',
      open: false,
      onToggle,
      onSelect,
    });
    await fireEvent.click(getByTitle('Verbosity: Low'));
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('fires onSelect with the chosen verbosity when a menu row is clicked', async () => {
    const onSelect = vi.fn();
    const { getByRole } = render(VerbosityPicker, {
      value: 'low',
      defaultVerbosity: 'low',
      open: true,
      onToggle: () => {},
      onSelect,
    });
    await fireEvent.click(getByRole('menuitemradio', { name: /High/ }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('high');
  });

  it('disables the trigger and explains why for a rejecting model', () => {
    // `disabled` comes from the model_feature_rejections record (the
    // model's backend 400s on the text.verbosity knob); the tooltip
    // swaps from the current-value readout to the explanation.
    const { getByRole } = render(VerbosityPicker, {
      value: 'medium',
      defaultVerbosity: 'low',
      open: false,
      disabled: true,
      onToggle: () => {},
      onSelect: () => {},
    });
    const btn = getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute(
      'title',
      "This model doesn't support the verbosity setting"
    );
  });

  it('closes the menu when disabled while open', () => {
    // A profile/thread switch to a rejecting model can land while the
    // menu is open; the dead trigger can no longer close it, so the
    // menu must close itself.
    const { queryByRole } = render(VerbosityPicker, {
      value: 'medium',
      defaultVerbosity: 'low',
      open: true,
      disabled: true,
      onToggle: () => {},
      onSelect: () => {},
    });
    expect(queryByRole('menu')).toBeNull();
  });
});

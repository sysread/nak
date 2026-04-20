/**
 * Verifies the document-level click-outside pattern that dismisses
 * composer-bar popovers in Chat.svelte. Mirrors the same shape
 * (anyOpen-gated document listener, `composerBarEl.contains(target)`
 * check) in a minimal harness component so the behaviour can be
 * asserted without mounting the whole chat screen.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/svelte';
import Harness from './click-outside-harness.svelte';

afterEach(cleanup);

describe('composer click-outside dismissal', () => {
  it('opens the prompts menu when its toggle is clicked', async () => {
    const { getByTestId, queryByTestId } = render(Harness);
    expect(queryByTestId('prompts-menu')).toBeNull();
    await fireEvent.click(getByTestId('prompts-toggle'));
    expect(queryByTestId('prompts-menu')).not.toBeNull();
  });

  it('closes the prompts menu when the user clicks outside', async () => {
    const { getByTestId, queryByTestId } = render(Harness);
    await fireEvent.click(getByTestId('prompts-toggle'));
    expect(queryByTestId('prompts-menu')).not.toBeNull();
    await fireEvent.click(getByTestId('outside'));
    expect(queryByTestId('prompts-menu')).toBeNull();
  });

  it('keeps the menu open on clicks that land inside the composer bar', async () => {
    const { getByTestId, queryByTestId } = render(Harness);
    await fireEvent.click(getByTestId('prompts-toggle'));
    // Clicking the menu itself shouldn't close it — interacting with a
    // menu item (e.g. a prompts-list checkbox) is an inside click.
    await fireEvent.click(getByTestId('prompts-menu'));
    expect(queryByTestId('prompts-menu')).not.toBeNull();
  });

  it('swaps between menus when a second toggle is clicked', async () => {
    const { getByTestId, queryByTestId } = render(Harness);
    await fireEvent.click(getByTestId('prompts-toggle'));
    expect(queryByTestId('prompts-menu')).not.toBeNull();
    await fireEvent.click(getByTestId('model-toggle'));
    expect(queryByTestId('prompts-menu')).toBeNull();
    expect(queryByTestId('model-menu')).not.toBeNull();
  });
});

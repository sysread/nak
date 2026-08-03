// jsdom environment (see environmentMatchGlobs in vite.config.ts) -
// the guard type-narrows its target through `instanceof Element`.
import { describe, expect, it } from 'vitest';
import { clickShouldCollapse } from '../src/lib/ui/collapse-click';

function selection(isCollapsed: boolean): Pick<Selection, 'isCollapsed'> {
  return { isCollapsed };
}

describe('clickShouldCollapse', () => {
  it('collapses on a plain click inside the panel body', () => {
    const panel = document.createElement('div');
    const paragraph = document.createElement('p');
    panel.appendChild(paragraph);
    expect(clickShouldCollapse(paragraph, selection(true))).toBe(true);
  });

  it('collapses when the environment reports no selection object', () => {
    expect(clickShouldCollapse(document.createElement('div'), null)).toBe(true);
  });

  it('collapses on a non-element target when nothing is selected', () => {
    expect(clickShouldCollapse(null, selection(true))).toBe(true);
  });

  it('leaves clicks on links to navigation', () => {
    const link = document.createElement('a');
    expect(clickShouldCollapse(link, selection(true))).toBe(false);
  });

  it('leaves clicks on buttons to the button', () => {
    const button = document.createElement('button');
    expect(clickShouldCollapse(button, selection(true))).toBe(false);
  });

  it('excludes descendants of interactive elements, not just the element itself', () => {
    const link = document.createElement('a');
    const inner = document.createElement('span');
    link.appendChild(inner);
    expect(clickShouldCollapse(inner, selection(true))).toBe(false);
  });

  it('skips the click that ends a text drag-selection', () => {
    const panel = document.createElement('div');
    expect(clickShouldCollapse(panel, selection(false))).toBe(false);
  });
});

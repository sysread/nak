/**
 * Unit coverage for the inline Cooklang parser. The parser never
 * throws (malformed input produces a partial result), so these
 * tests encode the "good" and "partial" shapes we want the parser
 * to produce — a regression that would make the detail view render
 * wrong is caught here rather than by manual UI inspection.
 */
import { describe, it, expect } from 'vitest';
import {
  parseCooklang,
  recipeToHtml,
  cooklangToHtml,
  recipeToPlainText,
} from '../src/lib/cooklang';

describe('parseCooklang — ingredients', () => {
  it('parses an ingredient with qty and unit', () => {
    const r = parseCooklang('Add @flour{200%g} to the bowl.');
    expect(r.ingredients).toEqual([{ name: 'flour', qty: '200', unit: 'g' }]);
  });

  it('parses an ingredient with qty but no unit', () => {
    const r = parseCooklang('Crack @eggs{2} into a bowl.');
    expect(r.ingredients).toEqual([{ name: 'eggs', qty: '2', unit: null }]);
  });

  it('parses bare ingredients without braces', () => {
    const r = parseCooklang('Season with @salt and @pepper.');
    expect(r.ingredients).toEqual([
      { name: 'salt', qty: null, unit: null },
      { name: 'pepper', qty: null, unit: null },
    ]);
  });

  it('parses multi-word ingredient inside braces', () => {
    const r = parseCooklang('Drizzle with @olive oil{1%tbsp}.');
    expect(r.ingredients).toEqual([{ name: 'olive oil', qty: '1', unit: 'tbsp' }]);
  });

  it('dedupes identical ingredient rows but keeps distinct quantities', () => {
    const r = parseCooklang(
      'Add @flour{1%cup}. Later, add @flour{1%cup}. And then @flour{2%tbsp}.'
    );
    // First two merge (same name + qty + unit); third stays distinct.
    expect(r.ingredients).toHaveLength(2);
    expect(r.ingredients[0]).toEqual({ name: 'flour', qty: '1', unit: 'cup' });
    expect(r.ingredients[1]).toEqual({ name: 'flour', qty: '2', unit: 'tbsp' });
  });
});

describe('parseCooklang — cookware + timers', () => {
  it('parses cookware references', () => {
    const r = parseCooklang('Place the batter in a #bundt pan{}.');
    expect(r.cookware).toEqual([{ name: 'bundt pan' }]);
  });

  it('parses a named timer', () => {
    const r = parseCooklang('Simmer ~{30%minutes} stirring occasionally.');
    expect(r.timers).toHaveLength(1);
    expect(r.timers[0]).toEqual({ name: null, duration: '30', unit: 'minutes' });
  });

  it('parses a named timer with a label', () => {
    const r = parseCooklang('Let it ~rest{10%minutes} at room temperature.');
    expect(r.timers).toEqual([{ name: 'rest', duration: '10', unit: 'minutes' }]);
  });
});

describe('parseCooklang — metadata', () => {
  it('captures >> key: value headers and excludes them from steps', () => {
    const r = parseCooklang('>> servings: 4\n>> source: NYT\nBring water to a boil.');
    expect(r.metadata).toEqual({ servings: '4', source: 'NYT' });
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.text).toBe('Bring water to a boil.');
  });
});

describe('parseCooklang — comments', () => {
  it('strips -- line comments', () => {
    const r = parseCooklang('Add @salt. -- season to taste');
    expect(r.steps[0]!.text).toBe('Add salt.');
  });

  it('strips [- block comments -] even across lines', () => {
    const r = parseCooklang(
      'Line one. [- this\nblock spans lines -]\nLine two.'
    );
    // Block comment removal can leave whitespace around the break;
    // the parser's line-splitter then collapses the blank. We
    // verify the two visible lines survived.
    const texts = r.steps.map((s) => s.text);
    expect(texts).toContain('Line one.');
    expect(texts).toContain('Line two.');
    expect(texts.join(' ')).not.toMatch(/spans lines/);
  });
});

describe('parseCooklang — empty and edge cases', () => {
  it('returns an empty shape for empty input', () => {
    const r = parseCooklang('');
    expect(r).toEqual({
      metadata: {},
      steps: [],
      ingredients: [],
      cookware: [],
      timers: [],
    });
  });

  it('ignores blank lines in the source', () => {
    const r = parseCooklang('\n\nStep one.\n\n\nStep two.\n');
    expect(r.steps.map((s) => s.text)).toEqual(['Step one.', 'Step two.']);
  });
});

describe('recipeToHtml', () => {
  it('emits an ingredients list with qty and name spans', () => {
    const html = cooklangToHtml('Stir in @flour{200%g}.');
    expect(html).toContain('<h3>Ingredients</h3>');
    expect(html).toContain('<span class="cook-qty">200 g</span>');
    expect(html).toContain('<span class="cook-name">flour</span>');
    expect(html).toContain('<h3>Instructions</h3>');
  });

  it('omits sections whose list is empty', () => {
    // Only metadata — no ingredients, cookware, timers, or steps.
    const html = cooklangToHtml('>> servings: 4');
    expect(html).toContain('<dl class="cook-metadata">');
    expect(html).not.toContain('<h3>Ingredients</h3>');
    expect(html).not.toContain('<h3>Cookware</h3>');
    expect(html).not.toContain('<h3>Instructions</h3>');
  });

  it('escapes HTML in user text', () => {
    const html = cooklangToHtml('<script>alert(1)</script>');
    // The `<script>` should appear as escaped text, not as a real
    // script tag. We check for the escaped opener.
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('recipeToPlainText', () => {
  it('renders a title + ingredient list + numbered steps', () => {
    const recipe = parseCooklang('Stir @flour{200%g} into a bowl.');
    const text = recipeToPlainText('Test Recipe', recipe);
    expect(text).toContain('Test Recipe');
    expect(text).toContain('Ingredients');
    expect(text).toContain('- 200 g flour');
    expect(text).toContain('Instructions');
    expect(text).toContain('1. Stir flour into a bowl.');
  });

  it('omits cookware from the ingredients list of the plain-text export', () => {
    // Shopping-list apps treat each line in the ingredients section
    // as a buyable item; a "- saucepan" row would end up in the
    // user's cart forever. Cookware in the instruction sentence is
    // fine — that's just the step text.
    const recipe = parseCooklang('Warm @oil{2%tbsp} in a #saucepan{}.');
    const text = recipeToPlainText('Oil', recipe);
    // The ingredients block should have oil but not saucepan.
    const ingredientsBlock = text.split('Instructions')[0]!;
    expect(ingredientsBlock).toContain('- 2 tbsp oil');
    expect(ingredientsBlock).not.toContain('saucepan');
  });
});

describe('recipeToHtml — structured smoke test', () => {
  it('round-trips a realistic multi-line recipe', () => {
    const src = `>> servings: 4
>> source: Test

Bring a large pot of @water{} to a boil. Season with @salt{}.

Add the @spaghetti{400%g} and cook until al dente — usually
~{8%minutes}.

Whisk @eggs{3} with grated @pecorino{60%g} in a #bowl{}.`;
    const recipe = parseCooklang(src);
    expect(recipe.metadata.servings).toBe('4');
    expect(recipe.metadata.source).toBe('Test');
    expect(recipe.ingredients.map((i) => i.name)).toEqual(
      expect.arrayContaining(['water', 'salt', 'spaghetti', 'eggs', 'pecorino'])
    );
    expect(recipe.cookware).toEqual([{ name: 'bowl' }]);
    expect(recipe.timers).toHaveLength(1);
    expect(recipe.steps.length).toBeGreaterThan(0);
    const html = recipeToHtml(recipe);
    expect(html).toContain('spaghetti');
    expect(html).toContain('<dl class="cook-metadata">');
  });
});

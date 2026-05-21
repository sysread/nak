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
  recipeToMarkdown,
  recipeToPlainText,
  validateCooklangSource,
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
      sections: [],
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

describe('recipeToMarkdown', () => {
  it('renders title + source link + ingredients + numbered steps', () => {
    const recipe = parseCooklang('Stir @flour{200%g} into a #bowl{}.');
    const md = recipeToMarkdown('Test Recipe', recipe, {
      source: 'NYT Cooking',
      sourceUrl: 'https://example.com/r',
    });
    expect(md).toContain('# Test Recipe');
    expect(md).toContain('*Source: [NYT Cooking](https://example.com/r)*');
    expect(md).toContain('## Ingredients');
    expect(md).toContain('- 200 g flour');
    expect(md).toContain('## Cookware');
    expect(md).toContain('- bowl');
    expect(md).toContain('## Instructions');
    expect(md).toContain('1. Stir flour into a bowl.');
  });

  it('omits the source line when neither source nor URL is provided', () => {
    const recipe = parseCooklang('Boil @water{1%L}.');
    const md = recipeToMarkdown('Plain', recipe);
    expect(md).not.toContain('*Source');
  });

  it('renders a bare URL as a markdown auto-link when no source name is set', () => {
    const recipe = parseCooklang('Boil @water{1%L}.');
    const md = recipeToMarkdown('Plain', recipe, {
      sourceUrl: 'https://example.com/r',
    });
    expect(md).toContain('*Source: <https://example.com/r>*');
  });

  it('emits `>> key: value` metadata as bolded bullets', () => {
    const recipe = parseCooklang('>> servings: 4\n>> prep_time: 20 min\nMix @flour{200%g}.');
    const md = recipeToMarkdown('Meta', recipe);
    expect(md).toContain('- **servings**: 4');
    expect(md).toContain('- **prep_time**: 20 min');
  });

  it('passes inline markdown in the step text through verbatim', () => {
    // The LLM occasionally drops markdown emphasis into a recipe and the
    // markdown export should round-trip it, not escape the asterisks
    // back to literal characters.
    const recipe = parseCooklang('Whisk the **eggs** until **fluffy**.');
    const md = recipeToMarkdown('Inline MD', recipe);
    expect(md).toContain('1. Whisk the **eggs** until **fluffy**.');
  });

  it('renders sectioned ingredients and instructions with ### sub-headings', () => {
    const src = `== Soup ==
Simmer @lentils{200%g} with @onion{1} in @water{1%L}.

== Finishing ==
Stir in @butter{2%tbsp} and serve.`;
    const md = recipeToMarkdown('Lentil Soup', parseCooklang(src));
    expect(md).toContain('### Soup');
    expect(md).toContain('### Finishing');
    // Per-section numbering restarts at 1 in the Instructions block,
    // matching the HTML renderer's "one ol per section" output.
    expect(md).toContain('1. Simmer lentils with onion in water.');
    expect(md).toContain('1. Stir in butter and serve.');
  });
});

describe('parseCooklang — sections and continuations', () => {
  it('recognises `== Section ==` as a section header', () => {
    const r = parseCooklang('== Soup ==\nBring @water{1%L} to a boil.');
    expect(r.sections).toEqual(['Soup']);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.section).toBe('Soup');
    expect(r.steps[0]!.text).toBe('Bring water to a boil.');
  });

  it('recognises `# Section` (space after hash) as an alias for == ==', () => {
    const r = parseCooklang('# Finishing\nStir in the @butter{2%tbsp}.');
    expect(r.sections).toEqual(['Finishing']);
    expect(r.steps[0]!.section).toBe('Finishing');
    // Ingredient should not have been left with a literal `#` in the text.
    expect(r.steps[0]!.text).toBe('Stir in the butter.');
  });

  it('still treats `#cookware` (no space) as a cookware reference', () => {
    // Regression guard: the `# Section` alias must not steal line-start
    // cookware tokens from the existing parser.
    const r = parseCooklang('Warm #saucepan{} on medium heat.');
    expect(r.sections).toEqual([]);
    expect(r.cookware).toEqual([{ name: 'saucepan' }]);
    expect(r.steps[0]!.text).toBe('Warm saucepan on medium heat.');
  });

  it('merges `> continuation` into the previous step text', () => {
    const r = parseCooklang(
      'Sear the @chicken{1%lb} on both sides.\n> Remove to a plate; reduce heat to medium.'
    );
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.text).toBe(
      'Sear the chicken on both sides. Remove to a plate; reduce heat to medium.'
    );
  });

  it('pulls continuation-line ingredients into the previous step and the flat list', () => {
    const r = parseCooklang(
      'Whisk the @eggs{3}.\n> Fold in @pecorino{60%g} and a pinch of @salt.'
    );
    expect(r.steps).toHaveLength(1);
    const step = r.steps[0]!;
    expect(step.ingredients.map((i) => i.name)).toEqual(['eggs', 'pecorino', 'salt']);
    // Flat dedupe preserves all three as well.
    expect(r.ingredients.map((i) => i.name)).toEqual(
      expect.arrayContaining(['eggs', 'pecorino', 'salt'])
    );
  });

  it('handles multiple sequential `>` continuation lines', () => {
    const r = parseCooklang('Step one.\n> part two.\n> part three.');
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.text).toBe('Step one. part two. part three.');
  });

  it('promotes a leading `> line` to a standalone step when no prior step exists', () => {
    const r = parseCooklang('> Preheat the @oven{} to 400F.');
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.text).toBe('Preheat the oven to 400F.');
  });

  it('drops a bare `>` with no body and no anchor', () => {
    const r = parseCooklang('>\nStep one.');
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.text).toBe('Step one.');
  });

  it('keeps `>> metadata` working alongside `> continuation`', () => {
    // The metadata matcher runs first; continuation must not steal
    // `>>`-prefixed lines.
    const r = parseCooklang('>> servings: 4\nStep one.\n> wraps.');
    expect(r.metadata).toEqual({ servings: '4' });
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.text).toBe('Step one. wraps.');
  });
});

describe('recipeToHtml — sections', () => {
  it('renders <h4> sub-headings under both Ingredients and Instructions', () => {
    const src = `== Soup ==
Simmer @lentils{200%g} in @water{1%L}.

# Finishing
Stir in @butter{2%tbsp} and serve.`;
    const html = cooklangToHtml(src);
    // Ingredients block uses <h4> markers per section.
    const ingredientsIdx = html.indexOf('<h3>Ingredients</h3>');
    const instructionsIdx = html.indexOf('<h3>Instructions</h3>');
    const ingredientsBlock = html.slice(ingredientsIdx, instructionsIdx);
    expect(ingredientsBlock).toContain('<h4 class="cook-section">Soup</h4>');
    expect(ingredientsBlock).toContain('<h4 class="cook-section">Finishing</h4>');
    expect(ingredientsBlock).toContain('lentils');
    expect(ingredientsBlock).toContain('butter');
    // Instructions block uses the same markers and starts a fresh <ol>
    // per section so numbering restarts at 1.
    const instructionsBlock = html.slice(instructionsIdx);
    expect(instructionsBlock).toContain('<h4 class="cook-section">Soup</h4>');
    expect(instructionsBlock).toContain('<h4 class="cook-section">Finishing</h4>');
    const olMatches = instructionsBlock.match(/<ol class="cook-steps">/g) ?? [];
    expect(olMatches.length).toBe(2);
  });

  it('falls back to flat output when the source has no sections', () => {
    const html = cooklangToHtml('Stir in @flour{200%g}.');
    expect(html).toContain('<h3>Ingredients</h3>');
    expect(html).not.toContain('<h4 class="cook-section">');
    // Single <ol> for the single flat steps list.
    expect((html.match(/<ol class="cook-steps">/g) ?? []).length).toBe(1);
  });

  it('round-trips a recipe mixing sections, aliases, and `> continuation`', () => {
    const src = `>> servings: 4

Bring a pot of @water{} to a boil.

== Soup ==
Add @lentils{200%g} and @onion{1}.
> Simmer until tender, about ~{30%minutes}.

# Finishing
Stir in @butter{2%tbsp} and @salt.`;
    const r = parseCooklang(src);
    expect(r.sections).toEqual(['Soup', 'Finishing']);
    // Head bucket has the initial boil step; Soup has one merged step.
    const soupSteps = r.steps.filter((s) => s.section === 'Soup');
    expect(soupSteps).toHaveLength(1);
    expect(soupSteps[0]!.text).toBe(
      'Add lentils and onion. Simmer until tender, about 30 minutes.'
    );
    const html = recipeToHtml(r);
    expect(html).toContain('<h4 class="cook-section">Soup</h4>');
    expect(html).toContain('<h4 class="cook-section">Finishing</h4>');
  });
});

describe('recipeToPlainText — sections', () => {
  it('emits section markers inside Instructions and keeps Ingredients flat', () => {
    const src = `== Soup ==
Simmer @lentils{200%g}.

# Finishing
Stir in @butter{2%tbsp}.`;
    const text = recipeToPlainText('Lentil Soup', parseCooklang(src));
    const ingredientsBlock = text.split('Instructions')[0]!;
    // Ingredients stay flat — AnyList treats every line as a buyable
    // item, so section labels in that block would poison the list.
    expect(ingredientsBlock).not.toContain('== Soup ==');
    expect(ingredientsBlock).not.toContain('== Finishing ==');
    expect(ingredientsBlock).toContain('- 200 g lentils');
    // Instructions carry the markers and restart numbering per section.
    const instructionsBlock = text.slice(text.indexOf('Instructions'));
    expect(instructionsBlock).toContain('== Soup ==');
    expect(instructionsBlock).toContain('== Finishing ==');
    expect(instructionsBlock).toContain('1. Simmer lentils.');
    expect(instructionsBlock).toContain('1. Stir in butter.');
  });
});

describe('parseCooklang — declaration lines', () => {
  it('marks a line starting with `@` as a declaration, not a step', () => {
    const r = parseCooklang('@flour{200%g}');
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.kind).toBe('declaration');
    expect(r.steps[0]!.text).toBe('');
    // Ingredient still contributes to the flat list.
    expect(r.ingredients).toEqual([{ name: 'flour', qty: '200', unit: 'g' }]);
  });

  it('keeps a prose-first line that happens to reference ingredients as an instruction', () => {
    const r = parseCooklang('Add @flour{200%g} to the bowl.');
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.kind).toBe('instruction');
    expect(r.steps[0]!.text).toBe('Add flour to the bowl.');
  });

  it('recognises declaration lines with trailing prose modifiers', () => {
    const r = parseCooklang(
      '@chicken thighs{1%lb}, bone-in and skin-on preferred for richer broth'
    );
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.kind).toBe('declaration');
    expect(r.ingredients).toEqual([{ name: 'chicken thighs', qty: '1', unit: 'lb' }]);
  });

  it('when declarations exist, instruction inline references do not double-count ingredients', () => {
    const src = `@chicken{1%lb}
--
Sear @chicken{1%lb} for ~{5%minutes}.`;
    const r = parseCooklang(src);
    // Only the declared chicken row makes it into the ingredient list;
    // the instruction's `@chicken` is a cross-reference, not a new row.
    expect(r.ingredients).toEqual([{ name: 'chicken', qty: '1', unit: 'lb' }]);
    // Timers and cookware still come from instructions as usual.
    expect(r.timers).toHaveLength(1);
  });

  it('falls back to pure-Cooklang behaviour when no declarations exist', () => {
    const r = parseCooklang('Add @flour{200%g} and @salt.');
    // No declarations — ingredients come from the instruction mention.
    expect(r.ingredients.map((i) => i.name)).toEqual(['flour', 'salt']);
    expect(r.steps[0]!.kind).toBe('instruction');
  });

  it('drops declarations from the HTML Instructions block', () => {
    const html = cooklangToHtml('@flour{200%g}\n--\nStir in water.');
    expect(html).toContain('<h3>Ingredients</h3>');
    expect(html).toContain('<h3>Instructions</h3>');
    // One <li>, containing the prose step, never the empty declaration text.
    const stepMatches = html.match(/<ol class="cook-steps">.*?<\/ol>/s)?.[0] ?? '';
    expect(stepMatches).toContain('Stir in water.');
    expect(stepMatches).not.toMatch(/<li><\/li>/);
  });

  it('drops declarations from the plain-text Instructions block', () => {
    const text = recipeToPlainText(
      'Test',
      parseCooklang('@flour{200%g}\n--\nStir in water.')
    );
    const instructionsBlock = text.slice(text.indexOf('Instructions'));
    expect(instructionsBlock).toContain('1. Stir in water.');
    // No step for the declaration line.
    expect(instructionsBlock).not.toMatch(/^\s*\d+\. flour\s*$/m);
    expect(instructionsBlock).not.toContain('2.');
  });
});

describe('parseCooklang — dash-only section reset', () => {
  it('clears the current section so subsequent steps attach to the head bucket', () => {
    const src = `# Soup
@chicken{1%lb}

--

Cover and cook ~{6%hours}.`;
    const r = parseCooklang(src);
    expect(r.sections).toEqual(['Soup']);
    // The declaration belongs to Soup; the instruction is section-less.
    const declaration = r.steps.find((s) => s.kind === 'declaration');
    const instruction = r.steps.find((s) => s.kind === 'instruction');
    expect(declaration?.section).toBe('Soup');
    expect(instruction?.section).toBe(null);
  });

  it('accepts `---`, `----`, etc. as the same reset (any run of 2+ dashes)', () => {
    const r = parseCooklang('# A\n@egg{1}\n---\nBeat the egg.');
    const instruction = r.steps.find((s) => s.kind === 'instruction');
    expect(instruction?.section).toBe(null);
    expect(instruction?.text).toBe('Beat the egg.');
  });

  it('does NOT treat a line-end `--` comment as a section reset', () => {
    // Regression guard: `Step one. -- aside` was a comment pre-change
    // and must remain one (trailing `--` strips to end of line).
    const r = parseCooklang('# A\nStep one. -- aside');
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.text).toBe('Step one.');
    expect(r.steps[0]!.section).toBe('A');
  });

  it('is tolerant of surrounding whitespace on the reset line', () => {
    const r = parseCooklang('# A\n@egg{1}\n   --   \nBeat it.');
    const instruction = r.steps.find((s) => s.kind === 'instruction');
    expect(instruction?.section).toBe(null);
  });
});

describe('recipeToHtml — cookbook-style round trip', () => {
  it('renders the user-reported crock-pot recipe shape correctly', () => {
    const src = `>> servings: 6-8
>> prep: 15 min

# Soup
@chicken thighs{1%lb}, bone-in and skin-on preferred for richer broth
@red lentils{1%cup} dried, rinsed
@chicken broth{6%cups}

# Finishing
@fresh parsley{1/4%cup} chopped
@sumac{1%tbsp}

# For serving
@French bread{1%loaf}

--

Add @chicken thighs{1%lb}, @red lentils{1%cup}, and @chicken broth{6%cups} to the #crock pot{}.
> Cook on low for ~{6%hours} to ~{8%hours}.
Ladle into bowls; top with @fresh parsley{1/4%cup} and @sumac{1%tbsp}.
Warm the @French bread{1%loaf} before serving.`;
    const recipe = parseCooklang(src);

    // Each section's declared ingredients live in their own sub-list.
    const html = recipeToHtml(recipe);
    const ingredientsBlock = html.slice(
      html.indexOf('<h3>Ingredients</h3>'),
      html.indexOf('<h3>Cookware</h3>') > -1
        ? html.indexOf('<h3>Cookware</h3>')
        : html.indexOf('<h3>Instructions</h3>')
    );
    expect(ingredientsBlock).toContain('<h4 class="cook-section">Soup</h4>');
    expect(ingredientsBlock).toContain('<h4 class="cook-section">Finishing</h4>');
    expect(ingredientsBlock).toContain('<h4 class="cook-section">For serving</h4>');
    // Head bucket (post-reset instruction bucket) must NOT emit its own
    // un-labelled ingredient sub-list — those ingredients are already
    // captured by the declared rows above.
    const beforeFirstH4 = ingredientsBlock.slice(
      0,
      ingredientsBlock.indexOf('<h4 class="cook-section">')
    );
    expect(beforeFirstH4).not.toContain('<ul class="cook-ingredients">');

    // Instructions render flat (no `For serving` heading leaked into
    // them), with the `>` continuation merged into step 1.
    const instructionsBlock = html.slice(html.indexOf('<h3>Instructions</h3>'));
    expect(instructionsBlock).not.toContain('<h4 class="cook-section">For serving</h4>');
    expect(instructionsBlock).not.toContain('<h4 class="cook-section">Soup</h4>');
    // Exactly one <ol> — the flat numbered list.
    expect((instructionsBlock.match(/<ol class="cook-steps">/g) ?? []).length).toBe(1);
    // Step 1 merged its continuation.
    expect(instructionsBlock).toMatch(/Add chicken thighs[^<]*Cook on low/);
    // All four prose sentences made it into the list.
    const liCount = (instructionsBlock.match(/<li>/g) ?? []).length;
    expect(liCount).toBe(3);
  });

  it('copy-plain-text output has one numbered instruction per prose line (not per declaration)', () => {
    const src = `# Soup
@flour{1%cup}
@water{1%cup}

--

Mix @flour{1%cup} and @water{1%cup}.
Cook until thick.`;
    const text = recipeToPlainText('Test', parseCooklang(src));
    const instructionsBlock = text.slice(text.indexOf('Instructions'));
    expect(instructionsBlock).toContain('1. Mix flour and water.');
    expect(instructionsBlock).toContain('2. Cook until thick.');
    // No flour/water entries in the numbered list.
    expect(instructionsBlock).not.toMatch(/^\s*\d+\. flour\s*$/m);
    expect(instructionsBlock).not.toMatch(/^\s*\d+\. water\s*$/m);
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

describe('parseCooklang — bare-brace durations', () => {
  // The LLM frequently drops the `~` when writing a duration, especially
  // when it also wraps the duration in markdown bold like
  // `**{4-5%hours}**`. The bare-brace pass treats `{N%unit}` as an
  // anonymous timer so the renderer doesn't show curly braces in prose.
  it('treats bare `{N%unit}` as an anonymous timer', () => {
    const r = parseCooklang('Cook for {30%minutes}.');
    expect(r.timers).toEqual([{ name: null, duration: '30', unit: 'minutes' }]);
    expect(r.steps[0]!.text).toBe('Cook for 30 minutes.');
  });

  it('handles a range duration like `{4-5%hours}`', () => {
    const r = parseCooklang('Slow cook for {4-5%hours}.');
    expect(r.timers).toEqual([{ name: null, duration: '4-5', unit: 'hours' }]);
    expect(r.steps[0]!.text).toBe('Slow cook for 4-5 hours.');
  });

  it('does not steal `{...}` from a preceding `@ingredient{...}` reference', () => {
    // Regression: `@flour{200%g}` must not also be re-claimed as a
    // bare-brace timer. The overlap guard in `tokenizeLine` covers this.
    const r = parseCooklang('Add @flour{200%g}.');
    expect(r.ingredients).toEqual([{ name: 'flour', qty: '200', unit: 'g' }]);
    expect(r.timers).toEqual([]);
    expect(r.steps[0]!.text).toBe('Add flour.');
  });

  it('ignores braces with no `%` in the body', () => {
    // `{just text}` is not a duration; leave the prose alone (it'll
    // render as literal `{just text}`, which is a clear signal to the
    // author that something is off without us guessing).
    const r = parseCooklang('Garnish with a {sprinkle of salt}.');
    expect(r.timers).toEqual([]);
    expect(r.steps[0]!.text).toBe('Garnish with a {sprinkle of salt}.');
  });
});

describe('validateCooklangSource', () => {
  it('accepts a well-formed recipe', () => {
    const errors = validateCooklangSource(
      'Add @flour{200%g} and stir for ~{2%minutes}.',
    );
    expect(errors).toEqual([]);
  });

  it('rejects markdown bold', () => {
    const errors = validateCooklangSource('Cook for **5 hours** on low.');
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/markdown emphasis/);
    expect(errors[0]).toMatch(/~\{N%unit\}/);
  });

  it('rejects backtick code spans', () => {
    const errors = validateCooklangSource('Set the dial to `low`.');
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/code spans/);
  });

  it('rejects the `@modifier @ingredient{...}` duplicate-pattern', () => {
    const errors = validateCooklangSource(
      'Use @pre-minced @garlic{1%tbsp} for speed.',
    );
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/modifier @ingredient/);
    expect(errors[0]).toMatch(/multi-word/);
  });

  it('does NOT flag legitimate two-ingredient prose like `@salt and @pepper`', () => {
    // The trigger is "two `@`s with only whitespace between AND the
    // second one braced." `@salt and @pepper` has prose between, and
    // neither has braces — both pre-conditions absent.
    const errors = validateCooklangSource('Season with @salt and @pepper.');
    expect(errors).toEqual([]);
  });

  it('does NOT flag a bare `{N%unit}` duration on its own', () => {
    // The parser already absorbs this as an anonymous timer; no need
    // for validation to second-guess it.
    const errors = validateCooklangSource('Simmer for {30%minutes}.');
    expect(errors).toEqual([]);
  });

  it('collects multiple problems in one pass', () => {
    const errors = validateCooklangSource(
      'Use @pre-minced @garlic{1%tbsp} and **stir** vigorously.',
    );
    expect(errors.length).toBe(2);
  });
});

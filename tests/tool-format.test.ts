/**
 * Coverage for the generic JSON -> markdown formatter that powers
 * the tool-call detail panel's pretty view. The shapes exercised
 * here mirror what real tools return (memory_search rows with
 * nested relations, web_search's {answer, citations}, recipe_get's
 * found/recipe envelope) - the formatter has to handle nested
 * objects, arrays of objects, long prose, multi-line strings,
 * and empty containers without producing markdown that confuses
 * `marked` downstream.
 */
import { describe, it, expect } from 'vitest';
import {
  formatJsonAsMarkdown,
  formatJsonStringAsMarkdown,
} from '../src/lib/ui/tool-format';

describe('formatJsonAsMarkdown', () => {
  it('renders a flat object as a bullet list', () => {
    const out = formatJsonAsMarkdown({
      query: 'pasta with garlic',
      limit: 20,
    });
    expect(out).toBe(
      ['- **query:** pasta with garlic', '- **limit:** 20'].join('\n')
    );
  });

  it('renders booleans and null with code spans so they are visually distinct from prose', () => {
    const out = formatJsonAsMarkdown({
      found: true,
      next: null,
      streaming: false,
    });
    expect(out).toBe(
      [
        '- **found:** `true`',
        '- **next:** `null`',
        '- **streaming:** `false`',
      ].join('\n')
    );
  });

  it('renders identifier-shaped strings as inline code', () => {
    // Memory ids, tool-call ids, and similar opaque tokens stand
    // out as `code` rather than blending with surrounding prose.
    const out = formatJsonAsMarkdown({ id: 'mem-abc123' });
    expect(out).toBe('- **id:** `mem-abc123`');
  });

  it('wraps URLs in angle brackets so marked autolinks them', () => {
    const out = formatJsonAsMarkdown({
      url: 'https://example.com/path?q=1',
    });
    expect(out).toBe('- **url:** <https://example.com/path?q=1>');
  });

  it('escapes inline markdown characters in scalar values', () => {
    // A free-form note containing asterisks or underscores must
    // not start an emphasis run inside the bullet.
    const out = formatJsonAsMarkdown({
      note: 'use *star* for emphasis',
    });
    expect(out).toBe('- **note:** use \\*star\\* for emphasis');
  });

  it('promotes long single-line strings to a blockquote', () => {
    // web_search returns an `answer` field that is paragraph-
    // length prose - bullets would force horizontal scroll on a
    // narrow panel.
    const answer =
      'Sazerac 18-year is averaging 120 to 140 dollars at major retailers as of June 2026, though prices vary by region and limited-availability lots can spike higher.';
    const out = formatJsonAsMarkdown({ answer });
    expect(out).toBe(
      ['**answer:**', '', '> ' + answer].join('\n')
    );
  });

  it('promotes multi-line strings to a fenced code block', () => {
    // recipe_save cooklang source has authored line breaks; the
    // generic path falls back to a fence even before the per-tool
    // override fires.
    const cooklang = '@butter{50%g}\n@flour{200%g}\nMix and knead.';
    const out = formatJsonAsMarkdown({ cooklang });
    expect(out).toBe(
      ['**cooklang:**', '', '```', cooklang, '```'].join('\n')
    );
  });

  it('renders nested objects under a bracketed path header', () => {
    const out = formatJsonAsMarkdown({
      found: true,
      recipe: { id: 'rec-1', title: 'Aglio e olio' },
    });
    expect(out).toBe(
      [
        '- **found:** `true`',
        '',
        '**recipe**',
        '',
        '- **id:** `rec-1`',
        '- **title:** Aglio e olio',
      ].join('\n')
    );
  });

  it('renders nested arrays of objects with [i] suffix paths', () => {
    // The memory_search return shape: top-level array of rows,
    // each with a `relations` sub-array of objects.
    const out = formatJsonAsMarkdown([
      {
        id: 'mem-abc',
        label: 'Aglio e olio',
        relations: [
          {
            id: 'rel-001',
            kind: 'mentioned_in',
            target: { id: 'mem-xyz', label: 'Summer dinner' },
          },
        ],
      },
    ]);
    expect(out).toBe(
      [
        '**[0]**',
        '',
        '- **id:** `mem-abc`',
        '- **label:** Aglio e olio',
        '',
        '**[0].relations[0]**',
        '',
        '- **id:** `rel-001`',
        '- **kind:** mentioned_in',
        '',
        '**[0].relations[0].target**',
        '',
        '- **id:** `mem-xyz`',
        '- **label:** Summer dinner',
      ].join('\n')
    );
  });

  it('renders arrays of primitives as a bullet list', () => {
    const out = formatJsonAsMarkdown({ tags: ['pasta', 'summer', 'quick'] });
    expect(out).toBe(
      [
        '**tags**',
        '',
        '- pasta',
        '- summer',
        '- quick',
      ].join('\n')
    );
  });

  it('renders empty objects with an inline placeholder', () => {
    const out = formatJsonAsMarkdown({ found: false, recipe: {} });
    expect(out).toBe(
      [
        '- **found:** `false`',
        '',
        '**recipe:** _(empty object)_',
      ].join('\n')
    );
  });

  it('renders empty arrays with an inline placeholder', () => {
    const out = formatJsonAsMarkdown({ citations: [] });
    expect(out).toBe('**citations:** _(empty list)_');
  });

  it('truncates very large arrays and reports the elided count', () => {
    const arr = Array.from({ length: 40 }, (_, i) => 'tag-' + i);
    const out = formatJsonAsMarkdown({ tags: arr });
    const lines = out.split('\n');
    // Header + blank + 25 bullets + 1 "and N more" placeholder.
    expect(lines).toContain('- _… and 15 more_');
    const bulletCount = lines.filter((l) => l.startsWith('- `tag-')).length;
    expect(bulletCount).toBe(25);
  });

  it('renders a top-level primitive bare', () => {
    expect(formatJsonAsMarkdown('hello')).toBe('hello');
    expect(formatJsonAsMarkdown(42)).toBe('42');
  });
});

describe('formatJsonStringAsMarkdown', () => {
  it('parses the JSON and renders it', () => {
    const out = formatJsonStringAsMarkdown('{"limit":5}');
    expect(out).toBe('- **limit:** 5');
  });

  it('renders an empty string as the empty placeholder', () => {
    expect(formatJsonStringAsMarkdown('')).toBe('_(empty)_');
  });

  it('falls back to a fenced block when the input is not valid JSON', () => {
    // Partial streaming args or non-JSON tool returns: still
    // show the user what the model emitted.
    expect(formatJsonStringAsMarkdown('not-json')).toBe(
      '```\nnot-json\n```'
    );
  });
});

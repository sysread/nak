// Offline unit tests for the per-source embed-text composition. Pure string
// logic, no network or Supabase. Ported from the browser source-adapter tests
// (tests/embeddings-*-source.test.ts) when backfill moved server-side - the
// truncation boundaries are the kind of off-by-one that silently corrupts an
// embedding, so the coverage rides along with the logic.
import { assertEquals } from '@std/assert';
import {
  buildMemoryEmbedInput,
  buildRecipeEmbedInput,
  buildWikiEmbedInput,
  buildSubstrateEmbedInput,
} from '../_shared/embed-input.ts';

Deno.test('buildMemoryEmbedInput joins label and body with a blank line', () => {
  assertEquals(buildMemoryEmbedInput('gym PIN', '12345'), 'gym PIN\n\n12345');
});

// 8000, NOT the 2500 write-boundary cap in src/lib/memories.ts. The embed
// truncation deliberately stayed put when the write cap dropped: lowering
// it would re-embed every legacy row longer than 2500 on a truncated body,
// making a row's vector depend on when it happened to be embedded. Do not
// "sync" these two numbers - see the comment on MAX_MEMORY_EMBED_CHARS.
Deno.test('buildMemoryEmbedInput truncates data past the embed cap', () => {
  const out = buildMemoryEmbedInput('label', 'x'.repeat(9000));
  // 'label' + '\n\n' + 8000 chars
  assertEquals(out.length, 'label\n\n'.length + 8000);
});

Deno.test('buildRecipeEmbedInput drops a blank source line', () => {
  assertEquals(buildRecipeEmbedInput('kombucha', null, 'steep'), 'kombucha\n\nsteep');
  assertEquals(buildRecipeEmbedInput('kombucha', '   ', 'steep'), 'kombucha\n\nsteep');
  assertEquals(
    buildRecipeEmbedInput('kombucha', 'NYT Cooking', 'steep'),
    'kombucha\n\nNYT Cooking\n\nsteep'
  );
});

Deno.test('buildWikiEmbedInput leads with the title and a blank line', () => {
  assertEquals(buildWikiEmbedInput('kombucha', 'fermented tea'), 'kombucha\n\nfermented tea');
});

Deno.test('buildSubstrateEmbedInput situation-only vs situation+outcome', () => {
  assertEquals(buildSubstrateEmbedInput('situation only', null), 'situation only');
  assertEquals(buildSubstrateEmbedInput('situation only', ''), 'situation only');
  assertEquals(buildSubstrateEmbedInput('sit', 'out'), 'sit\n\nout');
});

Deno.test('buildSubstrateEmbedInput truncates situation and outcome independently', () => {
  assertEquals(buildSubstrateEmbedInput('s'.repeat(7000), null).length, 6000);
  const out = buildSubstrateEmbedInput('hi', 'o'.repeat(5000));
  assertEquals(out.length, 'hi\n\n'.length + 2000);
});

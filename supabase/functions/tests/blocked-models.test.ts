// Offline unit tests for the blocked-model policy
// (../_shared/blocked-models.ts): the id predicate and the /models
// catalog strip. The policy itself - NO Grok (xAI) model anywhere in
// the app - is a hard owner directive; see the module docblock and its
// browser mirror src/lib/models/blocked-models.ts.
import { assertEquals } from '@std/assert';
import { isBlockedModelId, stripBlockedCatalogEntries } from '../_shared/blocked-models.ts';

Deno.test('isBlockedModelId matches any grok substring, case-insensitively', () => {
  assertEquals(isBlockedModelId('grok-41-fast'), true);
  assertEquals(isBlockedModelId('grok-imagine'), true);
  assertEquals(isBlockedModelId('Grok-4'), true);
  assertEquals(isBlockedModelId('xai-grok-9'), true);
});

Deno.test('isBlockedModelId passes every other id, including near misses', () => {
  assertEquals(isBlockedModelId('z-ai-glm-5-3-flash'), false);
  assertEquals(isBlockedModelId('mistral-small-3-2-24b-instruct'), false);
  assertEquals(isBlockedModelId('venice-uncensored-1-2'), false);
  // "grok" never appears as a substring of an unrelated id, but pin
  // the boundary anyway: the match is a plain case-insensitive
  // substring, no word boundaries.
  assertEquals(isBlockedModelId('grock-7'), false);
  assertEquals(isBlockedModelId('grok'), true);
});

Deno.test('stripBlockedCatalogEntries drops grok rows from the data envelope, keeps the rest', () => {
  const body = {
    object: 'list',
    type: 'text',
    data: [
      { id: 'z-ai-glm-5-3-flash', model_spec: { name: 'GLM 5.3 Flash' } },
      { id: 'grok-41-fast', model_spec: { name: 'Grok 4.1 Fast' } },
      { id: 'mistral-small-3-2-24b-instruct', model_spec: { name: 'Mistral Small 3.2' } },
    ],
  };
  const stripped = stripBlockedCatalogEntries(body) as typeof body;
  assertEquals(
    stripped.data.map((r) => r.id),
    ['z-ai-glm-5-3-flash', 'mistral-small-3-2-24b-instruct'],
  );
  // Everything outside data is relayed untouched.
  assertEquals(stripped.object, 'list');
  assertEquals(stripped.type, 'text');
});

Deno.test('stripBlockedCatalogEntries passes through non-envelope shapes unchanged', () => {
  const noData = { object: 'list', error: 'nope' };
  assertEquals(stripBlockedCatalogEntries(noData), noData);
  assertEquals(stripBlockedCatalogEntries(null), null);
  assertEquals(stripBlockedCatalogEntries('garbage'), 'garbage');
  // Rows without string ids are not the policy's problem - keep them
  // (the coercers drop malformed rows on their side).
  const weird = { data: [{}, { id: 42 }, null] };
  assertEquals(stripBlockedCatalogEntries(weird), weird);
});

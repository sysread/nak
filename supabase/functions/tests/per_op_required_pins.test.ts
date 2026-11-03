// Pin: every in-scope combination tool's schema carries the
// x-per-op-required per-op required-field rules, on BOTH surfaces that
// reach validateToolArgs - the browser-side schema (chat dispatch
// reads it off the wire via schemaMapFromBodyTools) and every
// agent-side mirrored wire schema (executeToolboxCall reads the
// mirror). A mirror that misses the key degrades that surface to
// handler-only validation silently; this pin makes the miss loud.
//
// Written BEFORE the key landed (characterization-then-flip): the pin
// fails until the schemas carry the key, proving the harness works.
//
// Scope (plan "Rollout scope"): only combos whose per-op required
// fields are UNCONDITIONAL get a full map; followups ships a PARTIAL
// map (close/dismiss only - save's create-or-update requireds cannot
// take a flat rule), and wiki / recipes / skills / docs are excluded
// entirely for the same reason. Ops absent from a map keep
// handler-only validation by convention.

import { assertEquals } from '@std/assert';
import { recordsSchema } from '../../../src/lib/tools/records.schema.ts';
import { recipeRecordsSchema } from '../../../src/lib/tools/recipe_records.schema.ts';
import { imageSchema } from '../../../src/lib/tools/image.schema.ts';
import { followupsSchema } from '../../../src/lib/tools/followups.schema.ts';
import { __test as extraction } from '../venice/agents/wiki_records.ts';
import { __test as article } from '../venice/agents/wiki.ts';
import { __test as librarian } from '../venice/agents/wiki_librarian.ts';
import { __test as reflection } from '../venice/agents/reflection.ts';

type PerOpMap = Record<string, readonly string[]>;

function parametersOf(schema: { parameters: Record<string, unknown> }): {
  opEnum: unknown[];
  map: PerOpMap | undefined;
} {
  const params = schema.parameters;
  return {
    opEnum: ((params.properties as Record<string, { enum?: unknown[] }>).op?.enum ?? []) as unknown[],
    map: params['x-per-op-required'] as PerOpMap | undefined,
  };
}

// Every op named in the map must be a legal value of the schema's op
// enum, and every rule field must be a declared property.
function assertMapWellFormed(
  label: string,
  params: { opEnum: unknown[]; map: PerOpMap | undefined },
  properties: Record<string, unknown>,
) {
  const map = params.map;
  assertEquals(map !== undefined, true, `${label}: x-per-op-required missing`);
  for (const [op, fields] of Object.entries(map ?? {})) {
    assertEquals(
      params.opEnum.includes(op),
      true,
      `${label}: map names op "${op}" which is not in the op enum`,
    );
    for (const field of fields) {
      assertEquals(
        field in properties,
        true,
        `${label}: map requires "${field}" which is not a declared property`,
      );
    }
  }
}

const recordsProperties = (recordsSchema.parameters.properties ?? {}) as Record<string, unknown>;
const recipeRecordsProperties = (recipeRecordsSchema.parameters.properties ?? {}) as Record<string, unknown>;
const imageProperties = (imageSchema.parameters.properties ?? {}) as Record<string, unknown>;
const followupsProperties = (followupsSchema.parameters.properties ?? {}) as Record<string, unknown>;

Deno.test('records schema carries the full per-op map (browser surface)', () => {
  const params = parametersOf(recordsSchema);
  assertMapWellFormed('records', params, recordsProperties);
  assertEquals(params.map, {
    list: ['article_id'],
    get: ['id'],
    search: ['query'],
    create: ['article_id', 'date', 'content'],
    update: ['id'],
    delete: ['id'],
  });
});

Deno.test('recipe_records schema carries the full per-op map (browser surface)', () => {
  const params = parametersOf(recipeRecordsSchema);
  assertMapWellFormed('recipe_records', params, recipeRecordsProperties);
  assertEquals(params.map, {
    list: ['recipe_id'],
    get: ['id'],
    search: ['query'],
    create: ['recipe_id', 'date', 'content'],
    update: ['id'],
    delete: ['id'],
  });
});

Deno.test('image schema carries the full per-op map (browser surface)', () => {
  const params = parametersOf(imageSchema);
  assertMapWellFormed('image', params, imageProperties);
  // scale is OPTIONAL on upscale (defaults to 2) - not in the map.
  assertEquals(params.map, {
    generate: ['prompt'],
    edit: ['filename', 'prompt'],
    upscale: ['filename'],
    remove_bg: ['filename'],
  });
});

Deno.test('followups schema carries the PARTIAL per-op map (browser surface)', () => {
  const params = parametersOf(followupsSchema);
  assertMapWellFormed('followups', params, followupsProperties);
  // save's requireds are conditional (question only on create) and
  // list requires nothing - both stay out of the map by convention.
  assertEquals(params.map, {
    close: ['id', 'resolution'],
    dismiss: ['id'],
  });
});

Deno.test('extraction agent mirror: records wire carries the narrowed map', () => {
  const wire = extraction
    .buildWikiRecordsToolbox()
    .tools.find((t) => t.name === 'records')?.wire.function.parameters as Record<string, unknown>;
  const map = wire?.['x-per-op-required'] as PerOpMap | undefined;
  // The extraction agent's records combo is narrowed to list + create
  // (append-only authority); the mirror carries only those ops.
  assertEquals(map, {
    list: ['article_id'],
    create: ['article_id', 'date', 'content'],
  });
});

Deno.test('article agent mirror: records wire carries the full map', () => {
  const wire = article
    .buildWikiToolbox()
    .tools.find((t) => t.name === 'records')?.wire.function.parameters as Record<string, unknown>;
  assertEquals(wire?.['x-per-op-required'], {
    list: ['article_id'],
    create: ['article_id', 'date', 'content'],
    update: ['id'],
    delete: ['id'],
  });
});

Deno.test('librarian mirror: records wire carries the full map', () => {
  const wire = librarian
    .buildLibrarianToolbox()
    .tools.find((t) => t.name === 'records')?.wire.function.parameters as Record<string, unknown>;
  assertEquals(wire?.['x-per-op-required'], {
    list: ['article_id'],
    create: ['article_id', 'date', 'content'],
    update: ['id'],
    delete: ['id'],
  });
});

Deno.test('reflection agent mirror: followups wire carries its partial map', () => {
  const wire = reflection
    .buildReflectionToolbox()
    .tools.find((t) => t.name === 'followups')?.wire.function.parameters as Record<string, unknown>;
  const map = wire?.['x-per-op-required'] as PerOpMap | undefined;
  // The reflection mirror exposes list / save / close (no dismiss);
  // save stays out of the map (conditional requireds).
  assertEquals(map, {
    close: ['id', 'resolution'],
  });
});

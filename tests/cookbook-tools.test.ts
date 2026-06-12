/**
 * Unit coverage for the SupabaseService recipe-versioning surface
 * (createRecipe / updateRecipe / revertRecipe). Pins the wire shape:
 * the right RPC is called with the right arg names and boolean flags,
 * and revertRecipe threads the chosen version's content into a normal
 * update call.
 *
 * Postgres isn't available in unit-test land, so the RPC bodies
 * themselves (atomicity, FOR UPDATE locking, the snapshot insert) are
 * out of scope; the client is stubbed down to its `.rpc` method.
 */
import { describe, it, expect, vi } from 'vitest';
import { SupabaseService } from '../src/lib/supabase';
import type { Recipe, RecipeVersion } from '../src/lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

function sampleRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'r-1',
    title: 'Test Recipe',
    source: null,
    source_url: null,
    cooklang: 'Stir @flour{200%g} into a bowl.',
    rating: null,
    upcoming: false,
    favorite: false,
    topics: [],
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

// SupabaseService recipe-versioning surface ---------------------------------
//
// We don't have Postgres in unit-test land, so the RPC bodies themselves
// (atomicity, FOR UPDATE locking, the snapshot insert) are out of scope here.
// What we CAN pin is the wire shape: createRecipe / updateRecipe call the
// right RPC with the right arg names + boolean flags, and revertRecipe wires
// the chosen version's content into a normal update call.

function sampleVersion(overrides: Partial<RecipeVersion> = {}): RecipeVersion {
  return {
    id: 'v-1',
    recipe_id: 'r-1',
    title: 'Old title',
    source: 'Old source',
    source_url: null,
    cooklang: 'Old @flour{1%cup}.',
    rating: 3,
    change_message: 'old version',
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeRpcOnlyClient(rpcImpl: ReturnType<typeof vi.fn>): SupabaseClient {
  // Minimal stub: only `.rpc` is exercised by the create/update paths.
  return {
    rpc: rpcImpl,
    // `.from` should not be called by create/update; if it is, the test will
    // fail loudly with an unhandled tool call.
    from: vi.fn(() => {
      throw new Error('unexpected from() call');
    }),
  } as unknown as SupabaseClient;
}

function makeService(client: SupabaseClient): SupabaseService {
  return new SupabaseService(
    { supabaseUrl: 'http://example.test', supabasePublishableKey: 'anon' },
    { client }
  );
}

describe('SupabaseService.createRecipe', () => {
  it('calls recipe_create_with_version RPC with rating and the trimmed change_message', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: [sampleRecipe()], error: null });
    const svc = makeService(makeRpcOnlyClient(rpc));
    await svc.createRecipe('T', 'X', 'NYT', null, 4, '  init  ');
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0]!;
    expect(name).toBe('recipe_create_with_version');
    expect(args).toEqual({
      p_title: 'T',
      p_cooklang: 'X',
      p_source: 'NYT',
      p_source_url: null,
      p_rating: 4,
      // Default to no photos when the create-flow caller doesn't
      // pass an explicit list. The RPC is happy with an empty array;
      // the link-write loop simply does nothing.
      p_image_ids: [],
      // Labels travel parallel to image_ids; the helper elides the
      // labels array entirely when no caption is set so the RPC
      // skips the label-assignment branch.
      p_image_labels: null,
      p_change_message: 'init',
    });
  });

  it('forwards a non-empty photos list when one is provided', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: [sampleRecipe()], error: null });
    const svc = makeService(makeRpcOnlyClient(rpc));
    await svc.createRecipe('T', 'X', null, null, null, 'init', [
      { id: 'img-a', label: null },
      { id: 'img-b', label: null },
    ]);
    const [, args] = rpc.mock.calls[0]!;
    expect(args.p_image_ids).toEqual(['img-a', 'img-b']);
    expect(args.p_image_labels).toBe(null);
  });

  it('forwards labels parallel to image_ids when at least one photo has a caption', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: [sampleRecipe()], error: null });
    const svc = makeService(makeRpcOnlyClient(rpc));
    await svc.createRecipe('T', 'X', null, null, null, 'init', [
      { id: 'img-a', label: 'finished plate' },
      { id: 'img-b', label: '' },
      { id: 'img-c', label: null },
    ]);
    const [, args] = rpc.mock.calls[0]!;
    expect(args.p_image_ids).toEqual(['img-a', 'img-b', 'img-c']);
    // Empty / whitespace strings normalise to null so the wire
    // payload is honest about which photos have a caption.
    expect(args.p_image_labels).toEqual(['finished plate', null, null]);
  });

  it('passes p_rating: null when the recipe is unrated', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: [sampleRecipe()], error: null });
    const svc = makeService(makeRpcOnlyClient(rpc));
    await svc.createRecipe('T', 'X', null, null, null, 'init');
    const [, args] = rpc.mock.calls[0]!;
    expect(args.p_rating).toBe(null);
  });

  it('rejects an empty change_message before touching the network', async () => {
    const rpc = vi.fn();
    const svc = makeService(makeRpcOnlyClient(rpc));
    await expect(
      svc.createRecipe('T', 'X', null, null, null, '   ')
    ).rejects.toThrow(/changeMessage is required/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range rating before touching the network', async () => {
    const rpc = vi.fn();
    const svc = makeService(makeRpcOnlyClient(rpc));
    await expect(
      svc.createRecipe('T', 'X', null, null, 6, 'init')
    ).rejects.toThrow(/rating must be an integer between 1 and 5/);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('SupabaseService.updateRecipe', () => {
  it('translates an absent field into p_set_*=false and an explicit null into p_set_*=true with null value', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: [sampleRecipe()], error: null });
    const svc = makeService(makeRpcOnlyClient(rpc));
    await svc.updateRecipe(
      'r-1',
      { title: 'New', source: null }, // title set, source cleared; cooklang/source_url/rating untouched
      'edit'
    );
    const [name, args] = rpc.mock.calls[0]!;
    expect(name).toBe('recipe_update_with_version');
    expect(args).toEqual({
      p_id: 'r-1',
      p_set_title: true,
      p_title: 'New',
      p_set_cooklang: false,
      p_cooklang: null,
      p_set_source: true,
      p_source: null,
      p_set_source_url: false,
      p_source_url: null,
      p_set_rating: false,
      p_rating: null,
      // Photos absent from the patch -> p_set_image_ids: false, so
      // the new version inherits the previous version's link set
      // (and labels). Labels ride along with the inherit path; the
      // wire still threads p_image_labels: null when nothing is set.
      p_set_image_ids: false,
      p_image_ids: null,
      p_image_labels: null,
      p_change_message: 'edit',
    });
  });

  it('passes photos through with p_set_image_ids: true when present', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: [sampleRecipe()], error: null });
    const svc = makeService(makeRpcOnlyClient(rpc));
    await svc.updateRecipe(
      'r-1',
      {
        photos: [
          { id: 'img-a', label: null },
          { id: 'img-b', label: null },
        ],
      },
      'reordered photos'
    );
    const [, args] = rpc.mock.calls[0]!;
    expect(args.p_set_image_ids).toBe(true);
    expect(args.p_image_ids).toEqual(['img-a', 'img-b']);
    expect(args.p_image_labels).toBe(null);
  });

  it('threads photo labels parallel with image_ids when at least one is set', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: [sampleRecipe()], error: null });
    const svc = makeService(makeRpcOnlyClient(rpc));
    await svc.updateRecipe(
      'r-1',
      {
        photos: [
          { id: 'img-a', label: 'finished plate' },
          { id: 'img-b', label: null },
        ],
      },
      'captioned plate'
    );
    const [, args] = rpc.mock.calls[0]!;
    expect(args.p_set_image_ids).toBe(true);
    expect(args.p_image_ids).toEqual(['img-a', 'img-b']);
    expect(args.p_image_labels).toEqual(['finished plate', null]);
  });

  it('threads rating through with the same set-flag pattern', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: [sampleRecipe()], error: null });
    const svc = makeService(makeRpcOnlyClient(rpc));
    await svc.updateRecipe('r-1', { rating: 5 }, 'rated it');
    const [, args] = rpc.mock.calls[0]!;
    expect(args.p_set_rating).toBe(true);
    expect(args.p_rating).toBe(5);
    // None of the other set-flags should fire.
    expect(args.p_set_title).toBe(false);
    expect(args.p_set_cooklang).toBe(false);
    expect(args.p_set_source).toBe(false);
    expect(args.p_set_source_url).toBe(false);
  });

  it('clears rating with explicit null', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: [sampleRecipe()], error: null });
    const svc = makeService(makeRpcOnlyClient(rpc));
    await svc.updateRecipe('r-1', { rating: null }, 'undecided');
    const [, args] = rpc.mock.calls[0]!;
    expect(args.p_set_rating).toBe(true);
    expect(args.p_rating).toBe(null);
  });

  it('rejects an out-of-range rating before touching the network', async () => {
    const rpc = vi.fn();
    const svc = makeService(makeRpcOnlyClient(rpc));
    await expect(
      svc.updateRecipe('r-1', { rating: 6 }, 'edit')
    ).rejects.toThrow(/rating must be an integer between 1 and 5/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects an empty change_message before touching the network', async () => {
    const rpc = vi.fn();
    const svc = makeService(makeRpcOnlyClient(rpc));
    await expect(
      svc.updateRecipe('r-1', { title: 'New' }, '  ')
    ).rejects.toThrow(/changeMessage is required/);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('SupabaseService.revertRecipe', () => {
  // revertRecipe is three calls now: getRecipeVersion (a `from` chain
  // ending in maybeSingle), listRecipeVersionPhotoInputs (a `from`
  // chain ending in order), then updateRecipe (an `rpc` call). The
  // stub dispatches by table name so both `from` chains resolve to
  // the shape their caller expects.
  function makeRevertClient(
    version: RecipeVersion | null,
    photoLinks: Array<{
      image_id: string;
      position: number;
      label: string | null;
    }> = []
  ) {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: [sampleRecipe()], error: null });
    const versionsChain = {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi
            .fn()
            .mockResolvedValue({ data: version, error: null }),
        }),
      }),
    };
    const linksChain = {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi
            .fn()
            .mockResolvedValue({ data: photoLinks, error: null }),
        }),
      }),
    };
    const from = vi.fn((table: string) => {
      if (table === 'recipe_versions') return versionsChain;
      if (table === 'recipe_version_images') return linksChain;
      throw new Error(`unexpected from(${table})`);
    });
    return {
      rpc,
      client: { from, rpc } as unknown as SupabaseClient,
    };
  }

  it('looks up the version, then calls updateRecipe with its content + change message', async () => {
    const v = sampleVersion();
    const { rpc, client } = makeRevertClient(v, [
      { image_id: 'img-a', position: 0, label: 'finished plate' },
      { image_id: 'img-b', position: 1, label: null },
    ]);
    const svc = makeService(client);
    await svc.revertRecipe('r-1', 'v-1', 'Reverted to v-1');
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0]!;
    expect(name).toBe('recipe_update_with_version');
    expect(args).toMatchObject({
      p_id: 'r-1',
      p_set_title: true,
      p_title: v.title,
      p_set_cooklang: true,
      p_cooklang: v.cooklang,
      p_set_source: true,
      p_source: v.source,
      p_set_source_url: true,
      p_source_url: v.source_url,
      p_set_rating: true,
      p_rating: v.rating,
      // Revert restores the photo set the version held, in order,
      // with labels intact - a revert that dropped captions wouldn't
      // honestly recreate the snapshot.
      p_set_image_ids: true,
      p_image_ids: ['img-a', 'img-b'],
      p_image_labels: ['finished plate', null],
      p_change_message: 'Reverted to v-1',
    });
  });

  it('throws when the version belongs to a different recipe', async () => {
    const v = sampleVersion({ recipe_id: 'r-OTHER' });
    const { rpc, client } = makeRevertClient(v);
    const svc = makeService(client);
    await expect(svc.revertRecipe('r-1', 'v-1', 'msg')).rejects.toThrow(
      /different recipe/
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it('throws when the version is not found', async () => {
    const { rpc, client } = makeRevertClient(null);
    const svc = makeService(client);
    await expect(svc.revertRecipe('r-1', 'v-missing', 'msg')).rejects.toThrow(
      /version not found/
    );
    expect(rpc).not.toHaveBeenCalled();
  });
});

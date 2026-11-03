// Offline unit tests for the image combination tool (op: generate,
// edit, upscale, remove_bg). Pure: the fake admin client replays the query shapes
// the tools build (same pattern as attachment-vision-tools.test.ts) and a
// stubbed global fetch routes Venice calls by URL, so these run under
// `deno test` with zero network. The orchestrator's harvest/attach is
// exercised live, not here.
import { assertEquals, assertRejects } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolContext } from '../venice/performToolCall.ts';
import { __test as capTest } from '../_shared/price-cap.ts';
import { VeniceError } from '../_shared/venice.ts';
import {
  decodeImageDimensions,
  upscalePreFlightMessage,
} from '../venice/tools/_image_ops.ts';
import { image } from '../venice/tools/image.ts';
import { GENERATED_IMAGE_RESULT_KEY } from '../venice/tools/_generated_image.ts';

// 2048x1536 JPEG source: big enough that a 4x output (67MP) busts the
// ~30MP pre-flight budget while a 2x (~12.6MP) passes.
function bigJpegBytes(): Uint8Array {
  const bytes = new Uint8Array(735);
  bytes[0] = 0xff; bytes[1] = 0xd8;
  // SOF0 segment at offset 2: FF C0 len(2) prec(1) height(2) width(2).
  bytes[2] = 0xff; bytes[3] = 0xc0;
  bytes[4] = 0x00; bytes[5] = 0x11; // segment length 17
  bytes[6] = 0x08; // precision
  bytes[7] = 0x06; bytes[8] = 0x00; // height 1536
  bytes[9] = 0x08; bytes[10] = 0x00; // width 2048
  return bytes;
}

interface AttachmentScenarioRow {
  id: string;
  filename: string;
  storage_path: string | null;
  mime_type: string;
  page_count?: number | null;
}

interface Scenario {
  attachments?: AttachmentScenarioRow[];
  /** profiles.settings row for the user (edit-model resolution). */
  settings?: Record<string, unknown>;
  /** Bytes the fake Storage download returns for any path. */
  storageBytes?: BlobPart;
  /** app_config.max_image_usd (caps). */
  maxImageUsd?: number;
}

/**
 * Fake admin client answering the query shapes the image-op tools build:
 * app_config (key + caps), profiles (settings), message_attachments
 * (lookup + describeNonImageMatch's sub-query), and the attachments
 * Storage download.
 */
function fakeCtx(scenario: Scenario): ToolContext {
  const adminClient = {
    from: (table: string) => {
      const eqs: Array<[string, unknown]> = [];
      let likePattern: string | null = null;
      let selected = '';
      const c: Record<string, unknown> = {};
      c.select = (cols?: string) => {
        selected = cols ?? '';
        return c;
      };
      c.order = () => c;
      c.limit = () => c;
      c.eq = (col: string, val: unknown) => {
        eqs.push([col, val]);
        return c;
      };
      c.like = (_col: string, pattern: string) => {
        likePattern = pattern;
        return c;
      };
      const eq = (col: string): unknown => eqs.find(([k]) => k === col)?.[1];

      c.maybeSingle = () => {
        if (table === 'app_config') {
          if (selected.includes('venice_api_key')) {
            return Promise.resolve({ data: { venice_api_key: 'test-key' }, error: null });
          }
          if (selected.includes('max_image_usd')) {
            return Promise.resolve({
              data: {
                max_input_usd_per_m: null,
                max_output_usd_per_m: null,
                max_image_usd: scenario.maxImageUsd ?? null,
              },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        }
        if (table === 'profiles') {
          return Promise.resolve({ data: { settings: scenario.settings ?? {} }, error: null });
        }
        if (table === 'message_attachments') {
          const filename = eq('filename');
          let rows = (scenario.attachments ?? []).filter((r) => r.filename === filename);
          if (likePattern === 'image/%') {
            rows = rows.filter((r) => r.mime_type.startsWith('image/'));
          }
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      };
      return c;
    },
    storage: {
      from: (_bucket: string) => ({
        download: (_path: string) =>
          Promise.resolve({
            data: new Blob([scenario.storageBytes ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
              type: 'image/png',
            }),
            error: null,
          }),
      }),
    },
  } as unknown as SupabaseClient;

  return {
    adminClient,
    userId: 'u-1',
    threadId: 't-1',
    signal: new AbortController().signal,
    depth: 0,
  } as ToolContext;
}

const photo = (over: Partial<AttachmentScenarioRow> = {}): AttachmentScenarioRow => ({
  id: 'att-photo',
  filename: 'photo.jpg',
  storage_path: 'u-1/att-photo/photo.jpg',
  mime_type: 'image/jpeg',
  ...over,
});

/** Route stubbed fetch by URL: catalog probes -> JSON, image ops -> PNG bytes. */
function stubFetch(opts: {
  inpaintCatalog?: unknown;
  upscaleCatalog?: unknown;
  imageCatalog?: unknown;
  imageCatalogThrows?: boolean;
  imageOpBody: (url: string, body: Record<string, unknown>) => Response;
}): { calls: Array<{ url: string; body: Record<string, unknown> }>; restore: () => void } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    calls.push({ url: u, body });
    if (u.includes('/models?type=inpaint')) {
      return Promise.resolve(
        new Response(JSON.stringify(opts.inpaintCatalog ?? { data: [] }), { status: 200 })
      );
    }
    if (u.includes('/models?type=upscale')) {
      return Promise.resolve(
        new Response(JSON.stringify(opts.upscaleCatalog ?? { data: [] }), { status: 200 })
      );
    }
    if (u.includes('/models?type=image')) {
      if (opts.imageCatalogThrows) {
        return Promise.reject(new Error('catalog unreachable'));
      }
      return Promise.resolve(
        new Response(JSON.stringify(opts.imageCatalog ?? { data: [] }), { status: 200 })
      );
    }
    return Promise.resolve(opts.imageOpBody(u, body));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const pngOpResponse = (): Response =>
  new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  });

Deno.test('image op=edit resolves the configured model, posts the data URI, returns the envelope', async () => {
  capTest.resetCache();
  const ctx = fakeCtx({
    attachments: [photo()],
    settings: { editImageModel: 'photon-edit-1' },
  });
  const { calls, restore } = stubFetch({
    inpaintCatalog: {
      data: [{ id: 'photon-edit-1', model_spec: { pricing: { inpaint: { usd: 0.03 } } } }],
    },
    imageOpBody: () => pngOpResponse(),
  });
  try {
    const out = (await image.execute(
      { op: 'edit', filename: 'photo.jpg', prompt: 'make the sky a sunset' },
      ctx,
    )) as Record<string, unknown>;
    const editCall = calls.find((c) => c.url.includes('/image/edit'));
    assertEquals(editCall?.body.model, 'photon-edit-1');
    assertEquals(editCall?.body.prompt, 'make the sky a sunset');
    assertEquals(
      (editCall?.body.image as string).startsWith('data:image/jpeg;base64,'),
      true
    );
    assertEquals(typeof out.filename, 'string');
    assertEquals((out.filename as string).startsWith('edited-'), true);
    assertEquals((out.note as string).includes('edited and attached'), true);
    const payload = out[GENERATED_IMAGE_RESULT_KEY] as Record<string, unknown>;
    assertEquals(payload.mime_type, 'image/png');
    assertEquals(typeof payload.data_base64, 'string');
    assertEquals(typeof payload.size_bytes, 'number');
  } finally {
    restore();
    capTest.resetCache();
  }
});

Deno.test('image op=edit falls back to the default model when settings carry none', async () => {
  capTest.resetCache();
  const ctx = fakeCtx({ attachments: [photo()] });
  const { calls, restore } = stubFetch({
    inpaintCatalog: {
      data: [{ id: 'firered-image-edit', model_spec: { pricing: { inpaint: { usd: 0.04 } } } }],
    },
    imageOpBody: () => pngOpResponse(),
  });
  try {
    await image.execute({ op: 'edit', filename: 'photo.jpg', prompt: 'x' }, ctx);
    assertEquals(calls.find((c) => c.url.includes('/image/edit'))?.body.model, 'firered-image-edit');
  } finally {
    restore();
    capTest.resetCache();
  }
});

Deno.test('image op=edit falls back to the default model when settings carry a blocked (Grok) id', async () => {
  // Blocked-model policy (_shared/blocked-models.ts): a stored Grok id
  // reads as unset - the tool never forwards it to Venice.
  capTest.resetCache();
  const ctx = fakeCtx({
    attachments: [photo()],
    settings: { editImageModel: 'grok-imagine-edit' },
  });
  const { calls, restore } = stubFetch({
    inpaintCatalog: {
      data: [{ id: 'firered-image-edit', model_spec: { pricing: { inpaint: { usd: 0.04 } } } }],
    },
    imageOpBody: () => pngOpResponse(),
  });
  try {
    await image.execute({ op: 'edit', filename: 'photo.jpg', prompt: 'x' }, ctx);
    assertEquals(calls.find((c) => c.url.includes('/image/edit'))?.body.model, 'firered-image-edit');
  } finally {
    restore();
    capTest.resetCache();
  }
});

Deno.test('image op=edit over-cap pick 403s before any image call', async () => {
  capTest.resetCache();
  const ctx = fakeCtx({
    attachments: [photo()],
    settings: { editImageModel: 'edit-spendy' },
    maxImageUsd: 0.1,
  });
  const { calls, restore } = stubFetch({
    inpaintCatalog: {
      data: [{ id: 'edit-spendy', model_spec: { pricing: { inpaint: { usd: 0.34 } } } }],
    },
    imageOpBody: () => pngOpResponse(),
  });
  try {
    const err = await assertRejects(
      () => image.execute({ op: 'edit', filename: 'photo.jpg', prompt: 'x' }, ctx),
      VeniceError,
    );
    assertEquals(err.status, 403);
    assertEquals(calls.some((c) => c.url.includes('/image/edit')), false);
  } finally {
    restore();
    capTest.resetCache();
  }
});

Deno.test('image op=edit miss diagnostics carry the calling tool name', async () => {
  const pdfCtx = fakeCtx({
    attachments: [{ id: 'a', filename: 'contract.pdf', storage_path: 'p', mime_type: 'application/pdf', page_count: 4 }],
  });
  const err = await assertRejects(
    () => image.execute({ op: 'edit', filename: 'contract.pdf', prompt: 'x' }, pdfCtx),
    Error,
  );
  assertEquals(err.message.includes('so image (op=edit) cannot read it'), true);
  assertEquals(err.message.includes('analyze_pdf_page'), true);

  const emptyCtx = fakeCtx({});
  const miss = await assertRejects(
    () => image.execute({ op: 'edit', filename: 'nope.jpg', prompt: 'x' }, emptyCtx),
    Error,
  );
  assertEquals(miss.message, 'No image attachment named "nope.jpg" in this thread.');
});

Deno.test('image op=edit reports an expired image distinctly', async () => {
  const ctx = fakeCtx({ attachments: [photo({ storage_path: null })] });
  const err = await assertRejects(
    () => image.execute({ op: 'edit', filename: 'photo.jpg', prompt: 'x' }, ctx),
    Error,
  );
  assertEquals(err.message, 'Image "photo.jpg" has expired and its data is no longer available.');
});

Deno.test('image op=upscale refuses a doomed scale before calling Venice', async () => {
  capTest.resetCache();
  const ctx = fakeCtx({
    attachments: [photo()],
    storageBytes: bigJpegBytes().slice().buffer as ArrayBuffer,
  });
  const { calls, restore } = stubFetch({ imageOpBody: () => pngOpResponse() });
  try {
    const err = await assertRejects(
      () => image.execute({ op: 'upscale', filename: 'photo.jpg', scale: 4 }, ctx),
      Error,
    );
    assertEquals(err.message.includes('Retry with scale 2'), true);
    assertEquals(calls.some((c) => c.url.includes('/image/upscale')), false);
  } finally {
    restore();
    capTest.resetCache();
  }
});

Deno.test('image op=upscale sends raw base64 (no data URI) on the happy path', async () => {
  capTest.resetCache();
  // 1x1-ish PNG source: pre-flight passes at any scale.
  const ctx = fakeCtx({ attachments: [photo()] });
  const { calls, restore } = stubFetch({
    upscaleCatalog: {
      data: [{ id: 'upscaler', model_spec: { pricing: { upscale: { '2x': { usd: 0.02 }, '4x': { usd: 0.08 } } } } }],
    },
    imageOpBody: () => pngOpResponse(),
  });
  try {
    const out = (await image.execute({ op: 'upscale', filename: 'photo.jpg', scale: 2 }, ctx)) as Record<string, unknown>;
    const upCall = calls.find((c) => c.url.includes('/image/upscale'));
    assertEquals((upCall?.body.image as string).startsWith('data:'), false);
    assertEquals(upCall?.body.scale, 2);
    assertEquals((out.filename as string).startsWith('upscaled-'), true);
    assertEquals(out.format, 'png');
  } finally {
    restore();
    capTest.resetCache();
  }
});

Deno.test('image op=remove_bg posts a data URI and returns a no-bg envelope', async () => {
  capTest.resetCache();
  const ctx = fakeCtx({ attachments: [photo()] });
  const { calls, restore } = stubFetch({ imageOpBody: () => pngOpResponse() });
  try {
    const out = (await image.execute({ op: 'remove_bg', filename: 'photo.jpg' }, ctx)) as Record<string, unknown>;
    const bgCall = calls.find((c) => c.url.includes('/image/background-remove'));
    assertEquals((bgCall?.body.image as string).startsWith('data:image/jpeg;base64,'), true);
    assertEquals((out.filename as string).startsWith('no-bg-'), true);
    assertEquals(out.format, 'png');
  } finally {
    restore();
    capTest.resetCache();
  }
});

// --- generate_image ---------------------------------------------------------

// JSON body for the /image/generate route (return_binary=false shape).
const generateJsonResponse = (): Response =>
  new Response(JSON.stringify({ id: 'g1', images: ['QUJD'] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

Deno.test('image op=generate resolves the configured model and returns the envelope', async () => {
  capTest.resetCache();
  const ctx = fakeCtx({ settings: { imageModel: 'flux-dev' } });
  const { calls, restore } = stubFetch({
    imageOpBody: (u) =>
      u.includes('/image/generate') ? generateJsonResponse() : pngOpResponse(),
  });
  try {
    const out = (await image.execute({ op: 'generate', prompt: 'a lighthouse' }, ctx)) as Record<string, unknown>;
    const genCall = calls.find((c) => c.url.includes('/image/generate'));
    assertEquals(genCall?.body.model, 'flux-dev');
    assertEquals((out.filename as string).startsWith('generated-'), true);
  } finally {
    restore();
    capTest.resetCache();
  }
});

Deno.test('image op=generate falls back to the default model when settings carry a blocked (Grok) id', async () => {
  // Blocked-model policy (_shared/blocked-models.ts): a stored Grok id
  // reads as unset - the tool never forwards it to Venice.
  capTest.resetCache();
  const ctx = fakeCtx({ settings: { imageModel: 'grok-imagine' } });
  const { calls, restore } = stubFetch({
    imageOpBody: (u) =>
      u.includes('/image/generate') ? generateJsonResponse() : pngOpResponse(),
  });
  try {
    await image.execute({ op: 'generate', prompt: 'a lighthouse' }, ctx);
    const genCall = calls.find((c) => c.url.includes('/image/generate'));
    assertEquals(genCall?.body.model, 'venice-sd35');
  } finally {
    restore();
    capTest.resetCache();
  }
});

// --- generate sizing: per-model constraints ---------------------------------

// A ratio-based catalog entry (qwen-image class): aspectRatios present,
// no width/height accepted.
const ratioModel = (over: Record<string, unknown> = {}): unknown => ({
  id: 'qwen-image',
  model_spec: {
    constraints: { aspectRatios: ['1:1', '16:9'], defaultAspectRatio: '1:1' },
    pricing: { generation: { usd: 0.02 } },
    ...over,
  },
});

Deno.test('generate on a ratio-based model sends aspect_ratio and no dimensions', async () => {
  capTest.resetCache();
  const ctx = fakeCtx({ settings: { imageModel: 'qwen-image' } });
  const { calls, restore } = stubFetch({
    imageCatalog: { data: [ratioModel()] },
    imageOpBody: (u) =>
      u.includes('/image/generate') ? generateJsonResponse() : pngOpResponse(),
  });
  try {
    const out = (await image.execute(
      { op: 'generate', prompt: 'a lighthouse', aspect_ratio: '16:9' },
      ctx,
    )) as Record<string, unknown>;
    const genCall = calls.find((c) => c.url.includes('/image/generate'));
    assertEquals(genCall?.body.aspect_ratio, '16:9');
    assertEquals(genCall?.body.width, undefined);
    assertEquals(genCall?.body.height, undefined);
    // The request dims were never known; the descriptor decodes the output
    // bytes instead - 'QUJD' is not a decodable header, so both are omitted.
    assertEquals(out.width, undefined);
    assertEquals(out.height, undefined);
  } finally {
    restore();
    capTest.resetCache();
  }
});

Deno.test('generate on a ratio model maps an off-list ratio to the model default', async () => {
  capTest.resetCache();
  const ctx = fakeCtx({ settings: { imageModel: 'qwen-image' } });
  const { calls, restore } = stubFetch({
    imageCatalog: { data: [ratioModel()] },
    imageOpBody: (u) =>
      u.includes('/image/generate') ? generateJsonResponse() : pngOpResponse(),
  });
  try {
    await image.execute(
      { op: 'generate', prompt: 'a lighthouse', aspect_ratio: '3:4' },
      ctx,
    );
    assertEquals(calls.find((c) => c.url.includes('/image/generate'))?.body.aspect_ratio, '1:1');
  } finally {
    restore();
    capTest.resetCache();
  }
});

Deno.test('generate on a pixel model rounds the table dims to the catalog divisor', async () => {
  capTest.resetCache();
  const ctx = fakeCtx({ settings: { imageModel: 'venice-sd35' } });
  const { calls, restore } = stubFetch({
    imageCatalog: {
      data: [{
        id: 'venice-sd35',
        model_spec: {
          constraints: { widthHeightDivisor: 64 },
          pricing: { generation: { usd: 0.02 } },
        },
      }],
    },
    imageOpBody: (u) =>
      u.includes('/image/generate') ? generateJsonResponse() : pngOpResponse(),
  });
  try {
    const out = (await image.execute(
      { op: 'generate', prompt: 'a lighthouse', aspect_ratio: '16:9' },
      ctx,
    )) as Record<string, unknown>;
    const genCall = calls.find((c) => c.url.includes('/image/generate'));
    // 16:9 table dims 1280x720 rounded to multiples of 64.
    assertEquals(genCall?.body.width, 1280);
    assertEquals(genCall?.body.height, 704);
    assertEquals(genCall?.body.aspect_ratio, undefined);
  } finally {
    restore();
    capTest.resetCache();
  }
});

Deno.test('generate fails open to the legacy dimension table when the catalog is unreachable', async () => {
  capTest.resetCache();
  const ctx = fakeCtx({ settings: { imageModel: 'qwen-image' } });
  const { calls, restore } = stubFetch({
    imageCatalogThrows: true,
    imageOpBody: (u) =>
      u.includes('/image/generate') ? generateJsonResponse() : pngOpResponse(),
  });
  try {
    await image.execute({ op: 'generate', prompt: 'a lighthouse' }, ctx);
    const genCall = calls.find((c) => c.url.includes('/image/generate'));
    // Legacy table 1:1 dims, no aspect_ratio - the fail-open wire shape.
    assertEquals(genCall?.body.width, 1024);
    assertEquals(genCall?.body.height, 1024);
    assertEquals(genCall?.body.aspect_ratio, undefined);
  } finally {
    restore();
    capTest.resetCache();
  }
});

Deno.test('generate retries once with aspect_ratio when a model rejects fixed dimensions', async () => {
  capTest.resetCache();
  const ctx = fakeCtx({ settings: { imageModel: 'venice-sd35' } });
  // Catalog advertises NO constraints for the model (stale/missing slice),
  // so the first attempt ships the legacy dims; Venice's deterministic
  // rejection names them; the retry strips dims and sends the ratio.
  // The retry's JSON response is a decodable 2048x1536 PNG header, pinning
  // that the descriptor reports the OUTPUT dims (not the rejected request
  // dims) after a successful retry.
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47], 0);
  png[16] = 0x00; png[17] = 0x00; png[18] = 0x08; png[19] = 0x00; // width 2048
  png[20] = 0x00; png[21] = 0x00; png[22] = 0x06; png[23] = 0x00; // height 1536
  const pngB64 = btoa(String.fromCharCode(...png));
  const { calls, restore } = stubFetch({
    imageOpBody: (u, body) => {
      if (!u.includes('/image/generate')) return pngOpResponse();
      if (body.width !== undefined) {
        return new Response(
          JSON.stringify({ error: 'width and height are no longer supported for this model. Use aspect_ratio instead.' }),
          { status: 400 },
        );
      }
      return new Response(JSON.stringify({ id: 'g1', images: [pngB64] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  try {
    const out = (await image.execute(
      { op: 'generate', prompt: 'a lighthouse', aspect_ratio: '16:9' },
      ctx,
    )) as Record<string, unknown>;
    const genCalls = calls.filter((c) => c.url.includes('/image/generate'));
    assertEquals(genCalls.length, 2);
    assertEquals(genCalls[0].body.width, 1280);
    assertEquals(genCalls[1].body.width, undefined);
    assertEquals(genCalls[1].body.aspect_ratio, '16:9');
    assertEquals((out.filename as string).startsWith('generated-'), true);
    // The retry succeeded on a ratio-based body: the descriptor decodes the
    // OUTPUT dims instead of reporting the rejected request dims.
    assertEquals(out.width, 2048);
    assertEquals(out.height, 1536);
  } finally {
    restore();
    capTest.resetCache();
  }
});

Deno.test('generate surfaces the Settings-switch remedy when both dimension attempts fail', async () => {
  capTest.resetCache();
  const ctx = fakeCtx({ settings: { imageModel: 'venice-sd35' } });
  const dims400 = (): Response =>
    new Response(
      JSON.stringify({ error: 'width and height are no longer supported for this model. Use aspect_ratio instead.' }),
      { status: 400 },
    );
  const { restore } = stubFetch({
    imageOpBody: (u) => (u.includes('/image/generate') ? dims400() : pngOpResponse()),
  });
  try {
    const err = await assertRejects(
      () => image.execute({ op: 'generate', prompt: 'a lighthouse', aspect_ratio: '16:9' }, ctx),
    ) as Error;
    assertEquals(err.message.includes('Settings -> AI -> Image generation'), true);
    assertEquals(err.message.toLowerCase().includes('try again later'), false);
  } finally {
    restore();
    capTest.resetCache();
  }
});

Deno.test('generate descriptor decodes the output dimensions in ratio mode', async () => {
  capTest.resetCache();
  // 24-byte fake PNG: magic + IHDR with 2048x1536 at the fixed offsets.
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47], 0);
  png[16] = 0x00; png[17] = 0x00; png[18] = 0x08; png[19] = 0x00; // width 2048
  png[20] = 0x00; png[21] = 0x00; png[22] = 0x06; png[23] = 0x00; // height 1536
  const b64 = btoa(String.fromCharCode(...png));
  const ctx = fakeCtx({ settings: { imageModel: 'qwen-image' } });
  const { restore } = stubFetch({
    imageCatalog: { data: [ratioModel()] },
    imageOpBody: (u) =>
      u.includes('/image/generate')
        ? new Response(JSON.stringify({ id: 'g1', images: [b64] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : pngOpResponse(),
  });
  try {
    const out = (await image.execute(
      { op: 'generate', prompt: 'a lighthouse', aspect_ratio: '16:9' },
      ctx,
    )) as Record<string, unknown>;
    // Decoded from the OUTPUT bytes - the request carried no dimensions.
    assertEquals(out.width, 2048);
    assertEquals(out.height, 1536);
  } finally {
    restore();
    capTest.resetCache();
  }
});

// --- Pure helpers -----------------------------------------------------------

Deno.test('decodeImageDimensions reads PNG/JPEG/WebP headers and skips unknown formats', () => {
  // PNG IHDR at the fixed offsets.
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47], 0);
  const setU32 = (o: number, v: number) => {
    png[o] = (v >>> 24) & 0xff; png[o + 1] = (v >>> 16) & 0xff;
    png[o + 2] = (v >>> 8) & 0xff; png[o + 3] = v & 0xff;
  };
  setU32(16, 2048);
  setU32(20, 1536);
  assertEquals(decodeImageDimensions(png), { width: 2048, height: 1536 });

  assertEquals(decodeImageDimensions(bigJpegBytes()), { width: 2048, height: 1536 });
  assertEquals(decodeImageDimensions(new TextEncoder().encode('hello world, not an image')), null);
});

Deno.test('upscalePreFlightMessage passes small plans, refuses large ones with tiered guidance', () => {
  // 2048x1536: 2x (~12.6MP output) fits the ~30MP budget.
  assertEquals(upscalePreFlightMessage(bigJpegBytes(), 2), null);
  // 4x (~67MP output) busts it and points at 2x.
  const four = upscalePreFlightMessage(bigJpegBytes(), 4);
  assertEquals(four?.includes('Retry with scale 2'), true);
  // Undecodable format skips the pre-flight.
  assertEquals(upscalePreFlightMessage(new TextEncoder().encode('not an image'), 4), null);
});

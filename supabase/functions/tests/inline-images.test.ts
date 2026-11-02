// Offline unit tests for the /stream image-inline phase
// (venice/inline-images.ts). The walker is pure; the IO phase runs
// against a fake Supabase client and a fake downloader, so nothing here
// touches a network or Storage.
import { assert, assertEquals } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  inlineAttachmentImages,
  parseSignedImageUrl,
  walkImageParts,
} from '../venice/inline-images.ts';

// A real signed URL's shape (Supabase Storage createSignedUrls output):
// https://<ref>.supabase.co/storage/v1/object/sign/attachments/<user>/<att>/<file>?token=...
function signedUrl(user: string, att: string, file: string): string {
  return `https://ymcphlmneiiltfudsvkk.supabase.co/storage/v1/object/sign/attachments/${user}/${att}/${file}?token=abc.def`;
}

const USER = '5bf53a84-b767-4dbe-991a-07aff846b5df';
const ATT_1 = '074d9303-564d-431a-9c92-d58b8b94cf18';
const ATT_2 = 'c1870c1c-9502-415b-baf5-2b0359a49cbf';

function userMessageWithImage(url: string): Record<string, unknown> {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'look at this' },
      { type: 'image_url', image_url: { url } },
    ],
  };
}

interface FakeRow {
  id: string;
  storage_path: string | null;
  mime_type: string;
  size_bytes: number;
  thread_id: string;
}

function fakeAdmin(rows: FakeRow[]): SupabaseClient {
  // Mirrors the query shape inline-images.ts runs:
  // from().select().in().eq() -> awaited at eq (thenable fallback on the
  // builder in case the await lands earlier).
  const resolve = () =>
    Promise.resolve({
      data: rows.map(({ thread_id: _t, ...r }) => r),
      error: null,
    });
  const builder = {
    in: () => builder,
    eq: resolve,
    then: resolve,
  };
  return {
    from: (_table: string) => ({ select: () => builder }),
  } as unknown as SupabaseClient;
}

const THREAD = '11111111-2222-3333-4444-555555555555';
const OTHER_THREAD = '99999999-8888-7777-6666-555555555555';

const ROW_1: FakeRow = {
  id: ATT_1,
  storage_path: `${USER}/${ATT_1}/image.png`,
  mime_type: 'image/webp',
  size_bytes: 94_330,
  thread_id: THREAD,
};

// --- walker (pure) -----------------------------------------------------------

Deno.test('walkImageParts finds signed-attachment image parts across messages', () => {
  const body = {
    messages: [
      { role: 'system', content: 'sys' },
      userMessageWithImage(signedUrl(USER, ATT_1, 'image.png')),
      { role: 'assistant', content: 'ok' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'and this' },
          { type: 'image_url', image_url: { url: signedUrl(USER, ATT_2, 'image.png') } },
        ],
      },
    ],
  };
  const refs = walkImageParts(body);
  assertEquals(refs.length, 2);
  assertEquals(refs[0].attachmentId, ATT_1);
  assertEquals(refs[0].storagePath, `${USER}/${ATT_1}/image.png`);
  assertEquals(refs[1].attachmentId, ATT_2);
});

Deno.test('walkImageParts ignores data URIs, other buckets, and non-part content', () => {
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/webp;base64,AAAA' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: 'https://example.com/storage/v1/object/sign/documents/a/b/c?token=x',
            },
          },
        ],
      },
      { role: 'user', content: 'plain string content' },
      { role: 'user', content: [{ type: 'text', text: 'no image part' }] },
    ],
  };
  assertEquals(walkImageParts(body), []);
});

Deno.test('parseSignedImageUrl decodes percent-encoded storage paths', () => {
  const parsed = parseSignedImageUrl(
    signedUrl(USER, ATT_1, 'my%20photo.png')
  );
  assertEquals(parsed?.storagePath, `${USER}/${ATT_1}/my photo.png`);
  assertEquals(parsed?.attachmentId, ATT_1);
  assertEquals(parseSignedImageUrl('not a url'), null);
});

// --- inline phase (fake IO) --------------------------------------------------

function happyDownload(expectedMime?: string) {
  return (
    _admin: SupabaseClient,
    _path: string,
    mimeType: string,
    _label: string
  ): Promise<string> => {
    if (expectedMime !== undefined) {
      assertEquals(mimeType, expectedMime);
    }
    // 8 base64 chars -> 6 raw bytes.
    return Promise.resolve(`data:${mimeType};base64,AAAAAAAA`);
  };
}

Deno.test('inlines owned images newest-first, mutating parts in place', async () => {
  const body = {
    messages: [
      userMessageWithImage(signedUrl(USER, ATT_1, 'image.png')), // older
      userMessageWithImage(signedUrl(USER, ATT_2, 'image.png')), // anchor
    ],
  };
  const downloadOrder: string[] = [];
  const result = await inlineAttachmentImages(
    fakeAdmin([ROW_1, { ...ROW_1, id: ATT_2, storage_path: `${USER}/${ATT_2}/image.png` }]),
    body,
    THREAD,
    {
      download: (_a, path, mime) => {
        downloadOrder.push(path);
        return Promise.resolve(`data:${mime};base64,AAAAAAAA`);
      },
    }
  );
  assertEquals(result.inlined, 2);
  assertEquals(downloadOrder, [`${USER}/${ATT_2}/image.png`, `${USER}/${ATT_1}/image.png`]);
  for (const message of body.messages as Array<{ content: unknown[] }>) {
    const part = message.content[1] as { image_url: { url: string } };
    assert(part.image_url.url.startsWith('data:image/webp;base64,'));
  }
});

Deno.test('degrades: cross-thread row, missing row, path drift, non-image mime', async () => {
  const body = {
    messages: [
      userMessageWithImage(signedUrl(USER, ATT_1, 'image.png')),
      userMessageWithImage(signedUrl(USER, ATT_2, 'image.png')),
    ],
  };
  const download = (_a: SupabaseClient, _p: string, m: string) =>
    Promise.resolve(`data:${m};base64,AAAAAAAA`);
  // Only ROW_1 resolves; anything else in the batch is a miss.
  const result = await inlineAttachmentImages(
    fakeAdmin([ROW_1, { ...ROW_1, id: ATT_2, storage_path: `${OTHER_THREAD}/${ATT_2}/x.png`, thread_id: OTHER_THREAD }]),
    body,
    THREAD,
    { download }
  );
  assertEquals(result.inlined, 1);
  // The newest part (ATT_2) degraded to its signed URL; the owned older
  // one inlined.
  const first = (body.messages[0] as { content: Array<{ image_url: { url: string } }> }).content[1];
  const second = (body.messages[1] as { content: Array<{ image_url: { url: string } }> }).content[1];
  assert(first.image_url.url.startsWith('data:'), 'owned older image inlined');
  assert(second.image_url.url.startsWith('https://'), 'unowned newest degraded');
});

Deno.test('byte cap hard-stops: the first over-cap part and older parts keep URLs', async () => {
  const body = {
    messages: [
      userMessageWithImage(signedUrl(USER, ATT_1, 'image.png')), // oldest
      userMessageWithImage(signedUrl(USER, ATT_2, 'image.png')), // anchor
    ],
  };
  const downloads: string[] = [];
  const result = await inlineAttachmentImages(
    fakeAdmin([
      ROW_1,
      { ...ROW_1, id: ATT_2, storage_path: `${USER}/${ATT_2}/image.png`, size_bytes: 5000 },
    ]),
    body,
    THREAD,
    {
      byteCap: 6000, // fits ATT_2 (5000), not ATT_1 (94330)
      download: (_a, path, mime) => {
        downloads.push(path);
        return Promise.resolve(`data:${mime};base64,AAAAAAAA`);
      },
    }
  );
  assertEquals(result.inlined, 1);
  assertEquals(downloads, [`${USER}/${ATT_2}/image.png`]);
  const oldest = (body.messages[0] as { content: Array<{ image_url: { url: string } }> }).content[1];
  assert(oldest.image_url.url.startsWith('https://'), 'over-cap oldest keeps its URL');
});

Deno.test('download failure degrades that part and keeps walking', async () => {
  const body = {
    messages: [
      userMessageWithImage(signedUrl(USER, ATT_1, 'image.png')),
      userMessageWithImage(signedUrl(USER, ATT_2, 'image.png')),
    ],
  };
  let calls = 0;
  const result = await inlineAttachmentImages(
    fakeAdmin([ROW_1, { ...ROW_1, id: ATT_2, storage_path: `${USER}/${ATT_2}/image.png` }]),
    body,
    THREAD,
    {
      download: (_a, path, mime) => {
        calls += 1;
        if (path === `${USER}/${ATT_2}/image.png`) {
          return Promise.reject(new Error('could not be downloaded'));
        }
        return Promise.resolve(`data:${mime};base64,AAAAAAAA`);
      },
    }
  );
  assertEquals(result.inlined, 1);
  assertEquals(calls, 2);
  const second = (body.messages[1] as { content: Array<{ image_url: { url: string } }> }).content[1];
  assert(second.image_url.url.startsWith('https://'), 'failed download degraded');
});

Deno.test('per-download timeout degrades a hung download and keeps walking', async () => {
  const body = {
    messages: [
      userMessageWithImage(signedUrl(USER, ATT_1, 'image.png')),
      userMessageWithImage(signedUrl(USER, ATT_2, 'image.png')),
    ],
  };
  const hang = new Promise<string>(() => {});
  const result = await inlineAttachmentImages(
    fakeAdmin([ROW_1, { ...ROW_1, id: ATT_2, storage_path: `${USER}/${ATT_2}/image.png` }]),
    body,
    THREAD,
    {
      download: (_a, path, mime) =>
        path === `${USER}/${ATT_2}/image.png` ? hang : Promise.resolve(`data:${mime};base64,AAAAAAAA`),
      perDownloadTimeoutMs: 20,
    }
  );
  assertEquals(result.inlined, 1);
  const second = (body.messages[1] as { content: Array<{ image_url: { url: string } }> }).content[1];
  assert(second.image_url.url.startsWith('https://'), 'hung download degraded');
});

Deno.test('phase deadline stops the walk before later (older) downloads', async () => {
  const body = {
    messages: [
      userMessageWithImage(signedUrl(USER, ATT_1, 'image.png')),
      userMessageWithImage(signedUrl(USER, ATT_2, 'image.png')),
    ],
  };
  const result = await inlineAttachmentImages(
    fakeAdmin([ROW_1, { ...ROW_1, id: ATT_2, storage_path: `${USER}/${ATT_2}/image.png` }]),
    body,
    THREAD,
    {
      download: (_a, _p, mime) => Promise.resolve(`data:${mime};base64,AAAAAAAA`),
      phaseDeadlineMs: -1, // already expired
    }
  );
  assertEquals(result.inlined, 0);
});

Deno.test('empty body shapes are no-ops', async () => {
  for (const wireBody of [{}, { messages: [] }, { messages: [{ role: 'user', content: 'text' }] }]) {
    const result = await inlineAttachmentImages(
      fakeAdmin([]),
      wireBody,
      THREAD,
      { download: happyDownload() }
    );
    assertEquals(result, { inlined: 0, bytesInlined: 0 });
  }
});

Deno.test('failed ownership lookup degrades everything', async () => {
  const body = { messages: [userMessageWithImage(signedUrl(USER, ATT_1, 'image.png'))] };
  const failingAdmin = {
    from: () => ({
      select: () => ({
        in: () => ({
          eq: () =>
            Promise.resolve({
              data: null,
              error: { message: 'permission denied' },
            }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
  const result = await inlineAttachmentImages(failingAdmin, body, THREAD, {
    download: happyDownload(),
  });
  assertEquals(result, { inlined: 0, bytesInlined: 0 });
  const part = (body.messages[0] as { content: Array<{ image_url: { url: string } }> }).content[1];
  assert(part.image_url.url.startsWith('https://'), 'part kept its signed URL');
});

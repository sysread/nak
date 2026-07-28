// Offline guards for the model-facing DIAGNOSTICS of the two attachment
// vision tools. Every case here throws before any Venice call, so the tests
// stay network-free.
//
// These strings are load-bearing in a way tool error text usually isn't.
// analyze_image's lookup filters on `mime_type like 'image/%'`, so a PDF in
// the thread misses; the naive message ("No image attachment named foo.pdf
// in this thread") is FALSE and was read by the model as "the file is gone"
// - it then told users Nak could not read PDFs at all. The regression is
// invisible to type checking and to every other test, which is why it gets
// its own file.
import { assertEquals, assertStringIncludes, assertRejects } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolContext } from '../venice/performToolCall.ts';
import { analyzeImage } from '../venice/tools/analyze_image.ts';
import { analyzePdfPage } from '../venice/tools/analyze_pdf_page.ts';

interface AttachmentRow {
  id: string;
  filename: string;
  storage_path: string | null;
  mime_type: string;
  page_count: number | null;
}

interface Scenario {
  /** Rows visible in the thread, regardless of type. */
  attachments?: AttachmentRow[];
  /** Page numbers that rasterized for the attachment id keying the map. */
  pages?: Record<string, number[]>;
}

/**
 * Fake admin client that answers the specific query shapes these two tools
 * build. Each `from()` returns a recorder; the terminal `maybeSingle()` (or
 * an await, for the page-number list) replays the scenario through the same
 * filters the real PostgREST call would apply, so the tools' own
 * `.eq`/`.like` choices are what select the row rather than the test
 * hand-picking an answer.
 */
function fakeCtx(scenario: Scenario): ToolContext {
  const adminClient = {
    from: (table: string) => {
      const eqs: Array<[string, unknown]> = [];
      let likePattern: string | null = null;
      const c: Record<string, unknown> = {};
      c.select = () => c;
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

      const eq = (col: string): unknown =>
        eqs.find(([k]) => k === col)?.[1];

      c.maybeSingle = () => {
        if (table === 'message_attachments') {
          const filename = eq('filename');
          let rows = (scenario.attachments ?? []).filter(
            (r) => r.filename === filename,
          );
          // The image lookup's `like('mime_type', 'image/%')`.
          if (likePattern === 'image/%') {
            rows = rows.filter((r) => r.mime_type.startsWith('image/'));
          }
          // analyze_pdf_page's exact-mime filter.
          const mime = eq('mime_type');
          if (typeof mime === 'string') {
            rows = rows.filter((r) => r.mime_type === mime);
          }
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        }
        if (table === 'message_attachment_pages') {
          const attachmentId = String(eq('attachment_id'));
          const pageNumber = eq('page_number');
          const has = (scenario.pages?.[attachmentId] ?? []).includes(
            Number(pageNumber),
          );
          return Promise.resolve({
            data: has
              ? { storage_path: `u/${attachmentId}/pages/x.jpg` }
              : null,
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      };

      // Thenable: renderedPageNumbers awaits the builder chain directly
      // instead of calling a terminal method.
      c.then = (resolve: (v: { data: unknown; error: null }) => unknown) => {
        const attachmentId = String(eq('attachment_id'));
        const nums = (scenario.pages?.[attachmentId] ?? []).map((n) => ({
          page_number: n,
        }));
        return resolve({ data: nums, error: null });
      };
      return c;
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

const pdf = (over: Partial<AttachmentRow> = {}): AttachmentRow => ({
  id: 'att-pdf',
  filename: 'contract.pdf',
  storage_path: 'u/att-pdf/contract.pdf',
  mime_type: 'application/pdf',
  page_count: 12,
  ...over,
});

// --- analyze_image's mime-aware miss --------------------------------------

Deno.test('analyze_image on a PDF says it IS present and names the type', async () => {
  const ctx = fakeCtx({ attachments: [pdf()] });
  const err = await assertRejects(
    () => analyzeImage.execute({ filename: 'contract.pdf', query: 'read it' }, ctx),
    Error,
  );
  assertStringIncludes(err.message, 'is in this conversation');
  assertStringIncludes(err.message, 'application/pdf');
  // The exact phrasing that taught the model Nak cannot read PDFs.
  assertEquals(
    err.message.includes('No image attachment named'),
    false,
    'must not report a present attachment as absent',
  );
});

Deno.test('analyze_image redirects a rasterized PDF to analyze_pdf_page with its page count', async () => {
  const ctx = fakeCtx({ attachments: [pdf({ page_count: 12 })] });
  const err = await assertRejects(
    () => analyzeImage.execute({ filename: 'contract.pdf', query: 'read it' }, ctx),
    Error,
  );
  assertStringIncludes(err.message, 'analyze_pdf_page');
  assertStringIncludes(err.message, '12 pages');
});

Deno.test('analyze_image points a non-rasterized document at its inlined text only', async () => {
  const ctx = fakeCtx({
    attachments: [
      pdf({
        id: 'att-doc',
        filename: 'notes.docx',
        mime_type:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        page_count: null,
      }),
    ],
  });
  const err = await assertRejects(
    () => analyzeImage.execute({ filename: 'notes.docx', query: 'read it' }, ctx),
    Error,
  );
  assertStringIncludes(err.message, 'inlined in the user turn');
  // No pages rendered, so offering the page tool would send the model at a
  // lever that cannot work.
  assertEquals(err.message.includes('analyze_pdf_page'), false);
});

Deno.test('analyze_image still reports a genuinely absent filename as absent', async () => {
  const ctx = fakeCtx({ attachments: [] });
  const err = await assertRejects(
    () => analyzeImage.execute({ filename: 'ghost.png', query: 'read it' }, ctx),
    Error,
  );
  assertStringIncludes(err.message, 'No image attachment named "ghost.png"');
});

// --- analyze_pdf_page argument handling + range diagnostics ---------------

Deno.test('analyze_pdf_page rejects a missing or non-positive page', async () => {
  const ctx = fakeCtx({ attachments: [pdf()] });
  for (const page of [undefined, 0, -3, 'abc']) {
    const err = await assertRejects(
      () => analyzePdfPage.execute({ filename: 'contract.pdf', page, query: 'q' }, ctx),
      Error,
    );
    assertStringIncludes(err.message, 'positive integer');
  }
});

Deno.test('analyze_pdf_page accepts a numeric string or float page', async () => {
  // The wire schema is advisory - Venice does no constrained decoding - so
  // the model sends "3" and 3.0 in practice. Both must resolve to page 3
  // rather than tripping the validation error.
  const ctx = fakeCtx({ attachments: [pdf()], pages: { 'att-pdf': [1, 2] } });
  for (const page of ['3', 3.0]) {
    const err = await assertRejects(
      () => analyzePdfPage.execute({ filename: 'contract.pdf', page, query: 'q' }, ctx),
      Error,
    );
    // Reaches the range check, which means the page parsed as 3.
    assertStringIncludes(err.message, 'Page 3 of "contract.pdf" was not rendered');
  }
});

Deno.test('analyze_pdf_page names the viewable range on an out-of-range page', async () => {
  const ctx = fakeCtx({
    attachments: [pdf({ page_count: 200 })],
    pages: { 'att-pdf': Array.from({ length: 30 }, (_, i) => i + 1) },
  });
  const err = await assertRejects(
    () => analyzePdfPage.execute({ filename: 'contract.pdf', page: 90, query: 'q' }, ctx),
    Error,
  );
  assertStringIncludes(err.message, 'The document has 200 pages');
  assertStringIncludes(err.message, 'viewable pages are 1-30');
});

Deno.test('analyze_pdf_page reports a document that rendered nothing', async () => {
  const ctx = fakeCtx({ attachments: [pdf()], pages: { 'att-pdf': [] } });
  const err = await assertRejects(
    () => analyzePdfPage.execute({ filename: 'contract.pdf', page: 1, query: 'q' }, ctx),
    Error,
  );
  assertStringIncludes(err.message, 'has no rendered pages');
  // The anti-fabrication instruction is the point of this branch.
  assertStringIncludes(err.message, 'rather than guessing');
});

Deno.test('analyze_pdf_page refuses a non-PDF and says which tool to use', async () => {
  const ctx = fakeCtx({
    attachments: [
      pdf({ id: 'att-img', filename: 'shot.png', mime_type: 'image/png' }),
    ],
  });
  const err = await assertRejects(
    () => analyzePdfPage.execute({ filename: 'shot.png', page: 1, query: 'q' }, ctx),
    Error,
  );
  assertStringIncludes(err.message, 'No PDF named "shot.png"');
  assertStringIncludes(err.message, 'analyze_image');
});

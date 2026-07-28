/**
 * Browser-side PDF rasterizer: turns a PDF File into a bounded set of JPEG
 * page images so a vision model can look at pages whose content the text
 * layer doesn't carry.
 *
 * Why this exists: Venice's /augment/text-parser returns a PDF's text layer.
 * A scanned PDF has no text layer at all, and even a text-native one drops
 * charts, diagrams, signatures, and table layout on the floor. Rendered
 * pages are what `analyze_pdf_page` (the edge tool) hands to the vision
 * model, so those documents stop being unreadable.
 *
 * Why the BROWSER renders rather than the edge function: every tool executes
 * server-side in the venice Deno island (see docs/dev/tools.md), which has no
 * PDF rasterizer - putting one there means a multi-megabyte WASM blob in the
 * bundle and its cold-start cost on every chat turn, not just PDF ones. The
 * browser already owns the app's other canvas work (`compressImage` in
 * ./attachments.ts) and pdf.js is a first-class browser library, so rendering
 * happens once at upload time and the bytes land in the bucket alongside the
 * original.
 *
 * Consumers: `src/screens/Chat.svelte` (renders at attach time, uploads at
 * send time) and `src/lib/supabase/attachment-pages.ts` (the persistence
 * half). The page bytes are read back server-side by
 * `supabase/functions/venice/tools/analyze_pdf_page.ts`.
 */

/** MIME type the rasterizer recognizes. */
export const PDF_MIME_TYPE = 'application/pdf';

/**
 * Ceiling on how many pages we rasterize per PDF.
 *
 * Every rendered page is an extra upload the user pays for at attach time,
 * so this is a cost cap, not a capability one: 30 pages at the settings
 * below runs roughly 3-5 MB on top of the original. It covers the documents
 * people actually attach to a chat message (contracts, statements, scanned
 * forms, report excerpts) without making "summarize this 400-page manual"
 * upload a book's worth of JPEGs.
 *
 * Pages past the cap are simply not rendered. `page_count` on the attachment
 * row records the document's true length, so the model can tell the user
 * which pages it can and cannot look at rather than answering as if it had
 * seen the whole thing.
 */
export const MAX_RENDERED_PDF_PAGES = 30;

/**
 * Long-edge pixel cap per rendered page. At 1400px a US Letter portrait page
 * lands near 1080px wide - about 130 DPI, which keeps ordinary body text in a
 * scan legible to a vision model. Going higher mostly buys upload bytes: the
 * vision models downsample large inputs anyway.
 */
export const PDF_PAGE_LONG_EDGE_PX = 1400;

/**
 * JPEG quality for a rendered page. Page renders are mostly flat white with
 * text, which JPEG handles well; 0.72 keeps a text page in the 100-200 KB
 * band without visible ringing around glyphs. JPEG rather than WebP because
 * this blob is consumed by Venice's vision models, and JPEG is the format
 * every one of them accepts without question.
 */
const PDF_PAGE_JPEG_QUALITY = 0.72;

export interface RenderedPdfPage {
  /** 1-based, matching how a reader numbers pages and how a user cites them. */
  pageNumber: number;
  blob: Blob;
}

export interface PdfRenderResult {
  /** True page count of the document, which may exceed `pages.length`. */
  pageCount: number;
  pages: RenderedPdfPage[];
}

/** Progress callback so the composer chip can narrate a slow render. */
export type PdfRenderProgress = (done: number, total: number) => void;

export function isPdfMimeType(mime: string): boolean {
  return mime === PDF_MIME_TYPE;
}

/**
 * Load pdf.js and point it at its worker.
 *
 * Deliberately a dynamic import: pdfjs-dist plus its worker is over a
 * megabyte, and only a session that actually attaches a PDF should pay to
 * download it. A static import would pull the whole library into the main
 * chunk for every visitor - and Rollup would warn that the dynamic import
 * here "will not move module into another chunk," which is the signal that
 * the split silently stopped working (see CLAUDE.md, "Read the warnings").
 * Keep this the ONLY import of pdfjs-dist in the app.
 */
async function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  const pdfjs = await import('pdfjs-dist');
  // pdf.js parses and lays out in a worker; without a workerSrc it falls back
  // to a "fake worker" on the main thread, which serializes parsing behind
  // rendering and makes a long document visibly freeze the composer. The
  // `?url` suffix makes Vite emit the worker as its own asset and hand back
  // its final hashed URL, which is what survives a production build.
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url'))
    .default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjs;
}

/**
 * Scale factor that fits a page's natural size under the long-edge cap.
 * Never scales UP - a small page rendered at 1:1 is already as much detail
 * as the source has, and upscaling would only inflate the JPEG. A
 * degenerate (zero or negative) page box falls back to 1:1 rather than
 * dividing by zero, which would hand pdf.js an Infinity viewport.
 */
function fitScale(width: number, height: number): number {
  const longEdge = Math.max(width, height);
  if (longEdge <= 0) return 1;
  return Math.min(1, PDF_PAGE_LONG_EDGE_PX / longEdge);
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
  });
}

/**
 * Yield to the event loop between pages.
 *
 * Rasterization runs on the main thread (pdf.js only workerizes parsing), so
 * a 30-page render without this holds the thread for several seconds and the
 * composer stops responding to typing entirely. A macrotask break between
 * pages costs a few milliseconds each and keeps the UI live throughout.
 * OffscreenCanvas in a worker would avoid the hop but is rejected for the
 * same reason `compressImage` rejects it - Safari < 16.4 lacks it.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Rasterize the leading pages of a PDF to JPEG blobs.
 *
 * Throws when the file isn't a readable PDF (corrupt bytes, or a
 * password-protected document pdf.js refuses to open) - the caller surfaces
 * that on the composer chip. A page that fails to render individually is
 * SKIPPED rather than failing the whole document: one malformed page in an
 * otherwise fine scan shouldn't cost the user every other page.
 */
export async function renderPdfPages(
  file: Blob,
  onProgress?: PdfRenderProgress
): Promise<PdfRenderResult> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  // Keep the loading task, not just the document: tearing the worker down is
  // `loadingTask.destroy()`, and PDFDocumentProxy only exposes per-page
  // `cleanup()`. Dropping the task without destroying it leaks the worker and
  // the parsed document inside it for the page's lifetime.
  const loadingTask = pdfjs.getDocument({ data });
  const doc = await loadingTask.promise;

  try {
    const pageCount = doc.numPages;
    const renderCount = Math.min(pageCount, MAX_RENDERED_PDF_PAGES);
    const pages: RenderedPdfPage[] = [];

    for (let pageNumber = 1; pageNumber <= renderCount; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      try {
        const natural = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: fitScale(natural.width, natural.height),
        });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        // Hand pdf.js the canvas, not a 2D context: `canvasContext` is the
        // backwards-compatibility path and its contract requires `canvas` to
        // be null, so passing both is contradictory. pdf.js fills the canvas
        // with white before drawing, which is what keeps a page with no
        // background box from landing on transparent black and flattening to
        // a solid black sheet in the JPEG encoder.
        await page.render({ canvas, viewport }).promise;
        const blob = await canvasToBlob(canvas, PDF_PAGE_JPEG_QUALITY);
        if (blob) pages.push({ pageNumber, blob });
        // Release the canvas backing store eagerly. Thirty full-page canvases
        // left to the GC is enough retained bitmap memory to matter on a
        // phone, and the blob no longer needs the canvas once encoded.
        canvas.width = 0;
        canvas.height = 0;
      } catch {
        // One unrenderable page is not a failed document - skip it and keep
        // going. The gap is visible downstream: the page simply has no row,
        // and analyze_pdf_page reports it as not rendered.
      } finally {
        page.cleanup();
      }
      onProgress?.(pageNumber, renderCount);
      await yieldToEventLoop();
    }

    return { pageCount, pages };
  } finally {
    // Tear the worker's document down whether or not rendering succeeded;
    // pdf.js holds the parsed document in the worker until this resolves.
    await loadingTask.destroy();
  }
}

/**
 * Test-only surface. `fitScale` decides how much detail a rendered page
 * keeps, which is the difference between legible scanned text and a blurry
 * one - but it has no caller outside `renderPdfPages`, so it stays internal
 * rather than widening this module's API. `renderPdfPages` itself is not
 * unit-testable (jsdom has neither a canvas nor a worker, the same reason
 * `compressImage` is uncovered).
 */
export const __test = { fitScale };

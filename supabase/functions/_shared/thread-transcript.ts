// Thread transcript rendering and chunking for embedding.
//
// `conversation_search` used to rank threads on a vector built from
// `title + summary` alone (2000 chars via embed-input.ts), which meant
// the words a user actually typed were never in the index: a thread
// auto-titled "Bread Recipe Modification Advice" could not be found by
// searching for "lentils" even though its first sentence says
// "I ran out of lentils". This module produces the text that fixes
// that - the real message bodies, sliced into embedding-sized pieces.
//
// One vector per thread would not have worked. A 107-message thread
// averaged into a single vector is a centroid close to nothing in
// particular; the lentil content is ~2% of its direction and still
// would not rank. So the unit of embedding is a CHUNK, many per
// thread, and the aggregation back to a thread happens on the
// similarity SCORES at query time (see the search RPC in schema.sql),
// never by combining the vectors themselves.
//
// What gets indexed: user and assistant prose, plus the tool CALLS an
// assistant made (name and arguments). Tool RESULTS are excluded - see
// renderMessage for why, and CHUNK_RENDER_VERSION for how a change to
// that decision propagates to threads already chunked.
//
// Consumers: the chunk-embedding backfill source in
// _shared/embed-input.ts, and the rechunk unit that keeps
// `thread_chunks` in step with a growing thread.

// Sizing lives beside the model id it is measured against, in
// _shared/backfill.ts - a chunk budget is a property of the embedding
// model, not of the chunker, and keeping it next to the declaration is
// what makes a model rotation trip over the fact that every number in
// it was measured against a specific model's tokenizer.
import { EMBEDDING_MAX_INPUT_CHARS } from './backfill.ts';

export { EMBEDDING_MAX_INPUT_CHARS };

/**
 * Bump when a change to this module alters the text it produces for
 * the SAME messages.
 *
 * The rechunk unit re-qualifies a thread by comparing its newest
 * message against `threads.last_chunked_msg_id`, which cannot see a
 * change to the renderer: edit the rules here and every existing
 * thread keeps its old chunks forever, because no message moved. This
 * constant is the missing signal - the claim predicate treats a
 * mismatched `threads.chunk_render_version` as work to do, so bumping
 * it re-chunks the corpus.
 *
 * Cheap to bump: `save_thread_chunks_if_claimed` skips chunks whose
 * text is byte-identical, so threads the change does not actually
 * affect are re-rendered, compared, and left alone without spending an
 * embedding call.
 *
 * 1 - initial: prose, tool calls, and excerpted tool results.
 * 2 - tool result BODIES dropped from the index.
 * 3 - chunk budget cut from ~15315 to ~957 chars for gte-small's
 *     512-token max sequence length. The ONNX runtime silently
 *     truncates past this limit, so the old chunks had ~89% of their
 *     text ignored by the embedder. Re-chunking at the smaller budget
 *     means each chunk fits wholly within the model's window.
 * 4 - chars-per-token divisor raised from 2.2 (bge-m3 measurement)
 *     to 3.5 (gte-small BERT WordPiece estimate), increasing the
 *     chunk budget from ~957 to ~1523 chars. Roughly halves the
 *     chunk count and the drain time without risking overflow.
 */
export const CHUNK_RENDER_VERSION = 4;

/**
 * Per-row excerpt caps applied while rendering.
 *
 * Mirrors the excerpt discipline in venice/agents/_curation_helpers.ts,
 * which sizes transcripts for the curation models rather than for the
 * embedder, and is intentionally not shared with it: these caps serve
 * retrieval quality, those serve a context window, and they will drift
 * apart.
 */
const MAX_PROSE_CHARS = 8_000;
const MAX_TOOL_CALL_ARGS_CHARS = 500;

/** The subset of a message row this module reads. */
export interface TranscriptMessage {
  id: string;
  role: string;
  content: string | null;
  tool_calls: unknown[] | null;
  name: string | null;
}

/** One embedding-sized slice of a thread's transcript. */
export interface TranscriptChunk {
  /** 0-based position in the thread. Stable as the thread grows - see chunkTranscript. */
  index: number;
  /** The text handed to the embedder. */
  text: string;
  /** First message this chunk covers, for anchoring a passage fetch back to the thread. */
  startMsgId: string;
  /** Last message this chunk covers. Equal to startMsgId when one message spans several chunks. */
  endMsgId: string;
}

function excerpt(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap) : text;
}

/**
 * Render a message's tool calls as `name({args})`, one per line.
 * The call's ARGUMENTS carry retrieval signal that nothing else in the
 * transcript does - a `conversation_search` for "cider soak no lentils"
 * records what the model was looking for even when the result it got
 * back was useless - so they are kept, but capped, because an
 * arguments blob can carry an inlined document.
 */
function renderToolCalls(toolCalls: readonly unknown[]): string[] {
  const lines: string[] = [];
  for (const raw of toolCalls) {
    if (!raw || typeof raw !== 'object') continue;
    const fn = (raw as { function?: unknown }).function;
    if (!fn || typeof fn !== 'object') continue;
    const name = (fn as { name?: unknown }).name;
    if (typeof name !== 'string' || name.length === 0) continue;
    const args = (fn as { arguments?: unknown }).arguments;
    const argText = typeof args === 'string' ? excerpt(args, MAX_TOOL_CALL_ARGS_CHARS) : '';
    lines.push(`assistant calls ${name}(${argText})`);
  }
  return lines;
}

/**
 * Render one stored message to its transcript form, or null when it
 * carries nothing worth indexing (an empty assistant row that exists
 * only to hang tool calls off still renders those calls).
 *
 * The role prefix is deliberate: gte-small (like its predecessor
 * bge-m3) is a general text encoder with no notion of chat structure,
 * so "user:" / "assistant:" are just words that give the model
 * something to bind a speaker distinction to. Without them a question
 * and its answer embed identically.
 */
export function renderMessage(msg: TranscriptMessage): string | null {
  const content = typeof msg.content === 'string' ? msg.content.trim() : '';
  const parts: string[] = [];

  // Tool RESULTS are not indexed. They were 34.8% of the corpus by
  // character and made 29% of chunks majority-machine-output: search
  // result arrays, wiki article bodies, recipe payloads, each carrying
  // UUIDs and float scores. Three problems with indexing them. They
  // describe whatever the tool happened to return rather than what the
  // conversation was about - a thread about meatballs carried a chunk
  // that was mostly a wiki dump about brownies. They are the densest
  // content per token (2.24 chars/token against 3.86 for prose), so
  // they consume budget fastest. And because every tool-using thread
  // accumulates the same shapes of JSON, they pull unrelated
  // conversations toward a common region of the space, which is what
  // compressed the score band and left the model unable to tell a good
  // hit from a mediocre one.
  //
  // The CALL is kept (below) - it carries what the model was looking
  // for, in the user's vocabulary, which is exactly the retrieval
  // signal the result lacks.
  if (msg.role === 'tool') return null;

  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    parts.push(...renderToolCalls(msg.tool_calls));
  }
  if (content.length > 0) {
    parts.push(`${msg.role}: ${excerpt(content, MAX_PROSE_CHARS)}`);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Hard-split one over-long rendered message into chunk-sized pieces.
 * Only reachable when a single message exceeds maxChars on its own
 * (a pasted document, mostly). Splitting mid-word is acceptable here:
 * the alternative is dropping the message from the index entirely.
 */
function splitOversized(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    pieces.push(text.slice(i, i + maxChars));
  }
  return pieces;
}

/**
 * Slice a thread's messages into embedding-sized chunks, greedily and
 * in order.
 *
 * Greedy-from-the-start is the load-bearing property: chunk N's
 * boundaries depend only on the messages BEFORE it, so appending a
 * message to a thread cannot renumber or rewrite any chunk except the
 * last (partial) one. That is what makes re-chunking a growing thread
 * cheap - the rechunk unit re-embeds the tail, not the history. Any
 * change here that makes boundaries depend on the whole message list
 * (balancing chunk sizes, say) silently turns every append into a full
 * re-embed of the thread.
 *
 * `maxChars` is an estimate-derived budget, not a guarantee - see
 * EMBEDDING_CHARS_PER_TOKEN. Callers must still handle the embedder
 * rejecting a chunk for length.
 */
export function chunkTranscript(
  messages: readonly TranscriptMessage[],
  maxChars: number = EMBEDDING_MAX_INPUT_CHARS,
): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  let buf: string[] = [];
  let bufLen = 0;
  let startMsgId = '';
  let endMsgId = '';

  const flush = () => {
    if (buf.length === 0) return;
    chunks.push({
      index: chunks.length,
      text: buf.join('\n\n'),
      startMsgId,
      endMsgId,
    });
    buf = [];
    bufLen = 0;
    startMsgId = '';
  };

  for (const msg of messages) {
    const rendered = renderMessage(msg);
    if (rendered === null) continue;

    if (rendered.length > maxChars) {
      // The message cannot share a chunk with anything, so close the
      // open one and emit its pieces as whole chunks.
      flush();
      for (const piece of splitOversized(rendered, maxChars)) {
        chunks.push({
          index: chunks.length,
          text: piece,
          startMsgId: msg.id,
          endMsgId: msg.id,
        });
      }
      continue;
    }

    // +2 for the blank line this message would add after the previous.
    const projected = bufLen === 0 ? rendered.length : bufLen + 2 + rendered.length;
    if (projected > maxChars) flush();

    if (buf.length === 0) startMsgId = msg.id;
    buf.push(rendered);
    bufLen = buf.length === 1 ? rendered.length : bufLen + 2 + rendered.length;
    endMsgId = msg.id;
  }
  flush();

  return chunks;
}

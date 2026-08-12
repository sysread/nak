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
// Consumers: the chunk-embedding backfill source in
// _shared/embed-input.ts, and the rechunk unit that keeps
// `thread_chunks` in step with a growing thread.

// Mirrors VENICE_EMBEDDING_MAX_INPUT_TOKENS / EMBEDDING_CHARS_PER_TOKEN
// / EMBEDDING_INPUT_SAFETY_MARGIN / EMBEDDING_MAX_INPUT_CHARS in
// src/lib/models/index.ts - kept in sync by hand because the Deno
// island does not import from the Vite app (same arrangement as
// VENICE_EMBEDDING_MODEL in _shared/backfill.ts). The rationale for
// each number, including the measured chars-per-token table, lives on
// the definitions there; do not re-tune these without reading it.
export const VENICE_EMBEDDING_MAX_INPUT_TOKENS = 8192;
export const EMBEDDING_CHARS_PER_TOKEN = 2.2;
export const EMBEDDING_INPUT_SAFETY_MARGIN = 0.85;
export const EMBEDDING_MAX_INPUT_CHARS = Math.floor(
  VENICE_EMBEDDING_MAX_INPUT_TOKENS *
    EMBEDDING_INPUT_SAFETY_MARGIN *
    EMBEDDING_CHARS_PER_TOKEN,
);

/**
 * Per-row excerpt caps applied while rendering. Tool results are the
 * reason these exist: a single `conversation_search` result row is
 * routinely 6-12kB of JSON - UUIDs, similarity floats, ISO timestamps -
 * which is both the densest content per token (measured 2.24 chars per
 * token, against 3.86 for prose) and the least useful to retrieve on.
 * Letting one search dump fill a whole chunk would bury the prose that
 * a query actually needs to match.
 *
 * The head is kept rather than the tail: tool results lead with the
 * payload that identifies them (a recipe's title and ingredients, a
 * search hit's title) and trail into pagination noise.
 *
 * Mirrors the excerpt discipline in venice/agents/_curation_helpers.ts,
 * which sizes transcripts for the curation models rather than for the
 * embedder, and is intentionally not shared with it: these caps serve
 * retrieval quality, those serve a context window, and they will drift
 * apart.
 */
const MAX_TOOL_RESULT_CHARS = 2_000;
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
 * The role prefix is deliberate: bge-m3 is a general text encoder with
 * no notion of chat structure, so "user:" / "assistant:" are just
 * words that give the model something to bind a speaker distinction
 * to. Without them a question and its answer embed identically.
 */
export function renderMessage(msg: TranscriptMessage): string | null {
  const content = typeof msg.content === 'string' ? msg.content.trim() : '';
  const parts: string[] = [];

  if (msg.role === 'tool') {
    if (content.length === 0) return null;
    const label = msg.name ? `tool ${msg.name}` : 'tool';
    return `${label}: ${excerpt(content, MAX_TOOL_RESULT_CHARS)}`;
  }

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

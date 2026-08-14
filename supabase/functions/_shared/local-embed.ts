// Local embedding inference via the edge runtime's built-in ONNX runtime.
//
// Supabase's edge-runtime ships a native Rust ONNX backend with the
// gte-small model pre-bundled in the Docker image at
// /etc/sb_ai/models/gte-small/. This module wraps the Supabase.ai.Session
// API so callers see a simple string -> number[] function without
// managing session lifecycle or knowing which model is loaded.
//
// The session is created lazily on first call (not at module scope) so
// that test modules which transitively import this file but never call
// localEmbed don't crash on `Supabase is not defined` - the global is
// injected by the edge-runtime Docker image, not by standard Deno.
// Once created, the session persists across requests within the
// worker's warm window. Cold start (model load + ONNX init) takes ~7s;
// warm inference is ~100-180ms per call. The edge runtime's 2s CPU-time
// budget per worker is the binding constraint on batch backfill -
// roughly 12-15 inferences before the worker is recycled.
//
// Replaces the previous veniceEmbed path which called Venice's
// /embeddings API over the network. The model switched from
// text-embedding-bge-m3 (1024 dims, MTEB ~64) to gte-small (384 dims,
// MTEB 61.36). All existing embeddings were nulled and re-embedded via
// the backfill sweep. See docs/dev/embeddings.md.
//
// The 384-dim output is zero-extended to the 2048-dim storage column by
// padEmbeddingForStorage in backfill.ts. Cosine similarity is invariant
// under zero-extension, so padded vectors rank identically to their
// native prefix.

/// <reference path="../types.d.ts" />

import { EMBEDDING_MODEL } from './backfill.ts';

// Lazy session - created on first call, then reused for the worker's
// lifetime. Supabase.ai is a global injected by the edge runtime; the
// type declaration lives in supabase/functions/types.d.ts.
let session: Supabase.ai.Session | null = null;

/**
 * Produce a 384-dim embedding vector for `input` using the built-in
 * gte-small model. Mean pooling and L2 normalization are applied so
 * the result is directly comparable via dot product or cosine
 * similarity. No API key or model parameter needed - the session
 * owns both.
 */
export async function localEmbed(input: string): Promise<number[]> {
  if (!session) {
    session = new Supabase.ai.Session(EMBEDDING_MODEL);
  }
  return await session.run(input, { mean_pool: true, normalize: true });
}

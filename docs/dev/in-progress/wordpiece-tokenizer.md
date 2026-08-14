# Plan: exact WordPiece token counting for chunk sizing

## Problem

The chunker sizes chunks by a chars-per-token estimate
(EMBEDDING_CHARS_PER_TOKEN = 3.5). gte-small silently truncates
past 512 tokens with no error. The estimate is close for prose
(~4 chars/token) but wrong for dense content: cooklang runs ~2.69
chars/token, so a 1523-char cooklang chunk hits ~566 tokens and
loses its tail. ~101 of ~4572 chunks are dense enough to overflow.

The fix is to count real tokens with the actual BERT WordPiece
tokenizer instead of estimating.

## Approach

Bring the gte-small tokenizer into the edge function as a bundled
vocab + a TS WordPiece implementation. Replace the char-based
chunk budget with an exact token count. The chunker packs messages
until `countTokens(candidate) <= 500` instead of
`candidate.length <= EMBEDDING_MAX_INPUT_CHARS`.

## Files

### New: `supabase/functions/_shared/wordpiece.ts`

BERT WordPiece tokenizer, faithful to thenlper/gte-small's
tokenizer.json config:

- BertNormalizer: clean_text, handle_chinese_chars, lowercase,
  strip_accents (null -> ON for lowercase BERT)
- BertPreTokenizer: whitespace split, then punctuation as own
  tokens (ASCII symbol ranges count as punctuation - wider than
  Unicode P*)
- WordPiece: greedy longest-match-first, `##` prefix on
  non-initial pieces, `[UNK]` on failure, max_input_chars 100
- Post-processor: [CLS] + [SEP] = +2 tokens per sequence

Exports:

- `countTokens(text, vocab): number` - returns exact token count
  including special tokens. Counting (not ids) on purpose: the
  only consumer is the chunker deciding where to split.
- `loadVocab(raw: string): Set<string>` - builds the lookup from
  the newline-delimited vocab string.
- `SPECIAL_TOKENS_PER_SEQUENCE = 2` - [CLS] and [SEP].

### New: `scripts/bundle-gte-vocab.mjs`

Generator script, mirrors `scripts/bundle-research-docs.mjs`:

- Fetches `thenlper/gte-small/tokenizer.json` from HuggingFace
- Extracts the WordPiece vocab (30,522 entries)
- Emits `supabase/functions/venice/_generated/gte-small-vocab.ts`
  as `export const GTE_SMALL_VOCAB = "...";`
- Output is gitignored, same pattern as the research-docs corpus
- 231 KB raw, 110 KB gzipped - nothing for esbuild to bundle

### New: `supabase/functions/venice/_generated/gte-small-vocab.ts`

Generated vocab module. Gitignored. Imported by
`_shared/wordpiece.ts` or loaded at module scope in the chunker.

### Modified: `supabase/functions/_shared/thread-transcript.ts`

- `chunkTranscript` swaps the char-length predicate for a token
  count predicate: `countTokens(candidate, vocab) <= 500` instead
  of `candidate.length <= EMBEDDING_MAX_INPUT_CHARS`.
- Greedy-from-the-start packing stays - chunk stability depends on
  it. Only the predicate changes.
- Perf: count incrementally per message (add the new message's
  tokens to the running total) rather than re-tokenizing the whole
  accumulated buffer each time. Otherwise packing goes quadratic on
  long threads.
- `CHUNK_RENDER_VERSION` -> 4 (currently 4 from the 3.5 divisor
  bump; this would be 5). Another full re-chunk of all threads.
- `splitOversized` also switches to token-based splitting.

### Modified: `supabase/functions/_shared/backfill.ts`

- `EMBEDDING_CHARS_PER_TOKEN` and `EMBEDDING_INPUT_SAFETY_MARGIN`
  become dead code - the chunker no longer uses them.
- `EMBEDDING_MAX_INPUT_CHARS` is no longer derived from the
  estimate. Either remove it or repurpose it as a hard ceiling
  for the `splitOversized` case (a single message so long it
  needs hard-splitting even by token count).
- `EMBEDDING_MAX_INPUT_TOKENS = 512` stays - it's the model's
  hard limit. The chunk budget targets ~500 (not 512) to leave
  headroom for normalizer drift.

### Modified: `.mise.toml`

- Add `bundle-vocab` task mirroring `bundle-docs` (runs
  `scripts/bundle-gte-vocab.mjs`).
- Add `bundle-vocab` to the `depends` list of `check` and
  `functions-deploy` tasks, same as `bundle-docs`.

### Modified: `.gitignore`

- Add `supabase/functions/venice/_generated/gte-small-vocab.ts`
  (or the `_generated/` glob may already cover it).

### Modified: `supabase/functions/tests/thread-transcript.test.ts`

- The chunk budget tests switch from char-based assertions to
  token-based assertions.
- The chars-per-token divisor test is removed (no longer a
  concept).
- The render version guard test bumps to the new version.

## Tokenizer config (from thenlper/gte-small/tokenizer.json)

```text     BertNormalizer { clean_text: true, handle_chinese_chars: true,
                                 strip_accents: null, lowercase: true }
pre_tokenizer:  BertPreTokenizer          (whitespace, then punctuation as own tokens)
model:          WordPiece, unk "[UNK]", continuing_subword_prefix "##",
                max_input_chars_per_word 100, vocab 30522
post_processor: TemplateProcessing -> [CLS] A [SEP]    // +2 tokens per sequence
```

Note: `strip_accents: null` with `lowercase: true` resolves to
accent stripping ON (the bert-base-uncased default).

## Verified chars/token measurements (both Python and TS agree)

| content                 | chars/token |
| ----------------------- | ----------- |
| prose                   | 4.07        |
| tool calls (incl UUIDs) | 3.03        |
| cooklang                | 2.69        |
| corpus blend            | 4.05        |

These are measured numbers, not estimates. The 3.5 divisor on main
today is between prose and cooklang - safe for most content, wrong
for the densest 2.2%.

## Key decisions

- **Budget ~500, not 512.** A reimplemented normalizer can drift a
  token or two on odd input. The margin costs nothing.
- **Count, don't tokenize to ids.** The chunker only needs a
  number. Returning ids would allocate an array per candidate
  slice.
- **Incremental counting.** Add each message's token count to the
  running buffer total. Re-tokenizing the whole buffer on every
  candidate message is O(n^2) on long threads.
- **Bundle the vocab, don't read it at runtime.** esbuild inlines
  modules, not loose data files. The generated .ts module is what
  makes bundling reliable. Same pattern as the research-docs
  corpus.
- **One final re-chunk.** Bumping CHUNK_RENDER_VERSION triggers
  another full re-chunk of all 478 threads. Worth doing as the
  last one - after this, chunk sizing is exact and no further
  bumps are needed for model-specific tokenizer differences.

## Standing risk while pending

At the 3.5 divisor currently on main, a cooklang-dense chunk hits
~566 tokens against the 512 hard limit and silently loses its tail.
~101 dense chunks of ~4572 today. The overflow is partial truncation
(the chunk still gets embedded, just with less text indexed), not
corruption. Fixing this is the point of the tokenizer plan.

## Reference implementation

The cloud session produced a verified TS port of the WordPiece
tokenizer that matches a Python reference exactly on four sample
inputs (321/146/86/3017 tokens). The implementation is included
in the handoff notes above. Key things the implementer needs to
know:

- ASCII symbol ranges (33-47, 58-64, 91-96, 123-126) count as
  punctuation - wider than Unicode P*. This matters because
  cooklang is dense in `@`, `{}`, `=`.
- CJK ideographs get space-padded so each character tokenizes
  alone.
- normalize() drops control chars and folds whitespace before
  lowercasing + accent stripping.
- The whole-word [UNK] path (no valid subword split) returns 1
  token, not 0.

## Sequencing

1. Let the current drain (version 4, 3.5 divisor) finish or get
   close to finishing. The queue is ~8094 rows at ~5 rows/min =
   ~27 hours.
2. Implement the tokenizer: bundle script, wordpiece.ts,
   chunker changes, tests.
3. Bump CHUNK_RENDER_VERSION to 5, deploy.
4. The re-chunk fires, new chunks are token-accurate, the
   backfill drains the final queue.
5. Relax the cron schedule back to */5 once the queue is empty.

If the current drain is still running when the tokenizer is ready,
the version 5 bump will re-chunk and re-null everything again.
That's fine - the old embeddings get replaced either way. But
doing it after the drain finishes avoids wasting the embed compute
on chunks that are about to be replaced.

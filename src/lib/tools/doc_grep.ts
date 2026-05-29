/**
 * Exact regex search inside Library documents - the deterministic half of the
 * grep-then-read loop the chat model runs over a large document, mirroring how
 * a coding agent greps a big file for line numbers before reading a range.
 * Complements the semantic doc_search: this finds the precise clause once the
 * model knows the wording; doc_search finds the right document when it doesn't.
 *
 * An invalid regex comes back from Postgres as an error; we rephrase it into
 * actionable text rather than throwing so the model can fix its pattern and
 * retry instead of treating it as a hard tool failure.
 */
import type { ToolDef } from './types';
import {
  docGrepSchema,
  DOC_GREP_DEFAULT_CONTEXT,
  DOC_GREP_MAX_CONTEXT,
  DOC_GREP_DEFAULT_MAX_MATCHES,
  DOC_GREP_MAX_MATCHES,
} from './doc_grep.schema';

export const docGrep: ToolDef = {
  ...docGrepSchema,
  async execute(args, ctx) {
    const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
    if (!pattern) throw new Error('pattern is required');
    const documentId =
      typeof args.document_id === 'string' && args.document_id.trim().length > 0
        ? args.document_id.trim()
        : null;
    const caseSensitive = args.case_sensitive === true;
    const rawContext =
      typeof args.context === 'number' ? args.context : DOC_GREP_DEFAULT_CONTEXT;
    const context = Math.max(0, Math.min(DOC_GREP_MAX_CONTEXT, Math.floor(rawContext)));
    const rawMax =
      typeof args.max_matches === 'number' ? args.max_matches : DOC_GREP_DEFAULT_MAX_MATCHES;
    const maxMatches = Math.max(1, Math.min(DOC_GREP_MAX_MATCHES, Math.floor(rawMax)));

    let hits;
    try {
      hits = await ctx.supabase.grepDocument({
        pattern,
        documentId,
        caseSensitive,
        context,
        maxMatches,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Postgres flags a bad regex as an "invalid regular expression" error;
      // surface it as guidance so the model corrects the pattern and retries.
      if (/regular expression|invalid.*regex/i.test(message)) {
        return { error: `Invalid regular expression: ${message}. Fix the pattern and try again.` };
      }
      throw err;
    }

    return {
      match_count: hits.length,
      truncated: hits.length >= maxMatches,
      matches: hits.map((h) => ({
        document_id: h.document_id,
        title: h.title,
        line_number: h.line_number,
        line_text: h.line_text,
        context_before: h.context_before,
        context_after: h.context_after,
      })),
    };
  },
};

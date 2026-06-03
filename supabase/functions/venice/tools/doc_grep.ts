// doc_grep (function-side port)
//
// Exact regex search inside Library documents via grep_documents
// RPC. Wire schema lives in src/lib/tools/doc_grep.schema.ts.
//
// Invalid regex (Postgres "invalid regular expression" error) is
// rephrased as actionable text rather than thrown so the model can
// fix the pattern and retry.
//
// Auth: b-strict. The RPC takes p_user_id explicitly (see schema
// delta in this branch) so the function side can call it safely
// under the service-role admin client.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

// Mirror of DOC_GREP_* constants in src/lib/tools/doc_grep.schema.ts.
const DOC_GREP_DEFAULT_CONTEXT = 2;
const DOC_GREP_MAX_CONTEXT = 5;
const DOC_GREP_DEFAULT_MAX_MATCHES = 50;
const DOC_GREP_MAX_MATCHES = 200;

interface GrepHit {
  document_id: string;
  title: string;
  line_number: number;
  line_text: string;
  context_before: string[];
  context_after: string[];
}

export const docGrep: ToolDef = {
  name: 'doc_grep',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
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

    const { data, error } = await ctx.adminClient.rpc('grep_documents', {
      p_pattern: pattern,
      p_document_id: documentId,
      p_case_sensitive: caseSensitive,
      p_context: context,
      p_max_matches: maxMatches,
      p_user_id: ctx.userId,
    });

    if (error) {
      if (/regular expression|invalid.*regex/i.test(error.message)) {
        return {
          error: `Invalid regular expression: ${error.message}. Fix the pattern and try again.`,
        };
      }
      throw new Error(`grepDocument failed: ${error.message}`);
    }

    const hits = (data ?? []) as GrepHit[];
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

registerTool(docGrep);

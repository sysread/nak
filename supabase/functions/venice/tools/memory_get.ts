// memory_get (function-side)
//
// Fetch one stored memory by id - the drill-down that makes a recall
// citation actionable. Parallel to conversation_get / wiki_get. The
// context-recall smoothing pass cites memories by id; this lets the
// model pull the verbatim stored row to verify a recollection's
// specifics (a number, a name, a decision) before asserting them,
// instead of trusting the compressed recall prose.
//
// Auth: b-strict. memories.user_id direct ownership filter - the
// miss-vs-not-owned branches are indistinguishable to a probing caller,
// matching RLS behaviour on the browser path.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

interface MemoryRow {
  id: string;
  label: string;
  data: string;
  confidence: number | null;
  created_at: string;
  updated_at: string;
}

export const memoryGet: ToolDef = {
  name: 'memory_get',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('id is required');

    const { data, error } = await ctx.adminClient
      .from('memories')
      .select('id, label, data, confidence, created_at, updated_at')
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .maybeSingle<MemoryRow>();
    if (error) throw new Error(`memory_get failed: ${error.message}`);
    if (!data) return { found: false };

    return {
      found: true,
      memory: {
        id: data.id,
        label: data.label,
        data: data.data,
        confidence: data.confidence,
        created_at: data.created_at,
        updated_at: data.updated_at,
      },
    };
  },
};

registerTool(memoryGet);

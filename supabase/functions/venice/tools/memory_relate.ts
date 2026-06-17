// memory_relate (function-side port)
//
// Create a directed edge in the memory-relations graph. Four kinds:
// supports, contradicts, generalises, specialises. Self-loops
// rejected at the tool boundary. Duplicates (same from/to/kind) are
// caught by a unique constraint and surfaced as a clean
// "already_exists" so the model doesn't loop trying to re-insert.
// Wire schema lives in src/lib/tools/memory_relate.schema.ts.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { ArgErrors } from './_validate.ts';

// Mirror of RELATION_KINDS / MEMORY_RELATE_MAX_NOTE_CHARS in
// src/lib/tools/memory_relate.schema.ts.
const RELATION_KINDS: readonly string[] = [
  'supports',
  'contradicts',
  'generalises',
  'specialises',
];
const MEMORY_RELATE_MAX_NOTE_CHARS = 200;

export const memoryRelate: ToolDef = {
  name: 'memory_relate',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const fromId = typeof args.from_id === 'string' ? args.from_id : '';
    const toId = typeof args.to_id === 'string' ? args.to_id : '';
    const kindArg = typeof args.kind === 'string' ? args.kind : '';
    const errs = new ArgErrors();
    if (!fromId) errs.add('from_id is required');
    if (!toId) errs.add('to_id is required');
    if (!kindArg) errs.add('kind is required');
    // Self-loop check needs both ids; the empty-string pair would read as
    // equal before either id is supplied.
    if (fromId && toId && fromId === toId) {
      errs.add('from_id and to_id must differ (no self-loops)');
    }
    // Enum check only once a kind was supplied - an empty kind already drew
    // the required error above.
    if (kindArg && !RELATION_KINDS.includes(kindArg)) {
      errs.add(`kind must be one of ${RELATION_KINDS.join(', ')} (got ${kindArg})`);
    }

    let note: string | null = null;
    if (args.note !== undefined) {
      if (typeof args.note !== 'string') {
        errs.add('note must be a string');
      } else if (args.note.length > MEMORY_RELATE_MAX_NOTE_CHARS) {
        errs.add(
          `note exceeds ${MEMORY_RELATE_MAX_NOTE_CHARS}-char limit (got ${args.note.length})`,
        );
      } else {
        const trimmed = args.note.trim();
        note = trimmed.length > 0 ? trimmed : null;
      }
    }
    errs.throwIfAny();

    // RLS OFF: filter by userId. memory_relations.user_id stamped
    // on insert.
    const { data, error } = await ctx.adminClient
      .from('memory_relations')
      .insert({
        user_id: ctx.userId,
        from_memory_id: fromId,
        to_memory_id: toId,
        kind: kindArg,
        note,
      })
      .select('id, kind')
      .single();

    if (error) {
      // Postgres 23505 (unique_violation) on the (user_id, from, to,
      // kind) unique index. Treat as benign so the model doesn't loop
      // retrying. supabase-js wraps the message verbatim; either
      // phrasing surfaces depending on which constraint hit.
      const msg = error.message;
      if (msg.includes('duplicate key value') || msg.includes('unique constraint')) {
        return { ok: true, already_exists: true, kind: kindArg };
      }
      throw new Error(`createMemoryRelation failed: ${msg}`);
    }

    return data;
  },
};

registerTool(memoryRelate);

/**
 * Draw a directed edge between two memories in the volitional-memory
 * graph. The four kinds encode the common shapes the LLM's world-model
 * tends to want:
 *
 *   - supports:    target reinforces the source claim. Use when two
 *                  memories independently point at the same pattern.
 *   - contradicts: target disagrees with the source. Stored
 *                  asymmetrically - if the reverse direction also
 *                  matters, assert it as a separate relation.
 *   - generalises: target is a broader version of the source. "Jeff
 *                  likes ASCII in comments" generalises to "Jeff
 *                  prefers plain text over typographic polish".
 *   - specialises: target is a concrete case of the source. Inverse of
 *                  generalises; both directions are legal assertions.
 *
 * Self-loops are rejected at the tool boundary. Duplicate edges (same
 * from/to/kind) are caught by the unique constraint on the table and
 * surfaced as a clean "already exists" rather than a raw SQL error.
 *
 * Note rides alongside so the LLM can leave a short rationale for the
 * link - useful for later retrieval when the LLM reads the block back
 * and has to decide whether the edge still makes sense.
 */
import type { ToolDef } from './types';

const RELATION_KINDS = [
  'supports',
  'contradicts',
  'generalises',
  'specialises',
] as const;

type RelationKind = (typeof RELATION_KINDS)[number];

const MAX_NOTE_CHARS = 500;

export const memoryRelate: ToolDef = {
  name: 'memory_relate',
  description:
    'Link two memories with a directed edge. `kind` is one of ' +
    "supports/contradicts/generalises/specialises. `note` is an " +
    'optional short rationale (up to 500 chars) describing the link. ' +
    'Relations show up next to their source memory when it surfaces in ' +
    'retrieval. Self-loops are rejected; repeated edges (same ' +
    'from/to/kind) collapse to a no-op. Returns {id, kind}.',
  shortDescription: 'link two memories',
  parameters: {
    type: 'object',
    properties: {
      from_id: {
        type: 'string',
        description: 'UUID of the source memory (the edge originates here).',
      },
      to_id: {
        type: 'string',
        description: 'UUID of the target memory (the edge points here).',
      },
      kind: {
        type: 'string',
        enum: [...RELATION_KINDS],
        description:
          'Relation kind. supports=target reinforces source; ' +
          'contradicts=target disagrees with source; ' +
          'generalises=target is a broader form; ' +
          'specialises=target is a narrower/concrete case.',
      },
      note: {
        type: 'string',
        maxLength: MAX_NOTE_CHARS,
        description: 'Optional short rationale for the link.',
      },
    },
    required: ['from_id', 'to_id', 'kind'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const fromId = typeof args.from_id === 'string' ? args.from_id : '';
    const toId = typeof args.to_id === 'string' ? args.to_id : '';
    const kindArg = typeof args.kind === 'string' ? args.kind : '';
    if (!fromId) throw new Error('from_id is required');
    if (!toId) throw new Error('to_id is required');
    if (!kindArg) throw new Error('kind is required');
    // Self-loops read as either a bug in the caller or the LLM losing
    // track of which id is which. Better to fail loud than store a
    // degenerate edge that clutters retrieval forever.
    if (fromId === toId) {
      throw new Error('from_id and to_id must differ (no self-loops)');
    }
    if (!(RELATION_KINDS as readonly string[]).includes(kindArg)) {
      throw new Error(
        `kind must be one of ${RELATION_KINDS.join(', ')} (got ${kindArg})`
      );
    }
    const kind = kindArg as RelationKind;
    let note: string | null = null;
    if (args.note !== undefined) {
      if (typeof args.note !== 'string') {
        throw new Error('note must be a string');
      }
      if (args.note.length > MAX_NOTE_CHARS) {
        throw new Error(
          `note exceeds ${MAX_NOTE_CHARS}-char limit (got ${args.note.length})`
        );
      }
      const trimmed = args.note.trim();
      note = trimmed.length > 0 ? trimmed : null;
    }
    try {
      return await ctx.supabase.createMemoryRelation(fromId, toId, kind, note);
    } catch (err) {
      // The unique constraint fires as a Postgres 23505 error; supabase-js
      // wraps it as a SupabaseError with the SQL message. Treat it as a
      // no-op success so the LLM doesn't retry the same link in a loop.
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('duplicate key value') ||
        msg.includes('unique constraint')
      ) {
        return {
          ok: true,
          already_exists: true,
          kind,
        };
      }
      throw err;
    }
  },
};

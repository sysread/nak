// context-recall smoothing (the recall-time narrative pass)
//
// Turns the deterministically-gathered index plus the current exchange
// into the recollection that gets injected as the synthetic <think>
// turn: ONE fast-tier completion returns a first-person note -
// compressed, anchored in the PAST on each memory's real recorded date,
// bridged to what the user just said, with `^N^` citation superscripts
// keyed back to the source rows.
//
// Why this is NOT the synthesis-hallucination design context-recall.md
// warns against: retrieval stays
// deterministic and verbatim (gatherContextIndex), and every claim the
// smoothing emits carries a citation back to a real source row - the
// raw memory still exists in the store and via drill-down, so a drift
// is recoverable, not an unfalsifiable confabulation. The synthesis is
// a presentation layer over a known-good retrieval, not the system of
// record.
//
// Temporal laundering is the load-bearing job here. Stored memories
// carry encoding-time self-reference ("this conversation", "(June
// 2026)", "SUCCESS this session") that was true when written and is a
// lie at every later recall. The prompt is told to ignore that framing
// and re-anchor on the real created_at it is handed - which is why the
// memory layer threads created_at through to the index.

import { type EdgeLogger } from '../../_shared/edge-log.ts';
import { toolComplete } from '../tools/_venice_complete.ts';
import { type ContextRecallCitation } from './context-recall-payload.ts';
import {
  type ContextIndex,
  type ContextIndexFollowup,
} from './context-recall.ts';

// Mirror of agentModel('reflection').id - the same fast, cheap, large-
// context tier reflection already runs on. Reasoning is disabled on the
// call (disable_thinking) because this is on the live turn's critical
// path and the task is faithful integration, not deliberation - the
// same posture web_search takes.
const SMOOTHING_MODEL = 'deepseek-v4-flash';

// The recollection is a short paragraph, not an essay. Cap generously
// enough that a multi-source recall doesn't get truncated mid-citation.
const SMOOTHING_MAX_TOKENS = 800;

const SMOOTHING_SYSTEM_PROMPT = [
  'You are the memory faculty of an AI assistant - the part that, in',
  'the middle of a conversation, surfaces a relevant recollection and',
  'hands it to the conscious mind as a single integrated thought.',
  '',
  'You are given:',
  '  1. THE CURRENT EXCHANGE - what the user and assistant are',
  '     discussing right now.',
  '  2. RETRIEVED MEMORY - a numbered list of things recalled from',
  '     long-term memory about THIS user: stored facts, prior',
  '     conversations, and wiki articles. Memory facts carry the real',
  '     date they were recorded.',
  '  3. Possibly OPEN FOLLOW-UPS - questions the assistant saved for',
  '     itself whose answers it does NOT yet have.',
  '',
  "Write a short first-person recollection, in the assistant's voice,",
  'that the assistant will read as its own memory surfacing just before',
  'it replies. Recall the way a person does: not a verbatim replay, but',
  'a compressed thought that already carries why it came to mind.',
  '',
  'Rules:',
  '- RECALL, NOT RELIVING. Everything you write happened in the PAST.',
  '  Anchor each recollection in time using the real recorded date',
  '  ("back on 2026-05-27...", "a while ago..."). Never imply any of it',
  '  is happening in the current conversation.',
  '- LAUNDER STALE FRAMING. A memory\'s own text may say "this',
  '  conversation", "this session", "today", or carry a date from when',
  '  it was written. That phrasing was true when recorded and is FALSE',
  '  now. Ignore it and re-anchor on the real recorded date you were',
  '  given. Never reproduce "this conversation" / "this session" from a',
  '  source.',
  '- BRIDGE TO NOW. For each thing you recall, make clear how it',
  '  connects to the current exchange. The recollection exists to',
  '  inform the present reply, not to recap the past for its own sake.',
  '- PRESERVE SPECIFICS. Carry numbers, names, decisions, measurements,',
  '  metrics, and dates across exactly as given - never round, alter,',
  '  or invent them. Incorporate them into the prose; do not quote.',
  '- HEDGE INFERENCE. When you connect a memory to the present or draw',
  '  a conclusion, use tentative voice ("if that still holds...", "this',
  '  might be why..."), not flat assertion.',
  '- RESPECT CONFIDENCE. A memory tagged "hedged" or "shaky" is a',
  '  low-confidence recollection. Surface it as uncertain ("I have a',
  '  vague sense that...", "I might be misremembering, but...") or',
  '  offer to verify, rather than stating it as established fact.',
  '- CITE. Mark each recalled claim with a ^N^ superscript naming the',
  '  numbered source it came from (e.g. "...increased it by 50g ^2^").',
  '  Cite the specific source a fact came from; do not cite sources you',
  '  did not use.',
  '- BE BRIEF. A few sentences, one integrated paragraph - not a list,',
  '  not an essay. No preamble and no sign-off: output only the',
  '  recollection itself.',
  '- If, on reflection, none of the retrieved memory is genuinely',
  '  relevant to the current exchange, output nothing at all - UNLESS',
  '  a follow-up marked "due" is present (see below), which is always',
  '  worth surfacing on its own.',
  '',
  'Follow-up rules (apply only when OPEN FOLLOW-UPS are present):',
  '- THE OUTCOME IS UNKNOWN. Each follow-up is a question whose answer',
  '  you do not have. Never state, imply, or guess how it went - the',
  '  recollection says plainly that you do not yet know ("I remember',
  '  they were planning X; I don\'t know how it turned out").',
  '- "upcoming" means the event has not happened yet. Frame it as a',
  '  plan still ahead, never as something done.',
  '- "due" means you have been meaning to ask. Fold in a gentle',
  '  intention to raise it when there is a natural moment - an',
  '  inclination, not an order; a heavy or urgent current topic',
  '  outranks it.',
  '- Follow-ups have no citation numbers; weave them in uncited.',
  '',
  'Stay domain-agnostic. The subject could be anything; the contract is',
  'the same.',
].join('\n');

/** One gathered source, assigned a stable 1-based citation number. */
interface NumberedRecallSource {
  index: number;
  kind: 'memory' | 'conversation' | 'wiki';
  id: string;
  /** Memory label, conversation title, or wiki title. */
  label: string;
  /** Memory body (rides inline); null for ref-only conversation / wiki. */
  body: string | null;
  /** Memory's recorded date as YYYY-MM-DD; null when unparseable / ref. */
  recordedDate: string | null;
  /** Qualitative confidence tag for memories (hedged / shaky surface a
   *  low-confidence recollection the model should qualify); null for
   *  corroborated / neutral memories and for conversation / wiki refs. */
  confidenceTag: string | null;
}

/**
 * Number the gathered index into a flat source list: memories first
 * (they ride inline with their recorded date), then conversation refs,
 * then wiki refs. The numbering is what the `^N^` superscripts and the
 * citation rows both key on, so it must be assigned once and shared.
 */
function numberRecallSources(index: ContextIndex): NumberedRecallSource[] {
  const out: NumberedRecallSource[] = [];
  let n = 1;
  for (const m of index.memories) {
    out.push({
      index: n++,
      kind: 'memory',
      id: m.id,
      label: m.label,
      body: m.data,
      recordedDate: formatRecordedDate(m.created_at),
      confidenceTag: m.confidence_tag,
    });
  }
  for (const c of index.conversations) {
    out.push({ index: n++, kind: 'conversation', id: c.id, label: c.title, body: null, recordedDate: null, confidenceTag: null });
  }
  for (const w of index.wiki) {
    out.push({ index: n++, kind: 'wiki', id: w.id, label: w.title, body: null, recordedDate: null, confidenceTag: null });
  }
  return out;
}

/** Project numbered sources into the persisted citation rows. */
function citationsFromSources(
  sources: readonly NumberedRecallSource[],
): ContextRecallCitation[] {
  return sources.map((s) => ({
    index: s.index,
    kind: s.kind,
    id: s.id,
    label: s.label,
  }));
}

/**
 * Render the numbered source block the smoothing model reads. Memories
 * show their recorded date inline so the model can anchor temporally;
 * conversations and wiki ride as titled leads (their bodies aren't
 * gathered - the model references them, it doesn't quote them).
 */
function renderRecallSourceBlock(
  sources: readonly NumberedRecallSource[],
): string {
  return sources
    .map((s) => {
      if (s.kind === 'memory') {
        const when = s.recordedDate ? `, recorded ${s.recordedDate}` : '';
        // Only hedged / shaky get an inline flag; corroborated / neutral
        // read as plain facts (matches classifyMemoryConfidence's bands).
        const tag =
          s.confidenceTag === 'hedged' || s.confidenceTag === 'shaky'
            ? `, ${s.confidenceTag}`
            : '';
        return `[${s.index}] (memory${when}${tag}) ${s.label}: ${s.body ?? ''}`;
      }
      if (s.kind === 'conversation') {
        return `[${s.index}] (prior conversation) ${s.label}`;
      }
      return `[${s.index}] (wiki article) ${s.label}`;
    })
    .join('\n');
}

/**
 * Render the follow-ups block. Separate from the numbered source list
 * on purpose: follow-ups carry no citations (there is no drill-down
 * tool behind them - question and context ride verbatim), and their
 * state labels ("due" / "upcoming" / "outcome unknown") are computed
 * by the gather, never inferred by the model.
 */
function renderFollowupBlock(
  followups: readonly ContextIndexFollowup[],
): string {
  return followups
    .map((f) => {
      const flag =
        f.state === 'upcoming'
          ? 'upcoming - has not happened yet'
          : f.proactive
            ? 'due - you have been meaning to ask'
            : 'outcome unknown';
      const context = f.context.trim().length > 0 ? ` (${f.context})` : '';
      return `- [${flag}] ${f.question}${context}`;
    })
    .join('\n');
}

/** Pull the 1-based indices referenced by `^N^` superscripts in a note. */
function extractCitedIndices(note: string): Set<number> {
  const out = new Set<number>();
  for (const m of note.matchAll(/\^(\d+)\^/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

// Format an ISO timestamptz into YYYY-MM-DD for temporal anchoring.
// Returns null on an unparseable value so the caller omits the date
// rather than emitting "Invalid Date". (new Date(string) is fine in
// edge code - the Date ban applies only to workflow scripts.)
function formatRecordedDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

export interface SmoothContextRecallOptions {
  index: ContextIndex;
  /** The current exchange (last user turn + the assistant turn before
   *  it), the relevance-bridge anchor. */
  recentExchange: string;
  apiKey: string;
  log: EdgeLogger;
}

export interface SmoothedRecall {
  note: string;
  citations: ContextRecallCitation[];
}

/**
 * Run the smoothing pass. Returns the recollection note (with `^N^`
 * markers) plus the citations those markers resolve to. An empty note
 * (model judged nothing relevant) comes back with no citations - the
 * caller caches that as the negative result. Throws on a Venice
 * failure; the pipeline's caller catches and leaves the prior cache.
 */
export async function smoothContextRecall(
  opts: SmoothContextRecallOptions,
): Promise<SmoothedRecall> {
  const sources = numberRecallSources(opts.index);
  const followups = opts.index.followups;
  if (sources.length === 0 && followups.length === 0) {
    return { note: '', citations: [] };
  }

  const startedAt = Date.now();
  const parts = [
    'THE CURRENT EXCHANGE (what is being discussed right now):',
    opts.recentExchange.trim().length > 0
      ? opts.recentExchange.trim()
      : '(no user message yet)',
  ];
  if (sources.length > 0) {
    parts.push(
      '',
      'RETRIEVED MEMORY (numbered sources to draw on):',
      renderRecallSourceBlock(sources),
    );
  }
  if (followups.length > 0) {
    parts.push(
      '',
      'OPEN FOLLOW-UPS (questions you saved to ask this user later; you',
      'do NOT know the outcomes):',
      renderFollowupBlock(followups),
    );
  }
  parts.push(
    '',
    followups.some((f) => f.proactive)
      ? 'Write the recollection now. A "due" follow-up is always worth ' +
          'surfacing, even if nothing else is relevant.'
      : 'Write the recollection now, or output nothing if none of it is relevant.',
  );
  const userMessage = parts.join('\n');

  const result = await toolComplete({
    apiKey: opts.apiKey,
    model: SMOOTHING_MODEL,
    messages: [
      { role: 'system', content: SMOOTHING_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    disableThinking: true,
    maxTokens: SMOOTHING_MAX_TOKENS,
  });

  const note = result.text.trim();
  if (note.length === 0) {
    opts.log.debug('context-recall smoothing returned empty (nothing relevant)', {
      sourceCount: sources.length,
      elapsedMs: Date.now() - startedAt,
    });
    return { note: '', citations: [] };
  }

  // Keep only the citations the note actually referenced - a source the
  // model didn't weave in shouldn't surface as a dangling provenance row.
  const cited = extractCitedIndices(note);
  const citations = citationsFromSources(sources).filter((c) => cited.has(c.index));

  opts.log.debug('context-recall smoothing complete', {
    sourceCount: sources.length,
    citedCount: citations.length,
    noteLength: note.length,
    elapsedMs: Date.now() - startedAt,
  });
  return { note, citations };
}

// Test-only surface. The numbering / render / citation-projection /
// marker-extraction helpers are internal to smoothContextRecall; they're
// exposed here (not as production exports) so the deterministic logic can
// be pinned without a live Venice call. Same pattern as reflection.ts.
export const __test = {
  numberRecallSources,
  citationsFromSources,
  renderRecallSourceBlock,
  renderFollowupBlock,
  extractCitedIndices,
};

// Wiki librarian (function-side, all three trigger paths).
//
// The librarian reads the wiki as a whole and makes it more coherent:
// deleting out-of-scope articles, consolidating duplicates,
// fact-checking against conversation history, fixing references to
// the user, and (last) asking the from-scratch organisation question.
// It never creates articles - new subjects flow from the per-
// conversation wiki agent (agents/wiki.ts) or the user directly.
//
// Three entry points, ONE prompt builder, ONE toolbox:
//
//   - runWikiLibrarianSweepTick: the scheduled path. pg_cron fires
//     nak_trigger_wiki_librarian_sweep() hourly -> POST
//     /wiki-librarian-sweep with the service-role bearer. The route
//     calls this; it claims the most-overdue eligible user
//     (claim_next_user_for_wiki_librarian - a global SECURITY DEFINER
//     claim that stamps profiles.wiki_librarian_last_run_at, enforcing
//     the 12h minimum interval and the Settings toggle) and runs the
//     standard five-step review for them. One user per tick.
//   - runWikiLibrarianManual: the Wiki panel's sparkles button. POST
//     /wiki-librarian-run with the user's JWT and optional custom
//     instructions. Does NOT touch the cadence stamp - manual runs
//     never reset the scheduled clock. Live step events flow through
//     the onProgress hook (the route publishes them to the user's
//     agent-runs Broadcast channel).
//   - the `wiki_librarian` ToolDef: the main chat delegates wiki
//     maintenance through this registered tool. Always the
//     custom-instructions variant.
//
// Mutual exclusion across the three paths is the per-user in-flight
// guard (claim_wiki_librarian_inflight / release_wiki_librarian_
// inflight in supabase/schema.sql): an atomic holder+TTL pair so two
// runs never edit the wiki concurrently. The TTL releases a guard a
// crashed run left behind.
//
// The write tools are the REGISTERED wiki_update / wiki_delete ports
// (tools/wiki_update.ts, tools/wiki_delete.ts) - not private copies.
// An earlier shape inlined its own implementations here and their
// validation caps silently drifted from the real limits; sharing the
// registered execute()s is what keeps librarian writes byte-identical
// to every other writer. One deliberate context tweak: the write
// tools see a BLANKED threadId so a delegating chat thread is never
// auto-attached as an article source - the librarian attributes only
// via model-supplied source_thread_ids, on every path.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger, type EdgeLogger } from '../../_shared/edge-log.ts';
import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { wikiSearch } from '../tools/wiki_search.ts';
import { conversationSearch } from '../tools/conversation_search.ts';
import { conversationGet } from '../tools/conversation_get.ts';
import { memorySearch } from '../tools/memory_search.ts';
import { wikiUpdate } from '../tools/wiki_update.ts';
import { wikiDelete } from '../tools/wiki_delete.ts';
import { recordList } from '../tools/record_list.ts';
import { recordCreate } from '../tools/record_create.ts';
import { recordUpdate } from '../tools/record_update.ts';
import { recordDelete } from '../tools/record_delete.ts';
import { recordLinkCreate } from '../tools/record_link_create.ts';
import { recordLinkDelete } from '../tools/record_link_delete.ts';
import { asAgentTool } from './_agent_tools.ts';
import { appendWikiAgentLog } from './_wiki_agent_log.ts';
import {
  runHeadlessAgent,
  type AgentProgressEvent,
  type AgentTool,
  type AgentToolContext,
  type Toolbox,
  withProgressNarration,
} from './_run.ts';

// Mirror of agentModel('wikiLibrarian').id in src/lib/models/index.ts
// (static role->model map, not a configurable tier).
const WIKI_LIBRARIAN_MODEL = 'deepseek-v4-flash';

// Mirror of the browser librarian's knobs: 400-char excerpts keep a
// hundred-article prompt inside the window; wikis below 3 articles
// have nothing to consolidate; 12h is the scheduled cadence the claim
// RPC enforces.
const LIBRARIAN_EXCERPT_CHARS = 400;
const LIBRARIAN_MIN_ARTICLES = 3;
const LIBRARIAN_MIN_INTERVAL_SECONDS = 12 * 3600;

// In-flight guard TTL. A librarian run is a multi-round tool loop -
// minutes, not seconds - so the TTL is generous; its only job is to
// unwedge the guard after a crashed run.
const LIBRARIAN_INFLIGHT_TTL_SECONDS = 600;

// Article-list fetch cap, matching the browser loop's
// listWikiArticles({ limit: 500 }) - a wiki past 500 articles would
// overflow the prompt anyway.
const LIBRARIAN_ARTICLE_LIMIT = 500;

// ---------------------------------------------------------------------------
// Wire schemas. The librarian's tool descriptions differ from the
// autonomous wiki agent's (same executes, different usage guidance -
// e.g. wiki_update here leads with consolidation and fact-correction,
// and conversation_search is framed as the corroboration tool), so
// they live here rather than in _agent_tools.ts.
// ---------------------------------------------------------------------------

const WIKI_SEARCH_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'wiki_search',
    description:
      "Semantic search over the user's wiki - encyclopedic articles " +
      'about projects, people, places, and topics in their life. ' +
      'Returns matching articles with their full body inlined.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language query.' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
};

const CONVERSATION_SEARCH_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'conversation_search',
    description:
      "Cosine-similarity search over the user's prior threads. " +
      'Use to verify a claim or find context informing an article.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language query.' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
};

const CONVERSATION_GET_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'conversation_get',
    description:
      'Read the actual turns of one prior conversation by id (use a ' +
      'conversation_search hit to get the id). Returns {found, ' +
      'conversation: {title, summary, truncated, messages: [{role, ' +
      'content}]}}. conversation_search returns only a topic summary; ' +
      'THIS shows who said what, so it is the tool for checking whether ' +
      'a claim in an article was originated by the user or merely ' +
      "explained by the assistant. Long threads are windowed to the " +
      'most recent messages (truncated: true); the summary covers the ' +
      'earlier part.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'UUID of the thread (from conversation_search).',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
};

const MEMORY_SEARCH_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'memory_search',
    description:
      "Semantic search over the user's saved memories. Use as a " +
      'second corroboration source for fact-checking.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
};

const WIKI_UPDATE_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'wiki_update',
    description:
      'Rewrite an existing wiki article in place. Either `title` or ' +
      '`content` (or both) must be supplied. Every call requires a ' +
      '`message` (changelog summary, max 200 chars). Optionally pass ' +
      '`source_thread_ids` (an array of thread ids from your most ' +
      'recent conversation_search results) to attribute the update.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Article id to update.' },
        message: {
          type: 'string',
          description:
            'Imperative-voice changelog summary. Treat like a git ' +
            'commit message.',
        },
        title: { type: 'string', description: 'New title (optional).' },
        content: { type: 'string', description: 'New content (optional).' },
        source_thread_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Thread ids from conversation_search results that informed ' +
            'this update; validated server-side and silently dropped if ' +
            'they do not belong to the user.',
        },
      },
      required: ['id', 'message'],
      additionalProperties: false,
    },
  },
};

const WIKI_DELETE_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'wiki_delete',
    description:
      'Hard-delete a wiki article. Use only for consolidation (you ' +
      'just merged its content into another article) or out-of-scope ' +
      'cleanup. Every call requires a `message` (changelog summary, ' +
      'max 200 chars).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Article id to delete.' },
        message: {
          type: 'string',
          description: 'Imperative-voice changelog summary.',
        },
      },
      required: ['id', 'message'],
      additionalProperties: false,
    },
  },
};

// Record tools. The librarian reads an article's records (the topic's
// journey) to decide what durable learnings belong in the body, and may
// clean up the records themselves: merge duplicates, fix outdated ones,
// delete the irrelevant. It does NOT delete a record merely because it
// promoted that record's learning into the article body - records are
// historical documentation and survive promotion.
const RECORD_LIST_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'record_list',
    description:
      "List a wiki article's dated records (the topic's journey). Returns " +
      '{records: [{id, date, content, tags, created_at}]}. Use it to find ' +
      'durable learnings to fold into the article body, and to spot ' +
      'duplicate or outdated records worth cleaning up.',
    parameters: {
      type: 'object',
      properties: {
        article_id: { type: 'string', description: 'Article id whose records to list.' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['article_id'],
      additionalProperties: false,
    },
  },
};

// record_create is scoped to MIGRATION: moving a dated entry that is
// baked into an article BODY out into a record so the body can become
// clean current-state prose. Like the worker, the librarian must
// record_list first and skip events that are already records - the
// extraction agent or the user may have logged them.
const RECORD_CREATE_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'record_create',
    description:
      'Migrate one dated entry out of an article body into a record. ' +
      'article_id is the article; date is the entry\'s ISO "YYYY-MM-DD" day; ' +
      'content is the entry text (Markdown). Use ONLY to relocate dated ' +
      'history already written in a body. ALWAYS record_list first: if the ' +
      'event is already a record, do not duplicate it. After the record ' +
      'exists, trim the line from the body.',
    parameters: {
      type: 'object',
      properties: {
        article_id: { type: 'string', description: 'Article the record belongs to.' },
        date: { type: 'string', description: 'ISO "YYYY-MM-DD" date of the entry.' },
        content: { type: 'string', minLength: 1, description: 'The dated entry text, Markdown.' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['article_id', 'date', 'content'],
      additionalProperties: false,
    },
  },
};

const RECORD_UPDATE_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'record_update',
    description:
      "Edit a record's date, content, or tags. Use to correct an outdated " +
      'record or merge a duplicate\'s detail into the one you keep. Pass id ' +
      'and any subset of date, content, tags (tags replaces the whole array).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Record id to edit.' },
        date: { type: 'string', description: 'New ISO "YYYY-MM-DD" date.' },
        content: { type: 'string', description: 'New Markdown body.' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
};

const RECORD_DELETE_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'record_delete',
    description:
      'Delete a record. Use ONLY for a true duplicate or a clearly ' +
      'irrelevant entry. NEVER delete a record just because you promoted ' +
      'its learning into the article body - records are historical ' +
      'documentation and must survive promotion.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Record id to delete.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
};

// Mirror of MAX_RECORD_LINK_LABEL_CHARS in src/lib/wiki.ts.
const MAX_RECORD_LINK_LABEL_CHARS = 120;

// record_link_create lets the librarian wire up continuation chains it
// finds during the wiki-wide pass - records that are revisions of or based
// on one another but were never linked. Directed; conservative.
const RECORD_LINK_CREATE_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'record_link_create',
    description:
      'Link one record to another with a short relationship label. ' +
      'DIRECTED (from -> to): link the newer/derived record to the prior ' +
      'one it builds on. Use when you find records of an article that form ' +
      'an explicit chain (one is a revision of, supersedes, or is based on ' +
      'another) but are not yet linked. Get both ids from record_list. ' +
      'Re-linking a pair updates the label. Never invent a relationship the ' +
      'records do not actually state.',
    parameters: {
      type: 'object',
      properties: {
        from_record_id: { type: 'string', description: 'Newer/derived record id.' },
        to_record_id: { type: 'string', description: 'Prior record id it builds on.' },
        label: {
          type: 'string',
          maxLength: MAX_RECORD_LINK_LABEL_CHARS,
          description: 'Short relationship label ("based on", "supersedes", "revision of").',
        },
      },
      required: ['from_record_id', 'to_record_id'],
      additionalProperties: false,
    },
  },
};

const RECORD_LINK_DELETE_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'record_link_delete',
    description:
      'Remove a directed cross-link between two records. Use to prune a ' +
      'link that is now wrong or redundant (e.g. it points at a record you ' +
      'just merged away, or duplicates the relationship in the other ' +
      'direction). Direction matters: removes the (from -> to) edge only.',
    parameters: {
      type: 'object',
      properties: {
        from_record_id: { type: 'string', description: 'Source record id of the edge.' },
        to_record_id: { type: 'string', description: 'Target record id of the edge.' },
      },
      required: ['from_record_id', 'to_record_id'],
      additionalProperties: false,
    },
  },
};

/**
 * Like asAgentTool, but blanks the context's threadId before the
 * registered execute() sees it. The registered wiki write tools
 * auto-attach a non-empty ctx.threadId to the article's bibliography
 * (correct for the per-conversation agent, which processes exactly
 * that thread); the librarian's delegating chat thread is NOT a
 * content source, so the librarian attributes only through the
 * model-supplied source_thread_ids parameter - on every path.
 */
function asAgentToolNoThread(tool: ToolDef, wire: AgentTool['wire']): AgentTool {
  return {
    name: tool.name,
    wire,
    execute: (args, agentCtx) =>
      tool.execute(args, {
        adminClient: agentCtx.adminClient,
        userId: agentCtx.userId,
        threadId: null,
        signal: agentCtx.signal,
        depth: agentCtx.depth,
      }),
  };
}

function buildLibrarianToolbox(): Toolbox {
  return {
    name: 'wikiLibrarian',
    tools: [
      asAgentTool(wikiSearch, WIKI_SEARCH_WIRE_SCHEMA),
      asAgentTool(conversationSearch, CONVERSATION_SEARCH_WIRE_SCHEMA),
      asAgentTool(conversationGet, CONVERSATION_GET_WIRE_SCHEMA),
      asAgentTool(memorySearch, MEMORY_SEARCH_WIRE_SCHEMA),
      asAgentTool(recordList, RECORD_LIST_WIRE_SCHEMA),
      asAgentToolNoThread(wikiUpdate, WIKI_UPDATE_WIRE_SCHEMA),
      asAgentToolNoThread(wikiDelete, WIKI_DELETE_WIRE_SCHEMA),
      asAgentToolNoThread(recordCreate, RECORD_CREATE_WIRE_SCHEMA),
      asAgentToolNoThread(recordUpdate, RECORD_UPDATE_WIRE_SCHEMA),
      asAgentToolNoThread(recordDelete, RECORD_DELETE_WIRE_SCHEMA),
      asAgentToolNoThread(recordLinkCreate, RECORD_LINK_CREATE_WIRE_SCHEMA),
      asAgentToolNoThread(recordLinkDelete, RECORD_LINK_DELETE_WIRE_SCHEMA),
    ],
  };
}

// ---------------------------------------------------------------------------
// Prompt. Ported from src/lib/agents/wiki-librarian/prompt.ts -
// the standard five-step sweep body, the custom-instructions variant,
// and the librarian's own profile block (which carries CORRECTIVE
// wording on top of the per-conversation agent's anti-fabrication
// rules: the librarian fixes wrong names already on disk). The one
// parameterisation: the intro names the surface the run came from
// ("the Wiki panel" vs "the main chat") so each path keeps the
// wording it always had.
// ---------------------------------------------------------------------------

export interface WikiLibrarianUserProfile {
  name: string | null;
  location: string | null;
}

function renderUserProfileBlock(
  profile: WikiLibrarianUserProfile | null,
): string {
  if (!profile) return '';
  const name =
    profile.name && profile.name.trim().length > 0 ? profile.name.trim() : null;
  const location =
    profile.location && profile.location.trim().length > 0
      ? profile.location.trim()
      : null;
  if (!name && !location) return '';
  const lines: string[] = ['**About the user:**', ''];
  if (name) {
    lines.push(`The user's name is **${name}**.`);
    lines.push(
      `**Use "${name}" by default when an article refers to the user.** ` +
        `Avoid the generic phrase "the user" wherever "${name}" fits. ` +
        `If you find an existing article that defaults to "the user" ` +
        `where the name would fit naturally (e.g. "the user is ` +
        `building Nak" instead of "${name} is building Nak"), ` +
        `wiki_update to replace the generic phrasing with the name. ` +
        `A natural pronoun ("they", "their") is also fine where the ` +
        `prose flows better than repeating the name.`,
    );
    lines.push(
      `The name is **${name}** and ONLY ${name}. NEVER substitute ` +
        `another name for the user, even if other names appear in ` +
        `the article or in conversation history - those names belong ` +
        `to other people the user knows. If you find an article that ` +
        `appears to be about the user but uses a name OTHER than ` +
        `${name} (a per-conversation agent hallucination is the ` +
        `usual cause), wiki_update it to replace the wrong name with ` +
        `${name} or a natural pronoun.`,
    );
  } else {
    lines.push(
      'The user has not supplied a name in Settings. When an article ' +
        'refers to the user themselves, the right rendering is a ' +
        'natural pronoun ("they") or the phrase "the user". ' +
        'If you find an article that appears to be about the user ' +
        'but uses an invented name, wiki_update to replace the ' +
        'name with a pronoun.',
    );
  }
  if (location) {
    lines.push(`Their location is ${location}.`);
  }
  return lines.join('\n');
}

const WIKI_LIBRARIAN_TOOLS_BLOCK = `**Tools you can use**:

- \`wiki_search\` - read the full body of any article (search by
  title, topic, or natural query).
- \`conversation_search\` - find the user's past conversations
  by topic. Returns title + a topic summary per hit, NOT the
  turns - use it to locate the thread you want, then open it
  with conversation_get. Use this when an article makes a
  specific factual assertion you want to corroborate, or when
  you suspect two articles cover the same conversation thread
  under different titles.
- \`conversation_get\` - read the actual turns of one thread by
  id (from a conversation_search hit). conversation_search only
  gives you a topic summary; conversation_get shows who said
  what, so it is the tool for checking whether a claim came from
  the USER or was merely explained by the assistant. Long
  threads are windowed to the most recent messages.
- \`memory_search\` - read the user's atomic-fact memory store
  (the same store the chat-side memory_search hits). Useful as
  a second corroboration source for fact-checking - if an
  article says "Maya works at Foo" and memory_search returns a
  memory "Maya works at Bar", that's a contradiction worth
  resolving. Read-only here; the librarian does not write to
  memory.
- \`wiki_update\` - rewrite an article in place. Preserve facts
  that are still accurate; integrate facts from a duplicate
  article you intend to delete; correct stale information you
  verified is contradicted by recent conversations.
- \`wiki_delete\` - hard-delete an article. Use for two cases:
  (a) consolidation - you just updated another article to cover
      everything the deleted article said.
  (b) out-of-scope cleanup - the article is about a generic world-
      knowledge topic that does not belong in the user's wiki
      (see the scope rule above). For these, no merge is required;
      the article should not exist at all.
  Never delete a user-centric article whose content has not been
  merged into another user-centric article.

**Every \`wiki_update\` and \`wiki_delete\` call requires a
\`message\` parameter.** Treat it like a git commit summary: one
imperative-voice line under ~200 chars naming WHAT this edit does
and WHY ("Merge sister-Maya article into household; absorbed her
move-to-Seattle paragraph", "Delete Kermit protocol as out-of-
scope", "Replace 'the user' with 'Jeff' across the Nak article").
These messages land in the user's wiki changelog, which is the
audit surface they use to understand what the librarian has been
doing - one line per individual edit, complementing the run-level
final reply below.

**Source attribution.** When you wiki_update an article after
consulting \`conversation_search\` results, pass the relevant
thread ids in the \`source_thread_ids\` parameter. Each id you
pass shows up in the article's bibliography (the "Sources"
section beneath the article body) so the user can trace which
conversations contributed to the article over time. Use only
thread ids that came back from \`conversation_search\` results
this cycle - the tool validates each id against the threads
table and silently drops anything that does not exist, so a
mis-typed id is harmless but a hallucinated one accomplishes
nothing. Pass only the threads whose content actually informed
the update; do not over-attribute by dumping every search hit.
Skip \`source_thread_ids\` entirely for updates that did not draw
on any conversation (a pure scope-cleanup, name-fix, or
consolidation where the merged article already carries the
facts).

**You DO NOT have wiki_create.** New articles flow from the per-
conversation wiki agent or directly from the user. Your job is
to organise what exists; if you think a topic deserves an
article that is not currently there, leave it alone - the per-
conversation agent will land it the next time the topic comes
up.`;

const WIKI_LIBRARIAN_DISCIPLINE_BLOCK = `**Discipline**:

- Be conservative. If you are not sure two articles overlap
  enough to merge, leave them alone. False merges destroy
  information; missed merges just leave a small redundancy.
- Preserve facts. When you wiki_update an article to absorb
  another, every concrete fact from the absorbed article must
  appear in the merged result unless you are confident it is
  wrong (and conversation_search corroborates the contradiction).
- Preserve dates - don't discard them, relocate them. Articles
  carry month + year date markers ("as of March 2026", "in late
  2025") that anchor when each fact was added. When you wiki_update
  for any reason - consolidation, fact-correction, name-fix,
  scope-cleanup link-in - do not drop a dated line from the body.
  If you are reducing a body to current-state prose, the dated
  entries must first be migrated into records (step 7b); only then
  may a dated line leave the body. A current-state body still
  carries ONE freshness date anchor ("As of November 2026, ...");
  any new statement you add during a librarian update carries a
  fresh marker too.
- Do not fabricate. Only assert facts that appear in the
  existing articles, in conversations you searched, or in the
  excerpts above. Do not import outside knowledge.
- Attribute to the right speaker when you corroborate against
  conversations. In a thread the user's turns are the user's own
  claims; the assistant's turns are AI output. A claim is
  confirmed only when the USER stated or accepted it - an
  assistant having explained or suggested something in a past
  conversation is not evidence the user believes, learned, or
  adopted it, and is not grounds to "correct" an article toward
  it.
- Same voice and tone the wiki uses already: encyclopedic,
  third-person, present tense, neutral. Refer to subjects
  directly (a first name, the project name) rather than "the
  user".`;

const WIKI_LIBRARIAN_FINAL_REPLY_BLOCK = `**Final reply: one or two sentences explaining your choices.**
After your last tool call (or instead of any tool call, if you
decided the wiki was already coherent), reply with a brief
operator-facing summary of what you did and WHY. This text
surfaces in the user's log drawer as the cycle's outcome, so make
it useful to a human skimming the log - name the articles you
merged or deleted, and name the cases you considered but left
alone. The "considered but left alone" half is as valuable as the
"changed it" half: if two articles looked like duplicates but you
decided they cover different subjects, say so. Examples:
  "Deleted 'Kermit protocol' as out-of-scope; merged the two
   'Maya' articles into one (the household one absorbed the
   sister article)."
  "Left 'Maya' and 'household' separate - they overlap on the
   household-finances paragraph but cover different subjects, and
   merging would make either article harder to find."
  "No edits - wiki is small and coherent."
Skip filler ("Great work!", "I have finished"); lead with the
decisions. Keep it under two sentences. Plain text, no Markdown.
Zero edits is a normal outcome on a small or already-coherent
wiki - say so plainly.`;

const WIKI_LIBRARIAN_BODY = `
**Scope: this wiki is about the user, not the world.** Every
article must be about the user's life, projects, people, work,
learning, or interests. Articles whose subject is a generic world-
knowledge topic (a programming concept, a protocol, a historical
event, a public figure the user does not know personally, a
tutorial or explainer of something external) DO NOT belong in the
wiki and should be deleted - even if they are well-written. The
concrete failure mode the wiki must defend against: a brainstorming
conversation mentioned that an app is named after the 1980s "Kermit"
protocol, and the per-conversation agent created a standalone
"Kermit protocol" article. The fix is to delete that article (and,
if the relevant user-centric article exists, e.g. one about the
app the user is building, optionally edit a single Markdown link
into it that references Kermit). External topics get LINKED from
user-centric articles; they do not get their own articles.

${WIKI_LIBRARIAN_TOOLS_BLOCK}

**Workflow**:

1. **Scan for out-of-scope articles first, and lean HARD toward
   delete when the article is not user-centric.** A genuinely
   user-centric article reads as "about the user / their X" from
   the title alone. If you have to read the full body to convince
   yourself an article is about the user, the article is
   probably out of scope.

   **Delete-on-sight categories** (high-confidence out-of-scope -
   confirm with one wiki_search read of the body, then delete
   without further hedging):
   - Generic technical concepts: "Kermit protocol", "JavaScript
     closures", "HTTP semantics", "regex", "TLS handshake".
     These are Wikipedia topics. The wiki is not Wikipedia.
   - World-knowledge encyclopedia topics: historical events,
     scientific concepts, biology, chemistry, geography.
   - Public figures the user does not personally know: famous
     authors, celebrities, historical figures. ("Henson
     Associates", "Linus Torvalds", "Marie Curie".)
   - Generic tutorials, debug-session writeups, news summaries.

   Apply the **sterility test**: "if I delete every reference to
   the user from this article, what is left?" If what is left is
   a self-contained Wikipedia-style entry on a generic topic,
   the article is sterile of user information - delete it.

   When you delete an out-of-scope article that has a related
   user-centric article (e.g. you are deleting "Kermit (protocol)"
   and there IS an article about the app the user is building,
   whose name references Kermit), wiki_update the user-centric
   article first to add a short Markdown link to a public
   reference (Wikipedia conventionally) so the connection is
   preserved. If no related user-centric article exists, just
   delete - the per-conversation agent will land the user-centric
   article on its own next cycle if the topic is genuinely
   article-worthy.

   The cost of deleting an article that turned out to be
   borderline-on-scope is low: the per-conversation agent will
   re-create it on the next relevant conversation. The cost of
   leaving an out-of-scope article alone is high: it pollutes
   the user-centric wiki and the user has to clean it up by
   hand. Lean toward delete.
2. **Scan the list for duplicates and near-duplicates.** Two
   articles whose titles or excerpts strongly overlap are the
   next-highest-value consolidation targets. Use wiki_search to
   read full bodies before deciding. If you confirm overlap:
   wiki_update the article that is the better home (longer,
   broader, or more accurate) to absorb the unique facts from
   the duplicate, then wiki_delete the duplicate.
3. **Fix references to the user.** Three failure patterns to clean
   up here:

   (a) **Fabricated names.** If the "About the user" block has a
       name (e.g. "Jeff"), scan for articles that appear to be
       about the user but use a DIFFERENT name. The usual cause
       is the per-conversation agent grabbing a friend's name
       from conversation context and applying it to the user.
       Read the full body to confirm the article is in fact
       about the user, then wiki_update to replace the wrong
       name with the configured one. Use memory_search and
       conversation_search to disambiguate - if a name like
       "Elliot" appears in memories as someone the user knows,
       the article that calls the user "Elliot" is wrong; the
       separate Elliot article (about the actual friend) is
       out of your scope to create (no wiki_create), but you
       CAN wiki_update the misnamed article to use the right
       name and leave the per-conversation agent to land the
       Elliot article on its own next cycle.

   (b) **Defaulted to "the user".** If the configured name is
       set, scan for articles that say "the user" where the
       name would fit naturally ("the user is building Nak",
       "the user lives in...", "the user has been learning..."),
       and wiki_update to substitute the configured name. The
       wiki should read like a personal encyclopedia about the
       person, not a generic third-party report. Skip cases
       where "the user" is genuinely the better wording (rare,
       but possible) - default to substituting the name.

   (c) **Assistant-sourced claims attributed to the user.** A
       previous per-conversation pass may have folded something
       the ASSISTANT said in a thread - an explanation it gave,
       an approach it proposed, options it laid out - into the
       article as though the user stated, learned, or adopted
       it. Watch for article facts that read more like advice or
       exposition than like something the user would say about
       themselves ("the user should...", a how-to paragraph, a
       definition of a concept the user was merely asking
       about). When one looks suspect, conversation_search to
       find the thread it came from, then conversation_get to
       read the actual turns and see who originated it - the
       search summary alone will not tell you, only the turns
       will. Correct by what you find. If the user only received
       the information and never confirmed, acted on, or claimed
       it, wiki_update to re-attribute it accurately or drop it.
       If the user DID take it up - adopted the approach, acted
       on it, asked to save it - keep it, but frame the
       provenance ("Jeff saved a recommended reading list", not
       "Jeff concluded ...") so the article does not read the
       assistant's contribution as the user's own origination.
       Leave it alone when you cannot read the source turns or
       they do not corroborate the misattribution; a confident
       wrong "correction" is worse than a borderline line left
       standing.
4. **Check for stale facts using date markers.** Articles are
   written with date markers attached to facts ("as of March
   2026", "in late 2025", "Jeff started this in early 2026").
   These are the freshness signal you use to decide what to
   re-check.
   - When an excerpt makes a specific claim with an OLD date
     marker that could plausibly have changed (a job title, a
     relationship status, a project status), use
     conversation_search to find more recent threads, then
     conversation_get to read what was actually said. If you
     find a clear contradiction in newer conversations,
     wiki_update the body to the NEW current state ("As of
     November 2026, Maya is at Bar"). The superseded value is
     not lost: the prior state lives in the records (and the
     change itself may already be a record), so the body holds
     where things stand now, not a running "was X, now Y" log.
   - When an excerpt makes a specific claim with NO date marker,
     use conversation_search to find when the fact was last
     mentioned and consider wiki_update to retrofit a date
     marker so future librarian passes have a freshness anchor.
   - When you find no contradiction and no recent mention,
     leave the article alone - undated or old-dated facts
     without contradiction are just current state, not stale.
   - Never strip a dated entry from the body without first
     migrating it into a record (step 7b) - relocate, don't
     discard.
5. **Tighten subject boundaries.** When two articles cover
   adjacent topics that confusingly bleed into each other (a
   "Maya" article and a "household" article that both cover
   the same person), decide which article is the right home
   for which facts and wiki_update both to clarify the split.
   Do not delete in this case - both articles still have a
   reason to exist; you just made the boundary cleaner.
6. **Step back and ask the from-scratch question.** The
   previous steps were local - per-article scope, pair-wise
   duplicates, individual fact freshness, neighbouring
   boundary. This step is global, and runs LAST so the
   organisation question is asked after the local passes
   have stabilised what each article actually contains.

   The failure mode this step exists to catch: the per-
   conversation agent picks an article's title from the first
   conversation that introduced the subject, and that title
   stays even after dozens of later conversations have
   broadened the body well past the original framing. It does
   the same with content ordering - what was "the latest
   thing the user mentioned" becomes the article's lead
   paragraph and stays there as the lead even when later
   updates would naturally be a postscript. The per-conv
   agent has no wiki-wide vantage; it sees one article at a
   time and an instruction to "rename only on explicit user
   request". That instruction is correct for its scope and
   wrong for yours. Titles and orderings that read as
   reasonable conversation-by-conversation can read as
   strange when the wiki is viewed as a whole.

   How to run this step:

   (a) **Distil the master list of subjects.** Read the
       article TITLES and the article BODIES together and
       derive the list of subjects the wiki is actually
       tracking about the user - "Jeff's sourdough project",
       "Maya and the household", "the Nak app", "Jeff's
       piano practice", "Jeff's career", "the move to
       Lisbon". The titles are not the source of truth here;
       the bodies are. The whole point is that a title can
       have drifted away from the subject it covers.
   (b) **Run the from-scratch thought experiment.** Imagine
       you had no organisational baggage - no existing
       titles to preserve, no existing paragraph order to
       respect, no friction at all to reorganise. Given the
       same information about the user, **how would you
       organise it? What would each article be titled? What
       order would the content inside each article be in?**
       Be honest. A from-scratch view will usually title an
       article by its subject ("Jeff's sourdough project"),
       not by the conversation that surfaced it ("Jeff's
       first sourdough loaf"), and will usually order the
       content by the natural shape of the subject (overview,
       sub-topics, recent developments) rather than by the
       chronology of the conversations that contributed to
       it.
   (c) **Compare ideal to actual.** Where the from-scratch
       view and the current state meaningfully diverge, the
       gap is what this step exists to close.

   Apply changes:

   - **Rename** an article whose title is overly specific to
     the conversation that birthed it, when the body has
     broadened past that original framing. Use
     wiki_update with the new title; content unchanged. The
     changelog message names the rename and the reason
     ("Rename 'Jeff's first sourdough loaf' -> 'Jeff's
     sourdough project'; content broadened to cover starter
     care, technique notes, and a dozen bakes across recent
     conversations").
   - **Reorder** the content inside an article when the
     existing order reflects the chronology of conversations
     (the most recently-added paragraph at the top,
     unrelated to its importance) rather than the natural
     shape of the subject. Reorder so the from-scratch
     reader gets an overview first, sub-topics in a sensible
     order after, and the dated history of recent
     developments in their natural place. **This is rewriting
     the prose order, not rewriting the prose itself.** A
     statement dated "as of March 2026" that you move from
     paragraph 4 to paragraph 2 still reads "as of March
     2026" verbatim - preserve every word of every dated
     statement, only change where it sits.
   - **Move** a section out of one article and into
     another when the from-scratch view files it under a
     different subject than it currently sits under. Both
     wiki_updates carry the same fact through - never lose
     content in transit.
   - **Split** an article when the from-scratch view treats
     two of its sections as separate subjects with separate
     findability needs. The librarian has no wiki_create, so
     you cannot literally split an article in half - what
     you CAN do is wiki_update the existing article to focus
     on subject A and leave subject B intact and ready for
     the per-conversation agent to land as its own article
     on the next relevant cycle (note this in your final
     reply so the user knows the split is in progress).

   Apply restraint, same as step 5:

   - Small organisational drift - the article is ~80% the
     subject the from-scratch view would pick, ordering is
     mostly reasonable - is NOT a rename or reorder case.
     The title is still the article's centre of mass and
     the prose is still readable; a confident wrong rename
     is more harmful than a slightly-narrow title.
   - Renames and reorderings are warranted only when the
     current organisation is **actively misleading or makes
     information hard to find**. A reader scanning the title
     list would not realise the article covers what it does;
     a reader opening the article gets the wrong impression
     from the lead paragraph. When in doubt, leave it alone.
   - Do not rename and reorder the same article in the same
     cycle if you only have weak evidence for one of them.
     Pick the higher-confidence change, land it, and let
     the next cycle catch the rest.

   Watch for collisions. wiki_update enforces title
   uniqueness per user; if the from-scratch title you would
   pick is already taken by another article, that is itself
   a signal the two articles overlap and step 2 (consolidate
   duplicates) is the right tool, not step 6. Pick a
   different title or merge instead.

   Watch for outbound references. If another article
   references the renamed one by its old title (a Markdown
   link, a "see X for details" line in the prose),
   wiki_update the referring article to point at the new
   title. The wiki has no automatic backref - a stale title
   reference becomes dangling text that no later cycle will
   fix on its own.

   Preserve facts and dates through every reorganisation.
   Renaming changes the title, not the body; reordering
   moves prose around without rewriting it; moving and
   splitting carry every dated statement across to its new
   home verbatim. The dated history is what gives a subject
   its longitudinal value - but its home is the article's
   RECORDS, not the body. So do not DISCARD dated history;
   relocate it. You MAY reduce a body to current-state prose,
   but only after migrating its dated entries into records
   (step 7). Until then, carry every dated line across a
   reorganisation verbatim - never drop one with no record to
   catch it.
7. **Promote learnings, migrate inline dated history, and clean the
   records up.** Each article has a linked set of dated RECORDS -
   the topic's journey (specific events, experiments, observations
   the user logged or the extraction agent captured). The two
   layers split responsibility: records hold the blow-by-blow; the
   article BODY holds the consolidated current state. For each
   article you are already touching (and any whose body still
   carries an inline dated log), PLUS the two or three articles with
   the most recent record activity (the article list above annotates
   each article with its record count and latest record date) - the
   actively-recorded articles are exactly where duplicate records
   accumulate, and an article can need record cleanup without
   needing any body work - call record_list and:

   (a) **Promote durable learnings into the body - without duplicating
       the records.** When the records have established a settled
       outcome or a pattern - the recipe converged on a hydration, an
       experiment reached a conclusion, a habit stuck - wiki_update the
       article body to state that current-state learning (with a date
       marker, same as any other fact). Summarise; do not transcribe
       each record into the body. The body and the records must not say
       the SAME thing: a dated, blow-by-blow account of one attempt
       belongs in a record, not the body. The clearest smell is a
       **date-titled section** in the body - a header like "Dutch oven
       boule (late June 2026)" recounting a specific bake. That is a
       journey entry wearing a body header. If a record already holds
       it, strip the dated detail from the body and keep only the
       distilled current state; if no record holds it, migrate it (b)
       first. After promotion the body answers "what is true now"; it
       must not re-narrate what the records already document.

   (b) **Migrate inline dated history OUT of the body into records.**
       Many existing bodies were written as a running dated log
       ("March 2026: started the starter. April: first sour loaf.").
       Move each such entry into a record, then trim the body to
       current-state prose. STRICT ORDER, because a misstep loses
       data:
       - **Check first - it may ALREADY be a record.** The extraction
         agent or the user may have logged the same event. Compare
         the body line against record_list by date + substance. If a
         matching record exists, do NOT create a duplicate - just
         trim the line from the body.
       - For each remaining inline dated entry, record_create with
         its date + text and confirm it returned a row.
       - ONLY THEN trim that line from the body. NEVER remove a dated
         line before its record exists.

   (c) **Do NOT delete a record after promoting it.** Records are
       historical documentation and survive promotion - the body
       gains the conclusion, the records keep the journey. This is
       the single most important record rule. (Migration in (b) is
       the one case where a dated line LEAVES the body - but only
       because an equivalent record now holds it.)

   (d) **Clean up the records themselves - same-event duplicates
       first.** The recurring duplicate shape is two records on the
       same article with the SAME date describing the SAME happening.
       It arises two ways: two conversations covered one event and
       each produced a record, or an ongoing conversation kept
       discussing yesterday's event and the next extraction pass
       logged it again. Merge them: pick the keeper (a record
       carrying a file attachment wins - record_delete takes a
       record's attachments with it; otherwise keep the earlier or
       more complete one), record_update the keeper to fold in the
       other's unique detail, then record_delete the redundant one
       and fix its links (step e). When the two records CONTRADICT
       each other on a fact (one says 50/50, the other 60/40), do not
       average or guess - conversation_search + conversation_get the
       source thread and keep what the user actually said. Records on
       DIFFERENT dates that continue one arc (started it / how it
       went) are the journey working as intended: link them (step e),
       never merge them. Beyond duplicates: record_update to fix an
       outdated record; record_delete ONLY for a merged-away
       duplicate or a clearly irrelevant entry. When in doubt, leave
       the record alone - a stray record is low-cost, a
       wrongly-deleted event is lost history.

   (e) **Link the journey, and prune broken links.** Records can link to
       each other ("revision 3 based on revision 2"). When you find
       records of an article that form an explicit chain - one is a
       revision of, supersedes, or is based on another - but are not yet
       linked, use record_link_create from the newer record to the prior
       one with a short label ("revision of", "based on"). Conversely, if
       you merge or delete a record and a surviving link now points
       somewhere wrong, or you find a redundant edge duplicating the
       relationship in the other direction, use record_link_delete to
       remove it. Conservative both ways: link only an explicit
       relationship the records actually state, and a harmless link is
       not worth removing.

${WIKI_LIBRARIAN_DISCIPLINE_BLOCK}

${WIKI_LIBRARIAN_FINAL_REPLY_BLOCK}`;

/** The surface a custom-instructions run was invoked from; intro wording only. */
export type LibrarianInvocationSource = 'the Wiki panel' | 'the main chat';

function buildWikiLibrarianCustomBody(
  customInstructions: string,
  invokedFrom: LibrarianInvocationSource,
): string {
  const trimmed = customInstructions.trim();
  const scope = `**Scope: this wiki is about the user, not the world.** Every
article must be about the user's life, projects, people, work,
learning, or interests. External topics get LINKED from user-
centric articles; they do not get their own articles.`;

  const invocationLine =
    invokedFrom === 'the Wiki panel'
      ? 'The user invoked the librarian manually from the Wiki panel and\ntyped these instructions:'
      : 'The user invoked the librarian from the main chat and asked you\nto do this:';

  const instructionsBlock = `**The user has supplied custom instructions for THIS run.**
${invocationLine}

"""
${trimmed}
"""

**Carry out the user's instructions using your tools.** The
instructions above are the scope of this run; do NOT also perform
the standard periodic-librarian sweep (no broad out-of-scope
cleanup, no broad duplicate-merging, no broad fact-checking pass)
unless the user's instructions explicitly ask for it.

**You MAY make additional changes ONLY when they are clearly
required to keep the wiki coherent after carrying out the user's
instructions.** Concrete examples of allowed follow-on edits:

- If the user asks you to delete article A and another article B
  references A by title or as a See Also-style sibling, wiki_update
  B to remove the dangling reference.
- If the user asks you to merge two articles, the absorbing
  article's body must actually carry the absorbed facts, dates,
  and date markers (preserve-facts, preserve-dates apply).
- If the user asks you to rename a person or correct a name, apply
  the rename across every article that mentions the same person in
  the same way.
- If the user's instructions imply a small follow-on (e.g. "split
  the household article into household + finances" requires the
  resulting two articles to not contradict each other), make those
  follow-ons.

Anything beyond "required to keep what I just did coherent" is
out of scope for this run. Do not use the user's instructions as
license to perform the broader periodic sweep. When in doubt,
leave it alone.

If the user's instructions are unclear or impossible against the
current state of the wiki (e.g. they ask you to update an article
that doesn't exist by that title), do nothing destructive - finish
with a one-or-two sentence final reply explaining what stopped
you. A no-op outcome is preferable to a confidently-wrong edit.`;

  return `
${scope}

${WIKI_LIBRARIAN_TOOLS_BLOCK}

${instructionsBlock}

${WIKI_LIBRARIAN_DISCIPLINE_BLOCK}

${WIKI_LIBRARIAN_FINAL_REPLY_BLOCK}`;
}

export function buildWikiLibrarianPrompt(opts: {
  articleList: string;
  userProfile?: WikiLibrarianUserProfile | null;
  /**
   * When non-null/non-empty, swap the standard five-step workflow
   * body for the custom-instructions variant. The scheduled sweep
   * never supplies this; the manual route passes the textarea
   * contents; the chat tool always supplies it.
   */
  customInstructions?: string | null;
  /** Names the surface in the custom variant's intro. */
  invokedFrom?: LibrarianInvocationSource;
}): string {
  const { articleList } = opts;
  const profileBlock = renderUserProfileBlock(opts.userProfile ?? null);
  const custom =
    opts.customInstructions !== undefined &&
    opts.customInstructions !== null &&
    opts.customInstructions.trim().length > 0
      ? opts.customInstructions
      : null;
  const invokedFrom = opts.invokedFrom ?? 'the Wiki panel';
  const intro: string[] = custom
    ? [
        "You are the user's wiki librarian, running a one-off review at",
        invokedFrom === 'the Wiki panel'
          ? "the user's explicit request from the Wiki panel. The list below"
          : "the user's explicit request from the main chat. The list below",
        'is every article in the wiki right now, by title, with a short',
        'excerpt of each. Carry out the custom instructions the user',
        'supplied (see below) and the coherency edits those instructions',
        'imply - nothing else.',
      ]
    : [
        "You are reviewing the user's personal wiki as the librarian. The",
        'list below is every article in the wiki right now, by title, with',
        'a short excerpt of each. Your job is to make the wiki more',
        'coherent than you found it - not by adding articles, but by',
        'consolidating duplicates, removing out-of-scope articles, fact-',
        'checking against conversation history, and tightening the',
        'boundaries between articles that overlap.',
        '',
        "The wiki is the user's own biographical record AND the context a",
        'future assistant loads (through wiki_search) to understand them,',
        'so keep it accurate to the user. When you reorganise or fact-',
        "check, preserve what the user actually said and did, and don't",
        "let an assistant's past suggestion or explanation harden into a",
        'claim about the user.',
      ];
  if (profileBlock.length > 0) {
    intro.push('', profileBlock);
  }
  const body = custom
    ? buildWikiLibrarianCustomBody(custom, invokedFrom)
    : WIKI_LIBRARIAN_BODY;
  return intro.join('\n') + '\n\nArticles in the wiki:\n\n' + articleList + body;
}

// ---------------------------------------------------------------------------
// Shared run plumbing
// ---------------------------------------------------------------------------

interface WikiArticleRow {
  id: string;
  title: string;
  content: string;
}

/** Per-article record signal rendered into the article list. */
interface RecordActivity {
  count: number;
  latestDate: string | null;
}

function renderArticleList(
  rows: readonly WikiArticleRow[],
  recordActivity?: ReadonlyMap<string, RecordActivity>,
): string {
  if (rows.length === 0) return '(the wiki is currently empty)';
  return rows
    .map((r) => {
      const excerpt = r.content
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, LIBRARIAN_EXCERPT_CHARS);
      // The record annotation is what makes the workflow's "articles
      // with the most recent record activity" instruction actionable -
      // without it the model would have to record_list every article
      // to find the active ones.
      const activity = recordActivity?.get(r.id);
      const annotation =
        activity && activity.count > 0
          ? ` (${activity.count} record${activity.count === 1 ? '' : 's'}` +
            `${activity.latestDate ? `, latest ${activity.latestDate}` : ''})`
          : '';
      return `- \`${r.title}\`${annotation} - ${excerpt || '(empty body)'}`;
    })
    .join('\n');
}

/**
 * Aggregate each article's record count + latest record date for the
 * article-list annotation. Fetches (article_id, date) pairs newest-
 * first under a bounded window and aggregates here - PostgREST group-
 * by aggregates aren't a dependable surface, and the annotation is a
 * prompt hint, not bookkeeping, so a count clipped by the window on a
 * pathologically record-heavy wiki is acceptable.
 */
async function loadRecordActivity(
  adminClient: SupabaseClient,
  userId: string,
): Promise<Map<string, RecordActivity>> {
  const { data, error } = await adminClient
    .from('wiki_records')
    .select('article_id, date')
    .eq('user_id', userId)
    .order('date', { ascending: false })
    .limit(2000);
  if (error) throw new Error(`loadRecordActivity failed: ${error.message}`);
  const out = new Map<string, RecordActivity>();
  for (const row of (data ?? []) as Array<{ article_id?: unknown; date?: unknown }>) {
    if (typeof row.article_id !== 'string') continue;
    const date = typeof row.date === 'string' ? row.date : null;
    const existing = out.get(row.article_id);
    if (existing) {
      existing.count += 1;
      // Rows arrive date-descending, so the first date seen per
      // article is already the latest.
    } else {
      out.set(row.article_id, { count: 1, latestDate: date });
    }
  }
  return out;
}

async function loadArticles(
  adminClient: SupabaseClient,
  userId: string,
): Promise<WikiArticleRow[]> {
  const { data, error } = await adminClient
    .from('wiki_articles')
    .select('id, title, content')
    .eq('user_id', userId)
    .order('title', { ascending: true })
    .limit(LIBRARIAN_ARTICLE_LIMIT);
  if (error) throw new Error(`listWikiArticles failed: ${error.message}`);
  return (data ?? []) as WikiArticleRow[];
}

async function loadLibrarianProfile(
  adminClient: SupabaseClient,
  userId: string,
): Promise<WikiLibrarianUserProfile | null> {
  const { data, error } = await adminClient
    .from('profiles')
    .select('settings')
    .eq('user_id', userId)
    .maybeSingle<{ settings: Record<string, unknown> | null }>();
  if (error || !data?.settings) return null;
  const rawName = data.settings.userName;
  const rawLocation = data.settings.userLocation;
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  const location = typeof rawLocation === 'string' ? rawLocation.trim() : '';
  if (!name && !location) return null;
  return { name: name || null, location: location || null };
}

async function claimInflight(
  adminClient: SupabaseClient,
  userId: string,
  holderId: string,
): Promise<boolean> {
  const { data, error } = await adminClient.rpc('claim_wiki_librarian_inflight', {
    p_holder_id: holderId,
    p_ttl_seconds: LIBRARIAN_INFLIGHT_TTL_SECONDS,
    p_user_id: userId,
  });
  if (error) throw new Error(`claim_wiki_librarian_inflight failed: ${error.message}`);
  return data === true;
}

async function releaseInflight(
  adminClient: SupabaseClient,
  userId: string,
  holderId: string,
): Promise<void> {
  const { error } = await adminClient.rpc('release_wiki_librarian_inflight', {
    p_holder_id: holderId,
    p_user_id: userId,
  });
  // Best-effort: a failed release leaves the TTL to sweep the guard.
  if (error) {
    console.error(`[wiki-librarian] release_wiki_librarian_inflight failed: ${error.message}`);
  }
}

/**
 * Live-progress events for user-visible librarian runs. Superset of
 * the runner's AgentProgressEvent, bracketed by the same `preparing`
 * / `done` events the browser manual runner emitted so the Wiki
 * strip's step list keeps its shape:
 *   - `preparing` fires once the article snapshot is loaded (its
 *     count is the most useful pre-model breadcrumb);
 *   - `thinking` / `tool` are the runner's own events;
 *   - `done` closes the list (ok=false on error).
 */
export type LibrarianProgressEvent =
  | { kind: 'preparing'; articleCount: number }
  | AgentProgressEvent
  | { kind: 'done'; ok: boolean };

interface LibrarianReviewArgs {
  adminClient: SupabaseClient;
  userId: string;
  customInstructions: string | null;
  invokedFrom: LibrarianInvocationSource;
  signal: AbortSignal;
  parentDepth: number;
  onProgress?: (event: LibrarianProgressEvent) => void;
  log: EdgeLogger;
}

interface LibrarianReviewResult {
  finalText: string;
  toolCalls: number;
  articleCount: number;
}

/**
 * One librarian review: list articles, build the prompt (standard or
 * custom variant), run the tool loop. Throws on failure - each entry
 * point owns its own error folding and guard release.
 */
async function runLibrarianReview(args: LibrarianReviewArgs): Promise<LibrarianReviewResult> {
  const { adminClient, userId } = args;
  const articles = await loadArticles(adminClient, userId);
  args.onProgress?.({ kind: 'preparing', articleCount: articles.length });
  const recordActivity = await loadRecordActivity(adminClient, userId);
  const projection = renderArticleList(articles, recordActivity);
  const profile = await loadLibrarianProfile(adminClient, userId);
  const promptText = buildWikiLibrarianPrompt({
    articleList: projection,
    userProfile: profile,
    customInstructions: args.customInstructions,
    invokedFrom: args.invokedFrom,
  });

  const variant =
    args.customInstructions && args.customInstructions.trim().length > 0
      ? 'custom-instructions'
      : 'standard';
  args.log.info(`librarian reviewing ${articles.length} article(s) (${variant})`);

  const apiKey = await readVeniceKey(adminClient);
  if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

  const baseCtx: Omit<AgentToolContext, 'signal' | 'depth'> = {
    adminClient,
    userId,
    // The librarian is not thread-scoped; the chat-dispatched path
    // deliberately does NOT pass its thread through either (see
    // asAgentToolNoThread - chat threads are not article sources, and
    // conversation_search's self-exclude matters less than attribution
    // hygiene here).
    threadId: null,
  };

  const result = await runHeadlessAgent(
    {
      model: WIKI_LIBRARIAN_MODEL,
      messages: [{ role: 'system', content: promptText }],
      // Narration params only when someone is watching live (the
      // manual run's progress strip); the scheduled sweep and the
      // chat-dispatched tool keep the wire bytes free of them.
      toolbox: args.onProgress
        ? withProgressNarration(buildLibrarianToolbox())
        : buildLibrarianToolbox(),
      baseCtx,
      apiKey,
      signal: args.signal,
      reasoningEffort: 'low',
      onProgress: args.onProgress,
    },
    args.parentDepth,
  );

  return {
    finalText: result.finalText,
    toolCalls: result.toolCalls,
    articleCount: articles.length,
  };
}

/** Normalise the model's operator summary for the single-line log convention. */
function normaliseReasoning(finalText: string): string {
  return finalText.replace(/\s+/g, ' ').trim() || '(none)';
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Per-tick outcome returned to the /wiki-librarian-sweep caller (and the dev shim). */
export interface WikiLibrarianSweepSummary {
  outcome: 'no-user' | 'inflight-blocked' | 'too-small' | 'reviewed' | 'error';
  toolCalls?: number;
  articleCount?: number;
}

/**
 * One cron tick: claim the most-overdue eligible user and run the
 * standard review for them. NON-throwing by contract. The cadence
 * stamp lands at claim time, so a tick that ends in too-small or
 * inflight-blocked consumes that user's 12h slot - faithful to the
 * browser loop for too-small, and correct for inflight-blocked (the
 * run that holds the guard IS this cycle's librarian activity).
 */
export async function runWikiLibrarianSweepTick(
  adminClient: SupabaseClient,
): Promise<WikiLibrarianSweepSummary> {
  let userId: string;
  try {
    const { data, error } = await adminClient.rpc('claim_next_user_for_wiki_librarian', {
      p_min_interval_seconds: LIBRARIAN_MIN_INTERVAL_SECONDS,
    });
    if (error) throw new Error(`claim_next_user_for_wiki_librarian failed: ${error.message}`);
    if (typeof data !== 'string' || data.length === 0) return { outcome: 'no-user' };
    userId = data;
  } catch (err) {
    console.error(`[wiki-librarian-sweep] ${err instanceof Error ? err.message : String(err)}`);
    return { outcome: 'error' };
  }

  const log = createEdgeLogger(userId, 'wiki-librarian');
  const holderId = crypto.randomUUID();
  let held = false;
  try {
    held = await claimInflight(adminClient, userId, holderId);
    if (!held) {
      log.info('scheduled run skipped - another librarian run is in flight');
      return { outcome: 'inflight-blocked' };
    }

    // The min-articles check runs post-claim, matching the browser
    // loop: a tiny wiki consumes its slot and gets rechecked next
    // interval rather than being re-probed every tick.
    const articles = await loadArticles(adminClient, userId);
    if (articles.length < LIBRARIAN_MIN_ARTICLES) {
      log.info(
        `wiki has ${articles.length} article(s); below ${LIBRARIAN_MIN_ARTICLES}, skipping`,
      );
      return { outcome: 'too-small', articleCount: articles.length };
    }

    const result = await runLibrarianReview({
      adminClient,
      userId,
      customInstructions: null,
      invokedFrom: 'the Wiki panel',
      signal: new AbortController().signal,
      parentDepth: 0,
      log,
    });
    log.info(
      `librarian finished (${result.toolCalls} tool calls over ` +
        `${result.articleCount} articles, reasoning="${normaliseReasoning(result.finalText)}")`,
    );
    await appendWikiAgentLog(adminClient, userId, {
      agent: 'wiki-librarian',
      triggerSource: 'scheduled',
      toolCalls: result.toolCalls,
      reasoning: normaliseReasoning(result.finalText),
    });
    return {
      outcome: 'reviewed',
      toolCalls: result.toolCalls,
      articleCount: result.articleCount,
    };
  } catch (err) {
    log.error(
      'scheduled librarian run failed',
      err instanceof Error ? err : new Error(String(err)),
    );
    return { outcome: 'error' };
  } finally {
    if (held) await releaseInflight(adminClient, userId, holderId);
    await log.flush();
  }
}

/** Result union for the /wiki-librarian-run route; mirrors the browser manual runner. */
export type WikiLibrarianManualResult =
  | { kind: 'ok'; finalText: string; toolCalls: number; articleCount: number }
  | { kind: 'busy' }
  | { kind: 'error'; error: string };

/**
 * User-triggered run (the Wiki panel's sparkles button). Empty/null
 * instructions run the standard sweep variant WITHOUT the cadence
 * stamp or the min-articles skip - the user explicitly asked, so
 * spending the tokens is their call (browser parity). NON-throwing.
 */
export async function runWikiLibrarianManual(
  adminClient: SupabaseClient,
  userId: string,
  instructions: string | null,
  onProgress?: (event: LibrarianProgressEvent) => void,
): Promise<WikiLibrarianManualResult> {
  const log = createEdgeLogger(userId, 'wiki-librarian');
  const holderId = crypto.randomUUID();
  let held = false;
  try {
    held = await claimInflight(adminClient, userId, holderId);
    if (!held) return { kind: 'busy' };

    const custom = instructions && instructions.trim().length > 0 ? instructions : null;
    log.info(
      `manual librarian run requested (${custom ? 'custom-instructions' : 'standard'})`,
    );
    const result = await runLibrarianReview({
      adminClient,
      userId,
      customInstructions: custom,
      invokedFrom: 'the Wiki panel',
      signal: new AbortController().signal,
      parentDepth: 0,
      onProgress,
      log,
    });
    log.info(
      `manual librarian finished (${result.toolCalls} tool calls over ` +
        `${result.articleCount} articles, reasoning="${normaliseReasoning(result.finalText)}")`,
    );
    await appendWikiAgentLog(adminClient, userId, {
      agent: 'wiki-librarian',
      triggerSource: 'manual',
      toolCalls: result.toolCalls,
      reasoning: normaliseReasoning(result.finalText),
    });
    onProgress?.({ kind: 'done', ok: true });
    return {
      kind: 'ok',
      finalText: result.finalText,
      toolCalls: result.toolCalls,
      articleCount: result.articleCount,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`manual librarian run failed: ${msg}`);
    onProgress?.({ kind: 'done', ok: false });
    return { kind: 'error', error: msg };
  } finally {
    if (held) await releaseInflight(adminClient, userId, holderId);
    await log.flush();
  }
}

/**
 * Main-chat surface for delegating wiki maintenance to the librarian.
 * Always the custom-instructions variant - the chat model supplies a
 * free-form instructions string. Shares the in-flight guard with the
 * other two paths; a collision surfaces to the chat model as a tool
 * error it can relay ("try again in a moment").
 */
export const wikiLibrarian: ToolDef = {
  name: 'wiki_librarian',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const instructions =
      typeof args.instructions === 'string' ? args.instructions.trim() : '';
    if (instructions.length === 0) {
      throw new Error('wiki_librarian requires a non-empty `instructions` argument');
    }

    const log = createEdgeLogger(ctx.userId, 'wiki-librarian');
    const holderId = crypto.randomUUID();
    let held = false;
    try {
      held = await claimInflight(ctx.adminClient, ctx.userId, holderId);
      if (!held) {
        throw new Error(
          'A librarian run is already in flight (scheduled or manual); try again in a moment.',
        );
      }
      log.info('chat-delegated librarian run requested (custom-instructions)');
      const result = await runLibrarianReview({
        adminClient: ctx.adminClient,
        userId: ctx.userId,
        customInstructions: instructions,
        invokedFrom: 'the main chat',
        signal: ctx.signal,
        parentDepth: ctx.depth ?? 0,
        log,
      });
      log.info(
        `chat-delegated librarian finished (${result.toolCalls} tool calls over ` +
          `${result.articleCount} articles, reasoning="${normaliseReasoning(result.finalText)}")`,
      );
      await appendWikiAgentLog(ctx.adminClient, ctx.userId, {
        agent: 'wiki-librarian',
        triggerSource: 'chat',
        toolCalls: result.toolCalls,
        reasoning: normaliseReasoning(result.finalText),
      });
      return {
        summary: result.finalText,
        articleCount: result.articleCount,
        toolCalls: result.toolCalls,
      };
    } finally {
      if (held) await releaseInflight(ctx.adminClient, ctx.userId, holderId);
      await log.flush();
    }
  },
};

registerTool(wikiLibrarian);

// Test-only surface. The toolbox composition (no wiki_create, no
// memory writes, no ask_user) and the prompt's variant selection are
// safety/behavior invariants asserted in
// supabase/functions/tests/wiki_librarian.test.ts.
export const __test = {
  buildLibrarianToolbox,
  buildWikiLibrarianPrompt,
  renderArticleList,
};

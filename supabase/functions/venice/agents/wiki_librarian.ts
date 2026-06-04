// wiki_librarian (function-side port)
//
// Main-chat surface for delegating wiki maintenance to the librarian
// sub-agent. The main model calls this with a free-form
// `instructions` string ("merge the two Maya articles", "delete the
// stub about the broken kettle", "split the household article"); the
// librarian reads every wiki article, then carries out the
// instructions plus only the follow-on coherency edits.
//
// Architectural rationale (mirrors the browser-side comments):
//
//   - The librarian operates on the wiki as a whole, on a separate
//     cadence from the per-conversation wiki agent (which runs
//     browser-side as a worker). For the main-chat-driven path, the
//     librarian's toolbox is wiki_search + conversation_search +
//     memory_search + wiki_update + wiki_delete. No wiki_create -
//     new articles flow from the per-conversation agent.
//   - Write tools (wiki_update, wiki_delete) are inlined here rather
//     than registered with the global performToolCall registry. The
//     main chat catalog deliberately does not expose direct wiki
//     writes - any chat-driven wiki edit goes through the librarian's
//     read-then-plan loop, never a one-shot scribble.
//   - Every wiki_update / wiki_delete fires a wiki_changelog row so
//     the audit surface (Wiki panel changelog modal) records the
//     librarian's edits. wiki_update also upserts the validated
//     source_thread_ids into wiki_article_sources for the
//     bibliography view.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { wikiSearch } from '../tools/wiki_search.ts';
import { conversationSearch } from '../tools/conversation_search.ts';
import { memorySearch } from '../tools/memory_search.ts';
import {
  runHeadlessAgent,
  type AgentTool,
  type AgentToolContext,
  type Toolbox,
} from './_run.ts';

const WIKI_LIBRARIAN_MODEL = 'deepseek-v4-flash';
const LIBRARIAN_EXCERPT_CHARS = 400;

// Schema cap constants - mirror src/lib/wiki.ts so the validator's
// error messages match what the browser path produces.
const MAX_WIKI_TITLE_CHARS = 300;
const MAX_WIKI_CONTENT_CHARS = 50_000;
const MAX_WIKI_CHANGELOG_MESSAGE_CHARS = 200;

// ---------------------------------------------------------------------------
// Inline wiki write tools. These don't go through the global registry
// because the main chat catalog deliberately doesn't expose direct
// wiki writes - any chat-driven wiki edit goes through the librarian.
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
      "Rewrite an existing wiki article in place. Either `title` or " +
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
      "just merged its content into another article) or out-of-scope " +
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

async function logWikiChange(
  ctx: AgentToolContext,
  args: {
    articleId: string;
    kind: 'update' | 'delete';
    titleAtChange: string;
    message: string;
  },
): Promise<void> {
  const title = args.titleAtChange.trim();
  const message = args.message.trim();
  if (title.length === 0 || message.length === 0) return;
  // RLS OFF: user_id stamped explicitly.
  const { error } = await ctx.adminClient.from('wiki_changelog').insert({
    user_id: ctx.userId,
    article_id: args.articleId,
    kind: args.kind,
    title_at_change: title,
    message,
  });
  if (error) {
    console.error(`[wiki_librarian] wiki_changelog insert failed: ${error.message}`);
  }
}

async function attachThreadsToWikiSources(
  ctx: AgentToolContext,
  articleId: string,
  rawIds: unknown,
): Promise<void> {
  if (!Array.isArray(rawIds)) return;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawIds) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) return;
  // Validate ids against threads owned by this user. The model's
  // copy fidelity can drift; we drop unknown ids silently rather
  // than rejecting the whole call.
  const { data: valid, error: valErr } = await ctx.adminClient
    .from('threads')
    .select('id')
    .eq('user_id', ctx.userId)
    .in('id', ids);
  if (valErr) {
    console.error(
      `[wiki_librarian] thread validation failed: ${valErr.message}`,
    );
    return;
  }
  const validIds = new Set<string>(
    ((valid ?? []) as Array<{ id: string }>).map((r) => r.id),
  );
  if (validIds.size === 0) return;
  const now = new Date().toISOString();
  const rows = Array.from(validIds).map((thread_id) => ({
    article_id: articleId,
    thread_id,
    last_processed_at: now,
  }));
  const { error } = await ctx.adminClient
    .from('wiki_article_sources')
    .upsert(rows, { onConflict: 'article_id,thread_id' });
  if (error) {
    console.error(
      `[wiki_librarian] wiki_article_sources upsert failed: ${error.message}`,
    );
  }
}

function buildLibrarianToolbox(): Toolbox {
  return {
    name: 'wikiLibrarian',
    tools: [
      {
        name: 'wiki_search',
        wire: WIKI_SEARCH_WIRE_SCHEMA,
        execute: (args, agentCtx) =>
          wikiSearch.execute(args, {
            adminClient: agentCtx.adminClient,
            userId: agentCtx.userId,
            threadId: agentCtx.threadId,
            signal: agentCtx.signal,
            depth: agentCtx.depth,
          }),
      },
      {
        name: 'conversation_search',
        wire: CONVERSATION_SEARCH_WIRE_SCHEMA,
        execute: (args, agentCtx) =>
          conversationSearch.execute(args, {
            adminClient: agentCtx.adminClient,
            userId: agentCtx.userId,
            threadId: agentCtx.threadId,
            signal: agentCtx.signal,
            depth: agentCtx.depth,
          }),
      },
      {
        name: 'memory_search',
        wire: MEMORY_SEARCH_WIRE_SCHEMA,
        execute: (args, agentCtx) =>
          memorySearch.execute(args, {
            adminClient: agentCtx.adminClient,
            userId: agentCtx.userId,
            threadId: agentCtx.threadId,
            signal: agentCtx.signal,
            depth: agentCtx.depth,
          }),
      },
      {
        name: 'wiki_update',
        wire: WIKI_UPDATE_WIRE_SCHEMA,
        async execute(args, agentCtx) {
          const id = typeof args.id === 'string' ? args.id : '';
          if (!id) throw new Error('id is required');
          const message =
            typeof args.message === 'string' ? args.message.trim() : '';
          if (!message) throw new Error('message is required');
          if (message.length > MAX_WIKI_CHANGELOG_MESSAGE_CHARS) {
            throw new Error(
              `message exceeds ${MAX_WIKI_CHANGELOG_MESSAGE_CHARS}-char limit (got ${message.length})`,
            );
          }
          const patch: { title?: string; content?: string; updated_at?: string } = {};
          if (
            typeof args.title === 'string' &&
            args.title.trim().length > 0
          ) {
            const t = args.title.trim();
            if (t.length > MAX_WIKI_TITLE_CHARS) {
              throw new Error(
                `title exceeds ${MAX_WIKI_TITLE_CHARS}-char limit (got ${t.length})`,
              );
            }
            patch.title = t;
          }
          if (typeof args.content === 'string' && args.content.length > 0) {
            if (args.content.length > MAX_WIKI_CONTENT_CHARS) {
              throw new Error(
                `content exceeds ${MAX_WIKI_CONTENT_CHARS}-char limit (got ${args.content.length}); split or trim`,
              );
            }
            patch.content = args.content;
          }
          if (Object.keys(patch).length === 0) {
            throw new Error('nothing to update - title and content both empty');
          }
          patch.updated_at = new Date().toISOString();
          // RLS OFF: filter by user_id to scope.
          const { data, error } = await agentCtx.adminClient
            .from('wiki_articles')
            .update(patch)
            .eq('id', id)
            .eq('user_id', agentCtx.userId)
            .select('id, title')
            .single<{ id: string; title: string }>();
          if (error || !data) {
            throw new Error(
              `updateWikiArticle failed: ${error?.message ?? 'no row returned'}`,
            );
          }
          await logWikiChange(agentCtx, {
            articleId: data.id,
            kind: 'update',
            titleAtChange: data.title,
            message,
          });
          await attachThreadsToWikiSources(
            agentCtx,
            data.id,
            args.source_thread_ids,
          );
          return { updated: true, id: data.id, title: data.title };
        },
      },
      {
        name: 'wiki_delete',
        wire: WIKI_DELETE_WIRE_SCHEMA,
        async execute(args, agentCtx) {
          const id = typeof args.id === 'string' ? args.id : '';
          if (!id) throw new Error('id is required');
          const message =
            typeof args.message === 'string' ? args.message.trim() : '';
          if (!message) throw new Error('message is required');
          if (message.length > MAX_WIKI_CHANGELOG_MESSAGE_CHARS) {
            throw new Error(
              `message exceeds ${MAX_WIKI_CHANGELOG_MESSAGE_CHARS}-char limit (got ${message.length})`,
            );
          }
          // Read the title for the changelog before deleting.
          const { data: existing, error: readErr } = await agentCtx.adminClient
            .from('wiki_articles')
            .select('title')
            .eq('id', id)
            .eq('user_id', agentCtx.userId)
            .maybeSingle<{ title: string }>();
          if (readErr) {
            throw new Error(`readWikiArticle failed: ${readErr.message}`);
          }
          if (!existing) {
            throw new Error(
              `Article ${id} not found (or not owned by this user)`,
            );
          }
          const { error: delErr } = await agentCtx.adminClient
            .from('wiki_articles')
            .delete()
            .eq('id', id)
            .eq('user_id', agentCtx.userId);
          if (delErr) {
            throw new Error(`deleteWikiArticle failed: ${delErr.message}`);
          }
          await logWikiChange(agentCtx, {
            articleId: id,
            kind: 'delete',
            titleAtChange: existing.title,
            message,
          });
          return { deleted: true, id };
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Prompt blocks. Mirror src/lib/agents/wiki-librarian/prompt.ts's
// TOOLS_BLOCK + DISCIPLINE_BLOCK + FINAL_REPLY_BLOCK +
// buildWikiLibrarianCustomBody. The main-chat-driven librarian only
// ever runs the custom-instructions variant.
// ---------------------------------------------------------------------------

const TOOLS_BLOCK = `**Tools you can use**:

- \`wiki_search\` - read the full body of any article (search by
  title, topic, or natural query).
- \`conversation_search\` - read across the user's past
  conversations to verify a claim or find context. Use this
  when an article makes a specific factual assertion that you
  want to corroborate, or when you suspect two articles cover
  the same conversation thread under different titles.
- \`memory_search\` - read the user's atomic-fact memory store
  (the same store the chat-side memory_search hits). Useful as
  a second corroboration source for fact-checking.
- \`wiki_update\` - rewrite an article in place. Preserve facts
  that are still accurate; integrate facts from a duplicate
  article you intend to delete; correct stale information you
  verified is contradicted by recent conversations.
- \`wiki_delete\` - hard-delete an article. Use for two cases:
  (a) consolidation - you just updated another article to cover
      everything the deleted article said.
  (b) out-of-scope cleanup - the article is about a generic
      world-knowledge topic that does not belong in the user's
      wiki. Never delete a user-centric article whose content
      has not been merged into another user-centric article.

**Every \`wiki_update\` and \`wiki_delete\` call requires a
\`message\` parameter.** Treat it like a git commit summary: one
imperative-voice line under ~200 chars naming WHAT this edit does
and WHY. These messages land in the user's wiki changelog.

**Source attribution.** When you wiki_update an article after
consulting \`conversation_search\` results, pass the relevant
thread ids in the \`source_thread_ids\` parameter. Use only thread
ids that came back from \`conversation_search\` results this run -
the tool validates each id and silently drops unknown ones, so
mis-typed ids are harmless but hallucinated ones accomplish
nothing. Skip \`source_thread_ids\` entirely for updates that did
not draw on any conversation.

**You DO NOT have wiki_create.** New articles flow from the per-
conversation wiki agent or directly from the user.`;

const DISCIPLINE_BLOCK = `**Discipline**:

- Be conservative. If you are not sure two articles overlap
  enough to merge, leave them alone. False merges destroy
  information; missed merges just leave a small redundancy.
- Preserve facts. When you wiki_update an article to absorb
  another, every concrete fact from the absorbed article must
  appear in the merged result unless you are confident it is
  wrong.
- Preserve dates. Articles carry month + year date markers that
  anchor when each fact was added. When you wiki_update for any
  reason, leave existing date markers in the prose verbatim.
- Do not fabricate. Only assert facts that appear in the
  existing articles, in conversations you searched, or in the
  excerpts above.
- Same voice and tone the wiki uses already: encyclopedic,
  third-person, present tense, neutral.`;

const FINAL_REPLY_BLOCK = `**Final reply: one or two sentences explaining your choices.**
After your last tool call (or instead of any tool call, if you
decided no edits were needed), reply with a brief operator-facing
summary of what you did and WHY. Name the articles you merged or
deleted, and name the cases you considered but left alone. Skip
filler ("Great work!", "I have finished"); lead with the
decisions. Keep it under two sentences. Plain text, no Markdown.
Zero edits is a normal outcome - say so plainly.`;

function renderProfileBlock(name: string, location: string): string {
  const cleanName = name.trim();
  const cleanLocation = location.trim();
  if (cleanName.length === 0 && cleanLocation.length === 0) return '';
  const parts: string[] = ['**About the user**:'];
  if (cleanName.length > 0) parts.push(`- Name: ${cleanName}`);
  if (cleanLocation.length > 0) parts.push(`- Location: ${cleanLocation}`);
  return parts.join('\n');
}

function buildCustomInstructionsPrompt(
  articleList: string,
  userName: string,
  userLocation: string,
  customInstructions: string,
): string {
  const intro = [
    "You are the user's wiki librarian, running a one-off review at",
    "the user's explicit request from the main chat. The list below",
    'is every article in the wiki right now, by title, with a short',
    'excerpt of each. Carry out the custom instructions the user',
    'supplied (see below) and the coherency edits those instructions',
    'imply - nothing else.',
  ];
  const profile = renderProfileBlock(userName, userLocation);
  if (profile.length > 0) intro.push('', profile);
  const scope = `**Scope: this wiki is about the user, not the world.** Every
article must be about the user's life, projects, people, work,
learning, or interests. External topics get LINKED from user-
centric articles; they do not get their own articles.`;
  const instructionsBlock = `**The user has supplied custom instructions for THIS run.**
The user invoked the librarian from the main chat and asked you
to do this:

"""
${customInstructions.trim()}
"""

**Carry out the user's instructions using your tools.** The
instructions above are the scope of this run; do NOT also perform
the standard periodic-librarian sweep. You MAY make additional
changes ONLY when they are clearly required to keep the wiki
coherent after carrying out the user's instructions (rename
propagation, merging implies absorbing facts, deletion of an
article that another references requires updating the referrer).

If the user's instructions are unclear or impossible against the
current state of the wiki, do nothing destructive - finish with a
one-or-two sentence final reply explaining what stopped you. A
no-op outcome is preferable to a confidently-wrong edit.`;

  return (
    intro.join('\n') +
    '\n\nArticles in the wiki:\n\n' +
    articleList +
    '\n\n' +
    scope +
    '\n\n' +
    TOOLS_BLOCK +
    '\n\n' +
    instructionsBlock +
    '\n\n' +
    DISCIPLINE_BLOCK +
    '\n\n' +
    FINAL_REPLY_BLOCK
  );
}

async function loadUserProfile(
  ctx: ToolContext,
): Promise<{ name: string; location: string }> {
  const { data, error } = await ctx.adminClient
    .from('profiles')
    .select('settings')
    .eq('user_id', ctx.userId)
    .maybeSingle<{ settings: Record<string, unknown> | null }>();
  if (error || !data?.settings) {
    return { name: '', location: '' };
  }
  const s = data.settings;
  return {
    name: typeof s.userName === 'string' ? s.userName : '',
    location: typeof s.userLocation === 'string' ? s.userLocation : '',
  };
}

interface WikiArticleRow {
  id: string;
  title: string;
  content: string;
}

function renderArticleList(rows: readonly WikiArticleRow[]): string {
  if (rows.length === 0) return '(the wiki is currently empty)';
  return rows
    .map((r) => {
      const excerpt = r.content
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, LIBRARIAN_EXCERPT_CHARS);
      return `- \`${r.title}\` - ${excerpt || '(empty body)'}`;
    })
    .join('\n');
}

export const wikiLibrarian: ToolDef = {
  name: 'wiki_librarian',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const instructions =
      typeof args.instructions === 'string' ? args.instructions.trim() : '';
    if (instructions.length === 0) {
      throw new Error('wiki_librarian requires a non-empty `instructions` argument');
    }

    // Fetch articles ordered by title (mirrors the browser-side
    // alphabetical sort for the article list).
    const { data: articleRows, error: artErr } = await ctx.adminClient
      .from('wiki_articles')
      .select('id, title, content')
      .eq('user_id', ctx.userId)
      .order('title', { ascending: true });
    if (artErr) {
      throw new Error(`listWikiArticles failed: ${artErr.message}`);
    }
    const articles = (articleRows ?? []) as WikiArticleRow[];

    const { name, location } = await loadUserProfile(ctx);
    const promptText = buildCustomInstructionsPrompt(
      renderArticleList(articles),
      name,
      location,
      instructions,
    );

    const apiKey = await readVeniceKey(ctx.adminClient);
    if (!apiKey) {
      throw new Error('no Venice key configured (app_config unseeded)');
    }

    const toolbox = buildLibrarianToolbox();
    const baseCtx: Omit<AgentToolContext, 'signal' | 'depth'> = {
      adminClient: ctx.adminClient,
      userId: ctx.userId,
      // The librarian is not thread-scoped. Pass through the
      // orchestrator's threadId so any tool that wants it (e.g.
      // conversation_search's self-exclude) sees a real value.
      threadId: ctx.threadId,
    };

    const result = await runHeadlessAgent(
      {
        model: WIKI_LIBRARIAN_MODEL,
        messages: [{ role: 'system', content: promptText }],
        toolbox,
        baseCtx,
        apiKey,
        signal: ctx.signal,
        reasoningEffort: 'low',
      },
      ctx.depth ?? 0,
    );

    return {
      summary: result.finalText,
      articleCount: articles.length,
      toolCalls: result.toolCalls,
    };
  },
};

registerTool(wikiLibrarian);

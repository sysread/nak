// Autonomous wiki agent (function-side port of src/lib/agents/wiki/).
//
// The wiki agent reads a settled conversation and maintains the
// long-term wiki the user keeps about themselves: it searches for the
// conversation's user-centric subject, then updates (rarely creates)
// articles through the wiki_* tools. The model's final text is a
// one-or-two-sentence operator summary surfaced in the log drawer;
// the wiki_* side effects ARE the persistent output.
//
// Drive shape - two entry points, both exported from this module:
//
//   - runWikiSweepTick: the cron path. pg_cron fires
//     nak_trigger_wiki_sweep() (supabase/schema.sql), which POSTs to
//     the venice function's /wiki-sweep route with the service-role
//     bearer; the route calls this. Each tick claims up to a bounded
//     number of day-gate-eligible threads ACROSS ALL USERS
//     (claim_next_thread_for_wiki is a global SECURITY DEFINER sweep
//     that reads each user's timezone and "automatic wiki updates"
//     toggle off their profile) and runs the agent on each. The
//     hourly schedule resumes a long drain.
//
//   - retryWikiThread: the user path. The Wiki Skipped panel's Retry
//     button POSTs /wiki-retry with the user's JWT; the route calls
//     this with the gateway-validated user id. Bypasses the claim
//     protocol entirely (mirrors the browser-era manual retry): one
//     user clicking Retry has no concurrent sweep to coordinate with,
//     and the pointer-advance goes through manual_advance_wiki_pointer
//     which also clears the skip marker.
//
// No lease coordinator, same rationale as reflection.ts: the claim
// RPC's atomic per-thread claim+TTL IS the mutual exclusion. Each
// claim uses a fresh holder id shared only with its mark/failure call.
//
// Failure handling is richer than reflection's because Venice's
// content classifier rejects some conversation bodies outright
// (HTTP 400 "Input text data may contain inappropriate content") and
// retrying the same input can never succeed. Two layers, both ported
// from the browser agent:
//   - In-run: a single retry against the uncensored fallback model
//     when the primary fails with the classifier sentinel.
//   - Across runs: record_wiki_failure_or_skip counts consecutive
//     failures per terminal message and, at the cap, advances the
//     pointer + stamps the skip marker the Skipped panel renders.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger, type EdgeLogger } from '../../_shared/edge-log.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import {
  asAgentTool,
  loadThreadSliceUpTo,
  MEMORY_SEARCH_WIRE_SCHEMA,
} from './_agent_tools.ts';
import { memorySearch } from '../tools/memory_search.ts';
import { wikiSearch } from '../tools/wiki_search.ts';
import { wikiCreate } from '../tools/wiki_create.ts';
import { wikiUpdate } from '../tools/wiki_update.ts';
import { wikiDelete } from '../tools/wiki_delete.ts';
import {
  runHeadlessAgent,
  type AgentTool,
  type AgentToolContext,
  type AgentCompleteFn,
  type RunHeadlessAgentResult,
  type Toolbox,
} from './_run.ts';
import {
  messageToVenice,
  type VeniceWireMessage,
} from './_recall_helpers.ts';

// Mirror of agentModel('wiki').id in src/lib/models/index.ts.
// AGENT_MODELS is a static role->model map, NOT one of the per-user
// configurable tiers, so the browser path resolved this same constant -
// hardcoding it here stays faithful after the cutover.
const WIKI_MODEL = 'deepseek-v4-flash';

/**
 * Sentinel substring Venice emits when its content classifier rejects
 * the request body. Observed shape (truncated):
 *
 *   Venice chat/completions 400: {"error":"Input text data may contain
 *   inappropriate content.","request_id":"..."}
 *
 * VeniceError messages embed the response body (first 200 chars), so
 * matching on the human-readable phrase keeps the fallback narrow: a
 * 400 for a malformed request, an over-context error, or anything
 * else stays on the original model's error path and lets the failure
 * counter handle it.
 */
const CONTENT_FILTER_SENTINEL =
  'Input text data may contain inappropriate content';

/**
 * Uncensored fallback model. The default wiki slot
 * (deepseek-v4-flash) has a strict input classifier that rejects
 * bodies it doesn't like even before the model gets a chance to read
 * them - on a wiki run that means the agent can't process the
 * conversation no matter how many retries we throw at it.
 * arcee-trinity-large-thinking does not run that classifier, so a
 * single retry against it unblocks the conversation. We retry exactly
 * once: if the fallback also fails, the failure path records it and
 * the per-thread counter eventually advances the pointer.
 */
const CONTENT_FILTER_FALLBACK_MODEL = 'arcee-trinity-large-thinking';

// Mirror of the browser wiki manager's WORKER_DEFAULTS
// (src/lib/agents/wiki/manager.ts pre-cutover): 10-minute claim TTL
// covers a long multi-round tool loop; 3 consecutive failures against
// the same terminal message before the pointer advances past it.
const WIKI_CLAIM_TTL_SECONDS = 600;
const MAX_FAILURES_PER_THREAD = 3;

// How many threads one /wiki-sweep invocation processes before
// handing the rest of the drain to the next cron tick. Each thread is
// a full LLM tool-loop (tens of seconds), so the bound keeps a single
// invocation comfortably inside the function's wall-clock budget; a
// backlog drains at maxThreads-per-hour, which matches the queue's
// natural fill rate (eligibility only changes at day boundaries).
const DEFAULT_SWEEP_MAX_THREADS = 3;

// Schema caps mirror src/lib/wiki.ts (MAX_WIKI_TITLE_CHARS /
// MAX_WIKI_CONTENT_CHARS / MAX_WIKI_CHANGELOG_MESSAGE_CHARS) so the
// wire schemas the agent's model sees match the limits the registered
// tool impls enforce on execute.
const MAX_WIKI_TITLE_CHARS = 200;
const MAX_WIKI_CONTENT_CHARS = 16000;
const MAX_WIKI_CHANGELOG_MESSAGE_CHARS = 200;

// Mirror of src/lib/tools/wiki_search.schema.ts. (The server-side
// wiki_search impl clamps to its own slightly tighter limit; the
// numbers here are the model-facing contract the browser agent
// shipped, kept identical across the migration.)
const WIKI_SEARCH_DEFAULT_LIMIT = 8;
const WIKI_SEARCH_MAX_LIMIT = 25;

// ---------------------------------------------------------------------------
// Wire schemas for the wiki toolbox. Ported from the browser
// src/lib/tools/wiki_*.schema.ts so the wiki model gets the same tool
// contracts regardless of which path drove it. memory_search rides
// along READ-ONLY (its schema lives in _agent_tools.ts) so the agent
// can ground article content in facts the reflection agent already
// extracted; the wiki agent never gets memory write tools.
// ---------------------------------------------------------------------------

const WIKI_SEARCH_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'wiki_search',
    description:
      "Semantic search over the user's wiki - flat encyclopedic articles " +
      'about topics, people, places, and projects in their life (with ' +
      'substring fallback for rows the embeddings worker has not yet ' +
      'processed). Returns {id, title, content, updated_at, similarity?}[] ' +
      'ranked by relevance. Articles are NEVER auto-injected into the chat; ' +
      'this is the only way to surface them.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          description: 'Natural-language query, topic, or article title.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: WIKI_SEARCH_MAX_LIMIT,
          description: `Max results (default ${WIKI_SEARCH_DEFAULT_LIMIT}, max ${WIKI_SEARCH_MAX_LIMIT}).`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

const WIKI_CREATE_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'wiki_create',
    description:
      "Create a new article in the user's wiki. title is the topic name " +
      `(1-${MAX_WIKI_TITLE_CHARS} chars, must be unique per user); content is ` +
      `the article body in encyclopedic third-person prose (max ${MAX_WIKI_CONTENT_CHARS} chars). ` +
      'message is a one-line commit-message-style summary of WHY you are creating this article (max ' +
      `${MAX_WIKI_CHANGELOG_MESSAGE_CHARS} chars); it lands in the wiki changelog so the user can ` +
      'audit who/what added the article and why. ' +
      'Throws on a title collision; on error, run wiki_search and call wiki_update on the existing id.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_WIKI_TITLE_CHARS,
          description: 'Article title (the topic name).',
        },
        content: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_WIKI_CONTENT_CHARS,
          description: 'Article body, encyclopedic third-person prose.',
        },
        message: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
          description:
            'One-line summary of why this article is being added. Written ' +
            'in the imperative voice ("Add Jeff\'s sister Maya, recently ' +
            'moved to Seattle") so the changelog reads as a log of ' +
            'discrete decisions. Lands in the wiki changelog the user can ' +
            'browse from the Wiki top bar.',
        },
      },
      required: ['title', 'content', 'message'],
      additionalProperties: false,
    },
  },
};

const WIKI_UPDATE_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'wiki_update',
    description:
      'Update a wiki article by id. Omit title or content to leave that ' +
      `field unchanged. title capped at ${MAX_WIKI_TITLE_CHARS} chars ` +
      `(must remain unique per user); content capped at ${MAX_WIKI_CONTENT_CHARS} chars. ` +
      'Use wiki_search to find the id. Returns the updated row. Preserve ' +
      'existing facts unless the user has explicitly contradicted them. ' +
      'message is a one-line commit-message-style summary of WHY you are ' +
      `editing this article (max ${MAX_WIKI_CHANGELOG_MESSAGE_CHARS} chars); ` +
      'it lands in the wiki changelog. When invoked by the librarian ' +
      'after consulting conversation_search, pass `source_thread_ids` with the ' +
      'thread ids whose content actually informed this update so they land in ' +
      "the article's bibliography. The autonomous wiki agent leaves " +
      '`source_thread_ids` unset; its current thread is attached automatically.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'UUID of the article (from wiki_search).',
        },
        title: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_WIKI_TITLE_CHARS,
        },
        content: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_WIKI_CONTENT_CHARS,
        },
        message: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
          description:
            'One-line summary of why this article is being edited. Written ' +
            'in the imperative voice ("Correct Maya\'s employer to Bar (from ' +
            'November 2026 chat)") so the changelog reads as a log of ' +
            'discrete decisions. Lands in the wiki changelog the user can ' +
            'browse from the Wiki top bar.',
        },
        source_thread_ids: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 20,
          description:
            'Thread ids whose content informed this update. The librarian ' +
            'populates this with ids from conversation_search results; ' +
            'unknown ids are silently dropped (validated against the ' +
            'threads table). Leave unset on the autonomous path - the ' +
            'current thread is attached automatically by the tool.',
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
      'Delete a wiki article by id. Use only for consolidation - when one ' +
      'article is now strictly subsumed by another article you just updated. ' +
      'Never delete on the basis of "the user said something contradictory ' +
      'today" alone; in that case, update the article to reflect the new view. ' +
      'message is a one-line commit-message-style summary of WHY you are ' +
      `removing this article (max ${MAX_WIKI_CHANGELOG_MESSAGE_CHARS} chars); ` +
      'it lands in the wiki changelog so the user can audit the deletion.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'UUID of the article (from wiki_search).',
        },
        message: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
          description:
            'One-line summary of why this article is being removed. Written ' +
            "in the imperative voice (\"Delete 'Kermit protocol' as out-of-" +
            'scope") so the changelog reads as a log of discrete decisions. ' +
            'Lands in the wiki changelog the user can browse from the Wiki ' +
            'top bar.',
        },
      },
      required: ['id', 'message'],
      additionalProperties: false,
    },
  },
};

// ---------------------------------------------------------------------------
// Prompt. The framing layers each encode a production failure mode and
// must not be softened casually:
//   - dual-purpose + speaker attribution (the opening): the wiki is
//     both the user's biographical record and the context a future
//     assistant reads, and ONLY the user's own turns are a source of
//     user-facts - assistant turns are AI output. Guards the
//     regression where the agent attributed the assistant's statements
//     (explanations, suggestions, the options it laid out) to the user.
//   - anti-name-fabrication (renderUserProfileBlock): the model once
//     named the user after a friend mentioned in conversation.
//   - prime directive, longitudinal accretion, update-over-create
//     bias, sterility test (WIKI_AUTONOMOUS_BODY_LINES): keep the wiki
//     user-centric and additive rather than a per-conversation dump.
// renderUserProfileBlock + the body began as a port of the deleted
// src/lib/agents/wiki/prompt.ts, whose preamble documented the history
// of the ported layers; re-read that history in git before touching
// them.
// ---------------------------------------------------------------------------

/**
 * The user's name + location from Settings -> AI -> About you. Both
 * fields optional; null means "not set".
 */
export interface WikiUserProfile {
  name: string | null;
  location: string | null;
}

/**
 * Render the "About the user" block. Returns the empty string when
 * the profile is null or both fields are empty - a fresh account that
 * hasn't filled the Settings form pays zero tokens for the section.
 *
 * Two distinct rules around the name, both load-bearing:
 *
 *   1. POSITIVE: prefer the configured name over "the user" -
 *      articles read like a personal wiki rather than session notes.
 *   2. NEGATIVE: never invent another name. Production traffic showed
 *      the model writing articles about "Elliot" when the configured
 *      name was "Jeff", because the conversation mentioned a friend
 *      named Elliot and the model conflated the user with someone
 *      else in context.
 *
 * The unknown-name path (location set, name not) is split out so we
 * don't tell the model to "use their name" when no name was supplied.
 */
function renderUserProfileBlock(profile: WikiUserProfile | null): string {
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
        `Avoid the generic phrase "the user" wherever "${name}" fits ` +
        `the sentence. This applies in articles ABOUT the user (the ` +
        `subject is ${name}), articles about projects ${name} is ` +
        `building ("${name} started this project in ..."), articles ` +
        `about people in ${name}'s life ("Maya is ${name}'s sister"), ` +
        `and any other place the user appears. A natural pronoun ` +
        `("they", "their") is also fine where prose flows better than ` +
        `repeating the name.`,
    );
    lines.push(
      `The name is **${name}** and ONLY ${name}. NEVER invent another ` +
        `name for the user, even if other names appear in the ` +
        `conversation - those other names belong to other people the ` +
        `user knows. If the conversation mentions a friend named ` +
        `Maya, an article about the user does not call the user ` +
        `Maya; it calls the user ${name}. If you are uncertain ` +
        `whether the article subject IS the user, default to using ` +
        `the literal name from context (Maya, Elliot, etc.) for that ` +
        `subject and reserve "${name}" for explicit references to ` +
        `the user.`,
    );
  } else {
    lines.push(
      'The user has not supplied a name in Settings. When an article ' +
        'refers to the user themselves, use a natural pronoun ' +
        '("they") or the phrase "the user". NEVER invent a name ' +
        'for the user, even if other names appear in the conversation ' +
        '- those names belong to other people the user knows.',
    );
  }
  if (location) {
    lines.push(`Their location is ${location}.`);
  }
  return lines.join('\n');
}

export function buildWikiAutonomousPrompt(
  opts: { userProfile: WikiUserProfile | null } = { userProfile: null },
): string {
  const profileBlock = renderUserProfileBlock(opts.userProfile);
  const lines: string[] = [
    "You've just finished the conversation above. Now step out of that",
    "role. You're not talking to the user anymore - nobody will read this",
    'reply. Your job is to maintain the long-term wiki the user keeps',
    'about themselves and the topics they care about, using the wiki tools',
    'below.',
    '',
    'The wiki has two readers, and both want the same thing. It is the',
    "user's own external memory - a biographical record they keep and",
    'return to - and it is the context a future assistant loads (through',
    'wiki_search) to understand who the user is before answering them.',
    'Neither reader wants a transcript of this one chat; both want an',
    "accurate, durable account of the user's life, work, and views.",
    '',
    'The conversation above has two speakers, and they are NOT',
    "interchangeable as sources. The user's turns are the user: their",
    'words, their situation, the claims and decisions they own. Your own',
    'turns - the assistant - are AI output: answers, explanations,',
    'suggestions, the options you laid out. You are documenting the USER,',
    'so a fact earns a place in the wiki only when the USER said it, did',
    'it, or explicitly took it up - never on the strength of something',
    'you, the assistant, asserted. Explaining a topic is not the user',
    'having learned it; proposing an approach is not the user having',
    'adopted it; listing options is not the user having chosen one. When',
    "the only source for a statement is your own reply, it is not a fact",
    'about the user and does not belong in the wiki.',
    '',
    'The exception is content the user took up: if the user adopted an',
    'approach you offered, acted on it, or asked you to save a',
    'recommendation, then what the user values IS a fact about the user',
    'and belongs in the wiki - but record it with its provenance, not as',
    "the user's own conclusion. Write \"Jeff saved a set of",
    'recommended self-discovery books" or "Jeff adopted the suggested',
    'colder retard step", not "Jeff believes ..." as though the idea',
    'originated with him. The future assistant needs to tell what the',
    'user worked out from what the user was handed and chose to keep;',
    'flattening the two is the same error as crediting the user with',
    'your explanations.',
  ];
  if (profileBlock.length > 0) {
    lines.push('', profileBlock);
  }
  return lines.join('\n') + '\n' + WIKI_AUTONOMOUS_BODY_LINES;
}

const WIKI_AUTONOMOUS_BODY_LINES = `
The wiki is a flat collection of titled articles (no nesting). Each
article is encyclopedic third-person prose about one topic - a
project, a person in their life, a place, an interest, a recurring
situation. Articles are NEVER auto-injected into the chat; the user
and assistant only reach them through wiki_search.

**Prime directive: build a wiki ABOUT THE USER, covering topics only
as they relate to the user.** Your task is NOT to extract a list of
topics from the conversation and write an article for each. Your
task is to ask "what did this conversation reveal or develop about
THE USER - the kind of durable fact a future assistant would need to
understand them?" and update the wiki to reflect THAT. Those two
lenses (a record the user keeps, and context a future assistant
reads) point at the same thing: the lasting facts of the user's
life, work, and relationships, not the turns of this one chat.

Concrete worked example - the case to learn from:

  The conversation was a brainstorm session for the logo of an app
  the user is building. During the brainstorm the user mentioned
  that the app is named "Nak" because of older file-transfer
  protocols that used a NAK signal, like Kermit, which itself was
  named after Kermit the Frog.

  WRONG (topic-extraction failure mode): create separate articles
  for "Kermit (protocol)", "NAK signal", "Henson Associates", etc.
  None of those are about the user. The Kermit protocol is a
  generic encyclopedia topic regardless of the conversation that
  surfaced it. It is sterile of information about the user.

  RIGHT: there is ONE user-centric subject in this conversation -
  "Nak", the app the user is building. The article belongs there.
  The Kermit-protocol etymology is a useful detail INSIDE the Nak
  article: "Nak takes its name from the NAK (negative-acknowledge)
  signal used in older file-transfer protocols such as
  [Kermit](https://en.wikipedia.org/wiki/Kermit_(protocol))." That
  is the entire correct output for this conversation: one wiki_
  search for "Nak" / "the app", then either wiki_update on an
  existing Nak article or wiki_create a new one with the brainstorm
  details and a Markdown link out for Kermit.

Most conversations have ONE user-centric subject (or zero, if it
was generic Q&A about something external). A single conversation
should never produce more than one or two articles, and most
conversations produce zero. If you find yourself listing multiple
candidate articles, you are probably topic-extracting rather than
identifying-the-subject - stop, re-read the conversation, and ask
what user-centric subject (singular) it was actually about.

If you cannot identify a user-centric subject, produce zero edits
and stop. That is the correct outcome for tutorials, generic
technical Q&A, news discussions, debugging unrelated libraries,
and chitchat.

**The wiki is ongoing documentation, not a one-time snapshot.**
The user's life is a moving target: recipes get tweaked, hobbies
deepen, skills accumulate, projects advance through phases, jobs
change, families grow up. Each article is the longitudinal home
for one of those subjects - a place where what's new today gets
appended to what was true last month, with the dates intact, so
the article reads as that subject's history with the user. Your
job is to listen for what the latest conversation **advances**
about a subject the wiki is already tracking, not just what it
"covers".

Concrete iteration signals to listen for - each of these usually
calls for a wiki_update on the relevant existing article rather
than a new article:

- Recipes the user is refining ("doubled the salt this time",
  "next bake I'll try a colder retard", "this version is the
  keeper"). The article is the recipe's evolving notebook; each
  iteration is a dated entry.
- Hobbies the user is practising ("hit a new 5K PR", "finished
  the under-painting", "tournament result", "garden harvest").
  These advance an ongoing hobby article.
- Learning that's accumulating ("started chapter 6 of the Rust
  book", "finished the Coursera course", "moved on to derived
  categories"). The article tracks the learning arc, not the
  single session.
- Projects moving through phases ("shipped the auth flow", "in
  beta", "rewrote the worker pool", "paused for a month").
  Project articles read as a development log.
- Career changes and milestones ("got the promotion", "starting
  a new role at Foo in May", "finished probation"). The article
  about the user (or the relevant job) gains a dated entry.
- Family and relationship developments ("Maya started kindergarten",
  "we moved", "got engaged", "the cat's eating again"). These
  extend the relevant person / household article.
- Habits and experiments being tracked ("week 8 of the running
  streak", "starter is finally lively", "down to 1 coffee a day").

Each of these warrants a wiki_search for the relevant existing
article followed by wiki_update that APPENDS the new dated
statement to the article's existing prose. Do not rewrite earlier
dated entries; do not condense the article down to "current
state". The accumulated history is the value - a reader skimming
the article in a year wants to see the trajectory, not just
where things landed.

If the latest conversation advances a subject the wiki does not
yet have an article for, and the subject is one the user is
genuinely likely to look up by name later (a project they keep
returning to, a recurring person, a hobby they're investing
time in), wiki_create is appropriate - but write the article so
its first dated statements form the start of a longitudinal
record, not a one-off summary of this conversation.

**Scope: this wiki is about the user, not the world.** Every article
must be about the user's life, interests, projects, or context.
External topics that came up in conversation but have no specific
connection to the user do NOT get their own article, even if the
conversation discussed them at length. They get linked from a user-
centric article instead.

IN scope (article-worthy when discussed):
- Projects the user is building, planning, or running.
- People in the user's life - family, friends, colleagues, contacts.
- Places the user lives, works, travels, or cares about.
- Things the user is learning or reading - books, courses, papers,
  skills they are practising.
- Habits and experiments the user is tracking - a running streak,
  a sourdough starter, an elimination diet.
- The user's career, current job, prior roles, ongoing work.
- Hobbies and interests the user has invested time in.
- The user themselves (a single article about them as the subject).

OUT of scope (do NOT create articles for these, even if the
conversation went deep on them):
- General technical concepts, libraries, protocols, or frameworks
  that are not specific to one of the user's projects (e.g.
  JavaScript closures, the Kermit protocol, HTTP semantics, regex).
- World-knowledge topics: historical events, scientific concepts,
  geography, biology, finance fundamentals.
- Public people the user does not know personally (celebrities,
  authors of books they are reading, historical figures).
- News, current events, things in the wider world.
- Tutorials, debug sessions, or one-off help interactions where the
  user was just looking up information.

**A useful sterility test before wiki_create:** "If I delete every
reference to the user from this draft article, what is left?" If
what is left is a self-contained Wikipedia-style entry on a generic
topic, the article is sterile of user information and should NOT
be created. The Kermit-protocol case fails this test: a generic
encyclopedia entry on a 1981 file-transfer protocol survives the
deletion. The Nak-app case passes: removing the user's involvement
leaves nothing - the article only exists because the user is
building it.

When an OUT-of-scope topic comes up INSIDE a user-centric article
(e.g. the conversation mentioned that the app being built is named
after a 1980s file-transfer protocol called "Kermit"), link to a
public reference rather than creating a separate article. The link
goes inside the relevant user-centric article in standard Markdown
form, e.g.
  "The name comes from [Kermit](https://en.wikipedia.org/wiki/Kermit_(protocol)),
  a 1980s file-transfer protocol."
Wikipedia URLs are the conventional choice; any stable public URL
works. Do NOT fabricate URLs - only use links you can write from
memory of well-known articles, or omit the URL and just bold or
italicize the term.

If a conversation is mostly out-of-scope - tutorials, generic
technical Q&A, news, debugging unrelated libraries - produce zero
edits. That is a correct outcome.

**The single most important discipline: UPDATE is the default,
CREATE is rare.** A new article should be the exception, not the
rule. Most conversations should result in zero or one wiki_update
calls and zero wiki_create calls. Conversations that are mostly
chitchat, tactical (a one-off question with a one-off answer), or
about something the user is unlikely to look up by name later
should produce no wiki edits at all. That is a correct outcome,
not a failure - reply with a single word and stop.

**Voice and tone**:

- Encyclopedic, third-person, present tense, neutral. Like the lead
  paragraph of a Wikipedia article.
- Refer to subjects directly by their names: the project name, a
  first name for a person, the place name for a place. When you
  need to refer to the user themselves, use the configured name
  from the "About the user" block (when present) - NOT the generic
  phrase "the user". Fall back to "the user" only when no name is
  configured.
- No first person, no second person, no chat phrasing. Don't write
  "you mentioned" or "I noted"; write the fact directly.
- One topic per article. If a conversation surfaces multiple topics,
  consider multiple separate updates.
- **Anchor information in time.** When you add a new fact or update
  an existing one, attach a date marker drawn from the conversation
  you're processing - use the latest message timestamp in the
  thread, rendered as month + year ("March 2026", "early 2026",
  "late 2025"). This lets articles accumulate as a progressive
  history rather than a flat snapshot, and gives the librarian a
  freshness signal it can use. Examples:
    "Jeff began learning Rust in March 2026."
    "As of November 2026, the recipe project is in beta."
    "Maya started a new role at Foo in late 2025."
  Month + year granularity is enough; you don't need exact dates.
  When you add a NEW fact to an existing article, do not rewrite
  earlier dated statements - leave them as the historical record.
  Append the new fact with its own date marker so the article
  reads like an entry that's been added to over time.

**Workflow for each topic the conversation actually deserves an
edit on**:

1. **Search broadly first, with multiple query angles.** Call
   wiki_search at least twice with DIFFERENT phrasings before you
   conclude an article does not already exist. The user may have
   an article on the topic under a different title than the one
   that came up in conversation - "kombucha" might already exist
   as "fermented drinks", a person named "Maya" might be filed
   under "household" or by surname. Search for the topic, search
   for adjacent topics, search for the specific facts. Do not
   skip straight to wiki_create.
2. **If anything related exists, prefer wiki_update.** Even a
   loosely-related existing article is usually the right home
   for new information - extend it rather than fragment the wiki.
   A "Maya" article gains a paragraph about her job change; a
   "household" article gains a section about Maya. Preserve every
   existing fact (and every existing date marker) unless the
   conversation explicitly contradicts it. Add new information
   with a fresh date marker drawn from the current conversation;
   do not rewrite earlier dated statements or condense for tone.
   The article should read as a stack of dated developments over
   time, not a single rewritten snapshot.
3. **wiki_create is the last resort.** Only call wiki_create
   when you have run wiki_search at least twice with different
   angles AND none of the results could plausibly be extended to
   cover this topic AND the user is genuinely likely to look
   this up by name later. A new article should be a new SUBJECT,
   not a new conversation summary. If wiki_create raises a
   unique-violation, that means a search angle missed - call
   wiki_search with the exact title and fall through to
   wiki_update.
4. wiki_delete is only for consolidation: when an article you
   just updated now strictly subsumes another one. Never delete
   on the basis of "the user said something different today"
   alone - in that case, update.

**Every wiki_create / wiki_update / wiki_delete call requires a
\`message\` parameter.** Treat it like a git commit summary: one
imperative-voice line under ~200 chars naming WHAT this edit does
and WHY ("Add Maya's new job at Bar (Nov 2026 chat)", "Fold the
draft sister article into household", "Delete out-of-scope Kermit
protocol entry"). These messages land in the user's wiki
changelog, which is the audit surface they use to understand what
the agent has been doing. Don't paste in the entire conversation
or restate the article body; one line, what changed, why.

**Use memory_search to ground article content in established
facts.** The reflection agent extracts atomic facts about the user
(people in their life, projects they work on, preferences,
constraints) into the memory store on every conversation. Before
writing a new article or expanding an existing one about a person
or project, run memory_search for that subject - it often returns
exactly the durable facts you should be folding in. memory_search
is read-only here; never write to memory.

**Do not fabricate.** Only assert facts that appear in the
conversation above, in existing articles you read via wiki_search,
or in memories you read via memory_search. Don't import outside
knowledge.

**Do not fabricate names** - especially names for the user. The
"About the user" block above (when present) is the single source
of truth for what to call the user. Other names that appear in the
conversation belong to other people the user knows; never assign
them to the user. If you cannot tell who the article subject is,
use the literal name as it appears in the conversation rather than
inventing one.

**Be conservative.** Fewer high-signal articles beat many noisy
ones. The bar for updating is "the conversation added durable
information about that subject", not "the conversation mentioned
the subject". The bar for creating is "this is a coherent subject
the user will want to look up by name later", not "this came up".

**Final reply: one or two sentences explaining your choices.** After
your last tool call (or instead of any tool call, if you decided no
edits were warranted), reply with a brief operator-facing summary of
what you did and WHY. This text surfaces in the user's log drawer as
the cycle's outcome, so make it useful to a human skimming the log -
name the article(s) you touched, or name the reason you skipped.
Examples of good summaries:
  "Updated the Nak article with March 2026 logo-brainstorm details;
   added a Markdown link out to the Kermit Wikipedia entry."
  "No edits - the conversation was generic technical Q&A about regex
   with no user-centric subject."
  "No edits - the conversation discussed Kermit at length, but it is
   not user-centric and no existing Nak article was available to link
   it from."
Skip filler ("Great work!", "I have finished"); lead with the
decision. Keep it under two sentences. Plain text, no Markdown.`;

// ---------------------------------------------------------------------------
// Toolbox + run plumbing
// ---------------------------------------------------------------------------

/**
 * True when an error looks like Venice's content-classifier rejection.
 * Exported via __test so the sentinel can be exercised without a real
 * VeniceError instance.
 */
function isContentFilterRejection(err: unknown): boolean {
  if (err == null) return false;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(CONTENT_FILTER_SENTINEL);
}

function buildWikiToolbox(): Toolbox {
  return {
    name: 'wiki',
    tools: [
      asAgentTool(wikiSearch, WIKI_SEARCH_WIRE_SCHEMA),
      asAgentTool(wikiCreate, WIKI_CREATE_WIRE_SCHEMA),
      asAgentTool(wikiUpdate, WIKI_UPDATE_WIRE_SCHEMA),
      asAgentTool(wikiDelete, WIKI_DELETE_WIRE_SCHEMA),
      asAgentTool(memorySearch, MEMORY_SEARCH_WIRE_SCHEMA),
    ],
  };
}

/**
 * Read the user's name + location (Settings -> AI -> About you) for
 * the prompt's "About the user" block. Null when unset or both fields
 * empty, which suppresses the block entirely - same semantics as the
 * browser worker's buildProfile.
 */
async function loadWikiProfile(
  adminClient: SupabaseClient,
  userId: string,
): Promise<WikiUserProfile | null> {
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

/** Normalise the model's operator summary for the single-line log convention. */
function normaliseReasoning(finalText: string): string {
  return finalText.replace(/\s+/g, ' ').trim() || '(none)';
}

type WikiRunOutcome =
  | { kind: 'done'; toolCalls: number; reasoning: string; messageCount: number }
  | { kind: 'empty-slice' }
  | { kind: 'error'; error: string };

/**
 * Run the wiki agent's tool loop against one claimed thread. Shared
 * by the sweep and the manual retry. Non-throwing: every failure path
 * is folded into the `error` outcome so callers route it to the
 * failure RPC (sweep) or the response union (retry) without a second
 * try/catch.
 *
 * Two-shot model attempt: the fallback only triggers when the primary
 * fails with the content-classifier sentinel; any other error
 * (network blip, 500, parse failure) returns as-is so the per-thread
 * failure counter handles it.
 */
async function runWikiAgentOnThread(
  adminClient: SupabaseClient,
  userId: string,
  threadId: string,
  terminalMsgId: string,
  log: EdgeLogger,
  complete?: AgentCompleteFn,
): Promise<WikiRunOutcome> {
  let convo: VeniceWireMessage[];
  let messageCount: number;
  let apiKey: string;
  try {
    const slice = await loadThreadSliceUpTo(adminClient, threadId, terminalMsgId);
    if (slice.length === 0) return { kind: 'empty-slice' };
    messageCount = slice.length;

    const key = await readVeniceKey(adminClient);
    if (!key) return { kind: 'error', error: 'no Venice key configured (app_config unseeded)' };
    apiKey = key;

    const profile = await loadWikiProfile(adminClient, userId);
    convo = slice.map(messageToVenice);
    // Wiki instruction as the final user turn - the "switch modes"
    // idiom. The model sees the whole prior conversation in its
    // native shape and reads this as "now do this different task."
    convo.push({
      role: 'user',
      content: buildWikiAutonomousPrompt({ userProfile: profile }),
    });
  } catch (err) {
    // History fetch / prompt build failed before any Venice call. No
    // fallback applies; surface as a normal agent error.
    return {
      kind: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const baseCtx: Omit<AgentToolContext, 'signal' | 'depth'> = {
    adminClient,
    userId,
    threadId,
  };

  const attempt = async (
    model: string,
  ): Promise<
    | { kind: 'ok'; result: RunHeadlessAgentResult }
    | { kind: 'error'; error: unknown }
  > => {
    log.debug(`asking ${model} about thread ${threadId} (${messageCount} messages)`);
    try {
      const result = await runHeadlessAgent(
        {
          model,
          messages: convo,
          toolbox: buildWikiToolbox(),
          baseCtx,
          apiKey,
          // No outer turn to cancel - the sweep and the retry both run
          // detached from any live stream. A never-aborting signal lets
          // runHeadlessAgent run to its own maxRounds backstop.
          signal: new AbortController().signal,
          complete,
          // 'medium', not 'low': production traffic showed the agent
          // surface-pattern-matching its way through conversations -
          // extracting every named entity into a separate article
          // instead of stopping to ask "what aspect of the user does
          // this conversation actually reveal?". Medium gives the
          // model budget to apply the prime-directive framing before
          // dispatching tool calls.
          reasoningEffort: 'medium',
        },
        // parentDepth 0: the wiki agent is a top-level agent (depth 1),
        // same as reflection.
        0,
      );
      return { kind: 'ok', result };
    } catch (err) {
      return { kind: 'error', error: err };
    }
  };

  const primary = await attempt(WIKI_MODEL);
  if (primary.kind === 'ok') {
    return {
      kind: 'done',
      toolCalls: primary.result.toolCalls,
      reasoning: normaliseReasoning(primary.result.finalText),
      messageCount,
    };
  }
  if (!isContentFilterRejection(primary.error)) {
    return {
      kind: 'error',
      error:
        primary.error instanceof Error
          ? primary.error.message
          : String(primary.error),
    };
  }

  log.warn(
    `content-classifier rejection on thread ${threadId}; ` +
      `retrying with ${CONTENT_FILTER_FALLBACK_MODEL}`,
  );
  const fallback = await attempt(CONTENT_FILTER_FALLBACK_MODEL);
  if (fallback.kind === 'ok') {
    log.info(
      `fallback ${CONTENT_FILTER_FALLBACK_MODEL} cleared content-filter ` +
        `rejection on thread ${threadId}`,
    );
    return {
      kind: 'done',
      toolCalls: fallback.result.toolCalls,
      reasoning: normaliseReasoning(fallback.result.finalText),
      messageCount,
    };
  }
  return {
    kind: 'error',
    error:
      fallback.error instanceof Error
        ? fallback.error.message
        : String(fallback.error),
  };
}

async function markWikiProcessed(
  adminClient: SupabaseClient,
  threadId: string,
  holderId: string,
  terminalMsgId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await adminClient.rpc('mark_thread_wiki_processed_if_claimed', {
    p_thread_id: threadId,
    p_holder_id: holderId,
    p_msg_id: terminalMsgId,
    p_user_id: userId,
  });
  if (error) {
    throw new Error(`mark_thread_wiki_processed_if_claimed failed: ${error.message}`);
  }
  return data === true;
}

async function recordWikiFailureOrSkip(
  adminClient: SupabaseClient,
  threadId: string,
  holderId: string,
  terminalMsgId: string,
  reason: string,
  userId: string,
): Promise<'released' | 'skipped' | 'claim-lost'> {
  const { data, error } = await adminClient.rpc('record_wiki_failure_or_skip', {
    p_thread_id: threadId,
    p_holder_id: holderId,
    p_msg_id: terminalMsgId,
    p_max_failures: MAX_FAILURES_PER_THREAD,
    p_reason: reason,
    p_user_id: userId,
  });
  if (error) {
    throw new Error(`record_wiki_failure_or_skip failed: ${error.message}`);
  }
  return data as 'released' | 'skipped' | 'claim-lost';
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export interface WikiSweepOptions {
  /** Threads to process this invocation; defaults to DEFAULT_SWEEP_MAX_THREADS. */
  maxThreads?: number;
  /** Test seam, forwarded to runHeadlessAgent (defaults to the live call). */
  complete?: AgentCompleteFn;
}

/** Per-tick counters returned to the /wiki-sweep caller (and the dev shim). */
export interface WikiSweepSummary {
  claimed: number;
  processed: number;
  emptySlice: number;
  skipped: number;
  released: number;
  claimLost: number;
  errors: number;
}

/**
 * One cron tick: claim up to maxThreads eligible threads across all
 * users and run the agent on each. NON-throwing by contract - a
 * per-thread failure routes through the failure RPC and the loop
 * moves on; an infrastructure failure (claim RPC down) stops the tick
 * and is reported in the summary. Per-thread progress is logged
 * through an edge logger bound to the thread's OWNER, so each user
 * only sees their own wiki activity in the drawer.
 */
export async function runWikiSweepTick(
  adminClient: SupabaseClient,
  opts: WikiSweepOptions = {},
): Promise<WikiSweepSummary> {
  const maxThreads = opts.maxThreads ?? DEFAULT_SWEEP_MAX_THREADS;
  const summary: WikiSweepSummary = {
    claimed: 0,
    processed: 0,
    emptySlice: 0,
    skipped: 0,
    released: 0,
    claimLost: 0,
    errors: 0,
  };

  for (let i = 0; i < maxThreads; i += 1) {
    // Fresh holder per claim - the claim+mark/fail pair share this one
    // holder; nothing else needs to recognise it.
    const holderId = crypto.randomUUID();
    const { data: claimRows, error: claimErr } = await adminClient.rpc(
      'claim_next_thread_for_wiki',
      { p_holder_id: holderId, p_ttl_seconds: WIKI_CLAIM_TTL_SECONDS },
    );
    if (claimErr) {
      // Infrastructure failure, not a per-thread one: stop the tick
      // rather than burning failure counters across the queue. The
      // next cron tick retries.
      console.error(`[wiki-sweep] claim_next_thread_for_wiki failed: ${claimErr.message}`);
      summary.errors += 1;
      break;
    }
    const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
    if (!claim || typeof claim.thread_id !== 'string') break; // queue empty

    summary.claimed += 1;
    const threadId = claim.thread_id as string;
    const userId = claim.user_id as string;
    const terminalMsgId = claim.terminal_msg_id as string;
    const title = typeof claim.title === 'string' ? claim.title : null;
    const titleTag = title ? `"${title}"` : '[untitled]';
    const log = createEdgeLogger(userId, 'wiki');

    try {
      log.info(`picked up thread ${threadId} @ msg ${terminalMsgId} ${titleTag}`);
      const outcome = await runWikiAgentOnThread(
        adminClient,
        userId,
        threadId,
        terminalMsgId,
        log,
        opts.complete,
      );

      if (outcome.kind === 'empty-slice') {
        // Pathological: no messages. Mark and move on (the
        // pointer-advance is unconditional on success) so the queue
        // doesn't re-claim the same row forever.
        const marked = await markWikiProcessed(adminClient, threadId, holderId, terminalMsgId, userId);
        log.debug(`thread ${threadId} had no messages to process; marked to advance the queue`);
        if (marked) summary.emptySlice += 1;
        else summary.claimLost += 1;
      } else if (outcome.kind === 'done') {
        // Advance the pointer regardless of whether the agent wrote
        // anything - a no-op cycle (model decided no topic warranted
        // an article) still consumed the conversation, and
        // re-processing it every tick would be wasted Venice spend.
        const marked = await markWikiProcessed(adminClient, threadId, holderId, terminalMsgId, userId);
        if (marked) {
          log.info(
            `finished thread ${threadId} ` +
              `(${outcome.toolCalls} tool calls over ${outcome.messageCount} messages, ` +
              `reasoning="${outcome.reasoning}") ${titleTag}`,
          );
          summary.processed += 1;
        } else {
          log.debug(
            `claim lost on thread ${threadId} - another run took over ${titleTag}`,
          );
          summary.claimLost += 1;
        }
      } else {
        // Agent error. Side effects from any wiki_* tool calls already
        // landed (the wiki rows are owned by the user, not the claim).
        // The failure RPC increments the per-thread counter and decides
        // whether to release the claim (retry next tick) or advance the
        // pointer (give up after the cap so a permanently-filtered
        // thread doesn't pin the queue).
        let failureOutcome: 'released' | 'skipped' | 'claim-lost';
        try {
          failureOutcome = await recordWikiFailureOrSkip(
            adminClient,
            threadId,
            holderId,
            terminalMsgId,
            outcome.error,
            userId,
          );
        } catch (rpcErr) {
          // Counter bookkeeping failed. The original agent error is
          // still the headline; surface both so an operator reading
          // the drawer can correlate them. The claim TTL will sweep
          // the row regardless, so we still make forward progress -
          // just on the slower fallback path.
          log.warn(
            `thread ${threadId} agent reported error: ${outcome.error} ${titleTag} ` +
              `(failure RPC also threw: ${rpcErr instanceof Error ? rpcErr.message : String(rpcErr)})`,
          );
          summary.errors += 1;
          continue;
        }
        if (failureOutcome === 'skipped') {
          log.warn(
            `thread ${threadId} agent reported error: ${outcome.error} ` +
              `(reached failure cap; pointer advanced to skip) ${titleTag}`,
          );
          summary.skipped += 1;
        } else if (failureOutcome === 'claim-lost') {
          log.debug(
            `thread ${threadId} agent reported error: ${outcome.error} ` +
              `(claim already gone; another run will retry) ${titleTag}`,
          );
          summary.claimLost += 1;
        } else {
          log.info(
            `thread ${threadId} agent reported error: ${outcome.error} ` +
              `(claim released; will retry next sweep) ${titleTag}`,
          );
          summary.released += 1;
        }
      }
    } catch (err) {
      // mark RPC threw, or some other unexpected failure after the
      // claim. The claim TTL releases the row eventually; count it and
      // keep draining.
      log.warn(
        `thread ${threadId} cycle failed: ${err instanceof Error ? err.message : String(err)} ` +
          `(claim TTL will release the row) ${titleTag}`,
      );
      summary.errors += 1;
    } finally {
      // Flush per thread so a later infrastructure failure can't drop
      // the lines this thread already earned.
      await log.flush();
    }
  }

  return summary;
}

/** Result union for the /wiki-retry route; mirrors the browser-era retry. */
export type WikiRetryResult =
  | {
      kind: 'ok';
      terminalMsgId: string;
      /**
       * Number of wiki_* tool calls the agent issued. Zero is a
       * legitimate outcome - the prompt tells the model to be
       * conservative and skip rather than fabricate edits. The panel
       * uses the count to tell the user whether anything landed in
       * the changelog.
       */
      toolCalls: number;
      /** The model's operator summary; '(none)' when it returned nothing. */
      reasoning: string;
    }
  | { kind: 'no-op'; reason: string }
  | { kind: 'error'; error: string };

/**
 * User-triggered retry of a skipped thread (the Wiki Skipped panel's
 * Retry button). Bypasses the claim protocol - there is no concurrent
 * sweep to coordinate with from the user's point of view, and the
 * worst-case race (a sweep claims the thread mid-retry) just means
 * two agent runs whose tool-level writes are idempotent (wiki_create
 * collides on the unique title and falls through to wiki_update).
 *
 * On success the pointer-advance goes through
 * manual_advance_wiki_pointer, which also clears the skip marker so
 * the panel row drops. On error the skip marker stays put so the user
 * can see the thread is still problematic. NON-throwing: the route
 * maps the result union straight onto the response body.
 */
export async function retryWikiThread(
  adminClient: SupabaseClient,
  userId: string,
  threadId: string,
  opts: { complete?: AgentCompleteFn } = {},
): Promise<WikiRetryResult> {
  const log = createEdgeLogger(userId, 'wiki');
  try {
    const { data: terminalData, error: termErr } = await adminClient.rpc(
      'compute_wiki_terminal_msg_id',
      { p_thread_id: threadId, p_user_id: userId },
    );
    if (termErr) {
      return { kind: 'error', error: `compute_wiki_terminal_msg_id failed: ${termErr.message}` };
    }
    const terminalMsgId = typeof terminalData === 'string' ? terminalData : null;
    if (!terminalMsgId) {
      return { kind: 'no-op', reason: 'No assistant message to process in this thread.' };
    }

    log.info(`manual retry on thread ${threadId} @ msg ${terminalMsgId}`);
    const outcome = await runWikiAgentOnThread(
      adminClient,
      userId,
      threadId,
      terminalMsgId,
      log,
      opts.complete,
    );
    if (outcome.kind === 'error') {
      log.warn(`manual retry failed on thread ${threadId}: ${outcome.error}`);
      return { kind: 'error', error: outcome.error };
    }

    // done or empty-slice: advance the pointer + clear the skip
    // outside the claim protocol. A failure here means the wiki tool
    // side effects landed but the skip marker didn't clear, leaving a
    // stale row in the panel - surface as an error so the user can
    // retry (idempotent at the tool layer).
    const { error: advErr } = await adminClient.rpc('manual_advance_wiki_pointer', {
      p_thread_id: threadId,
      p_msg_id: terminalMsgId,
      p_user_id: userId,
    });
    if (advErr) {
      return {
        kind: 'error',
        error: `agent succeeded but pointer-advance failed: ${advErr.message}`,
      };
    }

    const toolCalls = outcome.kind === 'done' ? outcome.toolCalls : 0;
    const reasoning = outcome.kind === 'done' ? outcome.reasoning : '(none)';
    const messageCount = outcome.kind === 'done' ? outcome.messageCount : 0;
    log.info(
      `manual retry finished thread ${threadId} ` +
        `(${toolCalls} tool calls over ${messageCount} messages, reasoning="${reasoning}")`,
    );
    return { kind: 'ok', terminalMsgId, toolCalls, reasoning };
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
  } finally {
    // Flush before the route responds so the outcome line lands in
    // the drawer alongside the panel's own refresh.
    await log.flush();
  }
}

// Test-only surface. The toolbox composition is a safety invariant -
// the wiki agent gets read-only memory access (no memory write tools,
// no memory_delete) and never ask_user - so it gets its own assertion
// in supabase/functions/tests/wiki.test.ts, alongside the content-
// filter sentinel match and the profile-block rendering rules.
export const __test = {
  buildWikiToolbox,
  isContentFilterRejection,
  buildWikiAutonomousPrompt,
  renderUserProfileBlock,
};

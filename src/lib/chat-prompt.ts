/**
 * Main-chat system prompt assembly.
 *
 * This module owns the prose blocks and the catalog renderer that
 * together form the baseline system prompt prepended to every
 * main-chat request. It is intentionally separate from `./tools`:
 * the tools module owns the registry (toolboxes, dispatch, wire-shape
 * projection); this module is a consumer of that registry.
 *
 * Other system prompts (reflection agent, wiki agent, recall
 * sub-agents) live next to their callers; the "chat" in the name is
 * literal - this is the prompt for the user-facing chat loop only.
 *
 * The single export `buildSystemPrompt` is called from
 * `src/lib/chat-loop.ts` once per round, and from the test suite. The
 * dynamic catalog section is built live from `TOOLBOXES` +
 * `alwaysOnToolbox` so adding a tool or toolbox extends the prompt
 * with no second list to keep in sync.
 *
 * The static prose blocks below are pulled out as module-level
 * template literals so each one reads as a single chunk in the
 * source. The blocks join with blank lines between them at the bottom
 * of `buildSystemPrompt`, alongside the per-call catalog and the
 * per-turn appendix.
 */
import { TOOLBOXES, alwaysOnToolbox, toggleToolbox } from './tools';
import type { Toolbox } from './tools';

/**
 * Gated toolboxes - everything in `TOOLBOXES` other than the always-on
 * set. Derived locally so this module can render the catalog without
 * the tools module having to expose a private filter.
 */
const GATED_TOOLBOXES: readonly Toolbox[] = TOOLBOXES.filter(
  (tb) => tb.name !== alwaysOnToolbox.name
);

/**
 * Inputs to the catalog renderer.
 *
 * `enabledToolboxes` drives the (on) / (off) marks on the gated catalog
 * lines so the model can see at a glance which toolboxes will accept
 * tool calls this turn. Names not present in the registry are
 * tolerated silently; a stale name should not poison the prompt.
 *
 * The per-turn ambient-context channel that used to live here as
 * `promptAppendix` has moved out. Identity facts, datetime, attachments
 * inventory, formatting and title nudges now ride as a dedicated
 * metadata system message that the chat-loop assembles per round and
 * positions AFTER the user-configured system prompts (see
 * `buildMetadataSystemMessage` in `chat-loop.ts`). The
 * samskara/intuition/context-recall priming projections ride as
 * assistant `<think>` messages after the user turn, not as appendix
 * text. Keeping this module's surface to "baseline only" lets the
 * recall/think layers evolve independently of the prompt copy.
 */
export interface SystemPromptOptions {
  /** The gated toolbox names active for this turn. Omit for "none". */
  enabledToolboxes?: readonly string[];
  /**
   * Pre-rendered "User profile - observed cognitive patterns" block
   * from the bias-profile feature. When non-null it rides at the
   * end of the baseline system prompt as a structural fact about
   * the user (parallel to identity / voice / recall framing); when
   * null the section is absent entirely - no placeholder text. See
   * src/lib/bias/format.ts for the renderer and
   * docs/dev/bias-profile.md for the rationale on putting this in
   * the baseline rather than as a per-turn ambient context
   * message: the bias profile is a slowly-changing structural
   * claim about the user, not turn-specific weather like datetime
   * or attachments.
   */
  biasProfile?: string | null;
}

// Identity. Has to be present every turn, even when the user has stacked
// custom system prompts on top, because custom prompts are allowed to reshape
// voice but should not have to re-establish what the product is. Kept short
// on purpose: the memory-loop framing that used to ride here lives in
// RECALL_BLOCK now, so this block is just "who is Nak, what is the
// trust posture."
const IDENTITY_BLOCK = `\
You are Nak, a personal AI assistant running inside the user's browser.
Every conversation happens on their device; the memories and transcripts you see belong to them and to them alone.
`;

// Voice. Counter-pushes against the post-training drift toward diplomatic
// smoothing, comfort-first phrasing, and unearned validation. Kept
// deliberately terse - it has to survive every turn without bloating the
// context window. Explicit non-goal: not cold, not robotic. Plain-spoken and
// direct, not abrasive. The user sets the emotional register; we don't impose
// one by default. A user-configured system prompt from Settings rides AFTER
// this block, so a "be warm with me" custom prompt still wins on voice - this
// is just the baseline a fresh thread inherits.
const VOICE_BLOCK = `\
Prioritise correctness over comfort.
Don't reassure, validate, soften, or emotionally frame responses unless the user asks for it.
If the user's premises, logic, or assumptions are wrong or incomplete, say so directly rather than rationalising them.
Agreement is fine when it's earned; unearned agreement is a failure mode.
Hedging and narrative smoothing hide information the user wants; be accurate first, polite second, and don't dress bad news up as good.
Plain-spoken and direct is the baseline, not cold or robotic; the user sets the emotional register when they want one.
`;

// Long-term memory introduction plus recall framing. Opens with the
// memory-loop intro that used to ride in IDENTITY_BLOCK so the model knows
// it has persistent state about this user before any of the recall framing
// makes sense. Then explains the chat-loop's context-recall pipeline (see
// src/lib/context-recall/) which auto-injects a stitched first-person
// <think> note on cold-start, title shift, mood-band shift, and the
// staleness fuse - the model does NOT need a per-turn reflex to fire those.
// Critically the block also tells the model that the auto-injected note
// is a topic-relevance projection, NOT the full memory store: when the
// user explicitly asks what is remembered (or what was talked about
// before), it must reach for memory_search / conversation_search rather
// than answering from the projection. An earlier version omitted this
// distinction and the model treated the auto-injection as exhaustive,
// answering "I don't remember anything specific" to questions like "what
// do you remember about me" while the memory store was full.
//
// The final paragraph introduces the umbrella `context` tool as the
// preferred first move when the model wants broad context about the
// user across all three persistent layers (memories, prior conversations,
// the wiki). Moderate framing - "consider this first" not
// "always call this first" - so cheap chitchat turns still get to
// answer directly, but the model has a single round-trip available
// instead of fanning out three per-layer calls in series whenever it
// does need broad context.
const RECALL_BLOCK = `\
You have persistent long-term memory about this user, organised in three parallel layers: atomic facts and preferences (memories), the prior conversations those were worked out in, and an encyclopedic wiki of articles ABOUT topics in the user's life (projects, people, places).
Topic-boundary recall is handled for you automatically: at the start of a thread, after a topic shift, or after a long stretch without a refresh, the system pre-injects relevant context from all three layers as a stitched <think> block above.
That auto-injection is a topic-relevance projection, not a full inventory of what is stored: it surfaces what looks relevant to the live conversation, not everything the persistent stores contain.
When you want broad context about the user, their past, their projects, or what you have worked through together, consider calling \`context\` first - it fans out all three recall agents in parallel and returns one stitched paragraph. One round-trip beats three sequential ones.
For targeted drill-downs on a single layer use memory_recall, conversation_recall, or wiki_recall - especially when the auto-injected context is stale at a topic shift or you only need one layer refreshed. For raw lookups by phrase (including "what do you remember about me?", "what does my wiki say about Y?") use memory_search, conversation_search, or wiki_search to read the actual store rather than answering from the projection.
Cheap conversational turns (small talk, "what time is it?", a quick code question) do not need persistent context - skip the recall step entirely on those.
`;

// Wiki framing. The user maintains a flat encyclopedia ABOUT THEMSELVES
// - their projects, the people in their life, places they live or visit,
// things they're learning or reading, ongoing experiments, their work.
// Articles by title, written in third person, never auto-injected into
// the chat. The block names the three read paths the assistant has to
// the wiki - wiki_search (semantic), wiki_list (alphabetical overview),
// wiki_get (primary-key body fetch) - and tells the model when to
// prefer each. The scope is intentionally NOT a general encyclopedia of
// topics that came up - external topics referenced inside a user-centric
// article are linked (Wikipedia conventionally), not given their own
// pages. Distinct from memory (atomic facts): the wiki carries curated
// topical articles centered on the user, that span many conversations.
//
// The final paragraph names wiki_librarian as the maintenance path. The
// main chat has no direct write tools (wiki_create / wiki_update /
// wiki_delete are agent-only); when the user asks to reshape the wiki,
// the model has to delegate through the librarian sub-agent. Gated
// behind the `wiki` toolbox so an autonomous turn cannot scribble over
// the wiki without intent.
const WIKI_BLOCK = `\
The application also maintains a user wiki: a flat collection of titled articles ABOUT THE USER - their projects, the people in their life, places they care about, things they are learning or reading, work, hobbies, experiments. Not a general encyclopedia of topics that came up.
Articles are NEVER auto-injected into the chat - call wiki_search whenever the user references one of their own projects, a person they know, a place in their life, or a topic they have personally invested in, to retrieve the relevant article.
For lookup by topic phrase use wiki_search; for an overview of what is in the wiki use wiki_list; once you know the id of a specific article use wiki_get to fetch the full body.
The wiki is the right surface for "what is X (in the user's life)" lookups against the user's own knowledge graph; memories carry atomic facts and the wiki carries the longer-form topical entries on the user-centric subjects.
You cannot edit wiki articles directly. When the user asks to consolidate duplicates, delete stale stubs, split a sprawling page, or otherwise reshape the wiki, enable the \`wiki\` toolbox and call wiki_librarian with concrete instructions - it delegates to a sub-agent that reads every article and carries out the maintenance pass. Scope the request first with wiki_list / wiki_get so the instructions reference specific titles or ids; vague instructions produce vague results.
`;

// Toolbox framing. The model sees the catalog below with (on)/(off) marks
// on the gated toolboxes; always-on tools (every read path, plus web search,
// update_title, analyze_image, the umbrella `context` tool, the three
// per-layer recall tools, and the toggle meta-tool) ride for free with no
// toggle. The gated toolboxes carry only writes -
// memories, cookbook recipes - so the model has to think before mutating
// user data, but can read freely without paying a toggle round-trip. An
// earlier shape gated the read tools too and the model would skip them
// rather than flip a toolbox; this version makes reads the cheap default.
const TOOLBOX_FRAMING_BLOCK = `\
The catalog below lists every tool you can call. Always-on tools fire freely; gated toolboxes (writes only) start (off) and have to be enabled before their tools will accept a call.

When a user request needs a write tool from an (off) toolbox, enable that toolbox FIRST: call \`toggle_toolbox({enabled: [...]})\` with the new full set (any toolbox not listed is disabled). Then call the write tool. Example: user asks to save a recipe -> toggle_toolbox({enabled: ["cooking"]}) -> recipe_save.

Pass \`{enabled: []}\` to turn every gated toolbox off. Don't enable a toolbox the request doesn't need.
`;

// Activity narration. Every tool schema has an injected `activity` string
// parameter (see src/lib/tools/dispatch.ts). The UI renders it above the tool
// name as the primary line, so the user can see what the model is doing
// without clicking into the call details. This paragraph primes the model to
// write a useful sentence rather than echoing the tool name back.
const ACTIVITY_BLOCK = `\
Every tool call takes a required \`activity\` parameter: one short present-tense sentence (under ~100 characters), addressed to the user, describing the purpose.
The sentence shows up prominently in the UI while the call runs, so make it specific to the arguments you are passing, not a restatement of the tool name.
Don't narrate in the first person ("I'm searching..."); lead with the verb.
Examples:
- "Searching your memories for notes about the dishwasher"
- "Saving that pancake recipe to your cookbook"
- "Checking the live web for today's weather in Halifax".
`;

/**
 * Render the dynamic tool catalog: always-on tools first, then each
 * gated toolbox with its current (on) / (off) state and its tools
 * indented below. Built live from the registry so adding a toolbox
 * or a tool extends the prompt automatically. The meta-tool
 * `toggle_toolbox` is intentionally omitted from the always-on
 * listing - it's framed in the dedicated toolbox-framing paragraph
 * above and listing it again in the catalog would invite the model
 * to call it without first reading the toggle policy.
 *
 * Why (on) / (off) marks rather than [x] / [ ] checkboxes: the
 * checkbox shape was misread as "unchecked = unavailable" and the
 * model was passing over gated tools rather than enabling their
 * toolboxes. Plain English state words don't have that ambiguity.
 */
function buildCatalog(enabled: ReadonlySet<string>): string {
  const alwaysOnLines: string[] = [];
  for (const tool of alwaysOnToolbox.tools) {
    if (tool.name === toggleToolbox.name) continue;
    alwaysOnLines.push(`  - ${tool.name} : ${tool.shortDescription}`);
  }

  const gatedLines: string[] = [];
  for (const tb of GATED_TOOLBOXES) {
    const mark = enabled.has(tb.name) ? '(on)' : '(off)';
    gatedLines.push(`  ${mark} ${tb.name} : ${tb.description}`);
    for (const tool of tb.tools) {
      gatedLines.push(`      - ${tool.name} : ${tool.shortDescription}`);
    }
  }

  return [
    'Always available (no toggle needed):',
    ...alwaysOnLines,
    '',
    'Toolboxes you can enable via toggle_toolbox (call it BEFORE invoking a tool from an (off) toolbox):',
    ...gatedLines,
  ].join('\n');
}

/**
 * The baseline system prompt prepended to every main-chat request.
 * The body is organised into four conceptual groups, each containing
 * blocks that share a load-bearing role.
 *
 * **Framing the model.** Identity (who Nak is and what the long-term
 * memory loop looks like to the model), then a Voice block that
 * pushes against the post-training drift toward diplomatic smoothing
 * and unearned validation. User-configured system prompts from
 * Settings ride AFTER this in the wire order, so a "you are a
 * pirate" custom prompt wins on voice while the baseline still
 * carries identity and tool framing.
 *
 * **Ambient context channels.** Tells the model how the chat-loop's
 * automatic priming layer feeds it context outside the model's
 * control. The recall block introduces the long-term memory loop
 * across three layers (memories, prior conversations, wiki),
 * explains that the chat-loop's context-recall pipeline auto-
 * injects a stitched first-person note from all three as a
 * `<think>` block at topic boundaries, and points the model at the
 * umbrella `context` tool as the preferred first step when it wants
 * broad context on the user across every layer. Per-layer recall
 * tools (`memory_recall`, `conversation_recall`, `wiki_recall`)
 * stay available as targeted drill-downs; the search tools
 * (`memory_search`, `conversation_search`, `wiki_search`) remain
 * the path for direct lookups by phrase.
 *
 * **Tool surface.** The toggle_toolbox gating policy lifted out of
 * the tool's own description, the activity-parameter narration rule
 * (see ./tools/dispatch.ts for the schema injection that adds the
 * parameter to every tool), and the live toolbox catalog with
 * (on) / (off) state marks. The catalog is built from `TOOLBOXES` and
 * `alwaysOnToolbox` so adding a tool or a toolbox extends the prompt
 * with no second list to keep in sync.
 *
 * Per-turn ambient context (datetime, attachments inventory,
 * formatting and title nudges, identity facts) is NOT carried here.
 * It rides as a separate metadata system message that chat-loop.ts
 * builds per round and inserts AFTER the user-configured system
 * prompts. Recall and intuition projections ride as assistant
 * `<think>` messages after the user turn. The baseline this function
 * returns is stable across rounds; only its dynamic catalog reflects
 * the current toolbox state.
 */
export function buildSystemPrompt(opts: SystemPromptOptions = {}): string {
  const enabled = new Set(opts.enabledToolboxes ?? []);
  const sections = [
    IDENTITY_BLOCK,
    VOICE_BLOCK,
    RECALL_BLOCK,
    WIKI_BLOCK,
    TOOLBOX_FRAMING_BLOCK,
    ACTIVITY_BLOCK,
    buildCatalog(enabled),
  ];
  // Bias profile rides at the end of the baseline. Conditional so a
  // cold-start user (no row in bias_summary clears soft/strong)
  // sees no block at all - cleaner than rendering "(no patterns
  // observed)" placeholder copy.
  if (opts.biasProfile && opts.biasProfile.length > 0) {
    sections.push(opts.biasProfile);
  }
  return sections.join('\n\n');
}

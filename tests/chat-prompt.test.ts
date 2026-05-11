/**
 * Coverage for the main-chat system prompt assembly.
 *
 * The prompt's load-bearing beats (identity, recall framing,
 * anti-sycophancy voice block, toggle-toolbox gating rule, dynamic
 * tool catalog with (on)/(off) marks, user_message boundary, datetime
 * tag, system_reminder channel, URL scraping) are asserted via grep-
 * style matchers so phrasing tweaks don't churn the suite, while a
 * regression on a load-bearing idea still trips a clear failure.
 *
 * The catalog-derivation test pairs with the registry: every tool
 * other than toggle_toolbox itself appears as a catalog line built
 * live from `TOOLBOXES`, so adding a tool extends the prompt without
 * touching anything in this file.
 */
import { describe, it, expect } from 'vitest';
import {
  TOOLS,
  GATED_TOOLBOX_NAMES,
  buildToolList,
  toggleToolbox,
  type ToolDef,
} from '../src/lib/tools';
import { buildSystemPrompt } from '../src/lib/chat-prompt';

describe('buildSystemPrompt', () => {
  it('primes the model to write an activity sentence per call', () => {
    // The UI surfaces the sentence above the tool name; the prompt is
    // what makes the model supply a useful one. Grep-style assertions
    // rather than exact copy so phrasing tweaks don't churn the test,
    // but the load-bearing beats (the parameter name, the one-sentence
    // requirement, the user-addressed framing) must survive any future
    // edit to the block.
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('`activity`');
    // The prompt assembles via `.join('\n')` so adjacent words in the
    // source array are separated by newlines - match on \s+ rather
    // than a literal space so phrasing tweaks that reflow the array
    // don't churn the test.
    expect(prompt).toMatch(/one\s+short\s+present-tense\s+sentence/i);
    expect(prompt).toMatch(/addressed\s+to\s+the\s+user/i);
  });

  it('opens with the Nak identity line', () => {
    // The first sentence frames the model. It has to be present every
    // turn, even when the user has custom system prompts stacked after
    // it, because user prompts are allowed to reshape voice but shouldn't
    // have to re-establish what the product is.
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/^You are Nak/);
  });

  it('mentions long-term memory and nudges memory_recall', () => {
    // The memory loop is the interesting behavior. If this copy rots,
    // the model stops reaching for memory_recall and recall becomes a
    // dead tool. Fail loudly on a regression rather than silently.
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/long-term memory/i);
    expect(prompt).toContain('memory_recall');
  });

  it('carries the anti-sycophancy voice block', () => {
    // Push back against the post-training tendency toward diplomatic
    // smoothing, comfort-first phrasing, and unearned validation.
    // Grep-style assertions on the semantic beats rather than exact
    // copy so phrasing tweaks don't churn the test - but the three
    // load-bearing ideas (correctness over comfort, direct
    // corrections over rationalising, earned agreement only) must
    // survive any future edit to the block.
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/correctness\s+over\s+comfort/i);
    expect(prompt).toMatch(/(rationalis|rationaliz)ing/i);
    expect(prompt).toMatch(/(unearned|earned)/i);
    // And the explicit non-goal: plain-spoken, not cold. Drop this
    // line and the block slides toward "robotic" - which is a
    // different failure mode than the one we're fixing.
    expect(prompt).toMatch(/not\s+cold|not\s+robotic|plain-spoken/i);
  });

  it('lists every tool (always-on + gated) but omits toggle_toolbox itself', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('memory_recall');
    expect(prompt).toContain('conversation_recall');
    expect(prompt).toContain('memory_search');
    expect(prompt).toContain('memory_create');
    expect(prompt).toContain('memory_update');
    expect(prompt).toContain('memory_delete');
    expect(prompt).toContain('conversation_search');
    // toggle_toolbox is the switch itself, not something to advertise
    // in either catalog section - the prompt block that explains the
    // toggle rule already names it.
    expect(prompt).not.toMatch(/^- toggle_toolbox/m);
  });

  it('catalog lines are dynamically derived from the registry', () => {
    // Every tool other than `toggle_toolbox` appears as a catalog line
    // with its name + shortDescription, across the always-on section
    // and per-toolbox blocks. If a tool is added to a toolbox but
    // forgotten in the prompt code, this test catches the drift - the
    // prompt is always the live view.
    const prompt = buildSystemPrompt();
    const cataloged = TOOLS.filter((t: ToolDef) => t.name !== toggleToolbox.name);
    for (const tool of cataloged) {
      expect(prompt).toContain(`- ${tool.name} : ${tool.shortDescription}`);
    }
  });

  it('groups gated tools under their toolbox with (on)/(off) marks', () => {
    // Unchecked first - default state. `always_on` header should not
    // appear as a toolbox row; it has its own "Always available"
    // section above.
    const disabled = buildSystemPrompt({ enabledToolboxes: [] });
    const alwaysIdx = disabled.indexOf('Always available');
    // Anchor on the catalog header specifically. The framing block
    // above the catalog now uses the word "toolbox(es)" too, so a
    // bare indexOf('Toolboxes') would land in the framing prose.
    const gatedIdx = disabled.indexOf('Toolboxes you can enable');
    expect(alwaysIdx).toBeGreaterThanOrEqual(0);
    expect(gatedIdx).toBeGreaterThan(alwaysIdx);

    // Read paths and the recall pair live under Always available;
    // gated toolboxes carry only writes.
    const alwaysSection = disabled.slice(alwaysIdx, gatedIdx);
    const gatedSection = disabled.slice(gatedIdx);
    expect(alwaysSection).toMatch(/- memory_recall /);
    expect(alwaysSection).toMatch(/- conversation_recall /);
    expect(alwaysSection).toMatch(/- memory_search /);
    expect(alwaysSection).toMatch(/- conversation_search /);
    expect(alwaysSection).toMatch(/- recipe_list /);
    // Writes do not leak into the always-on listing.
    expect(alwaysSection).not.toMatch(/- memory_create /);
    expect(alwaysSection).not.toMatch(/- recipe_save /);
    // Gated section carries the writes.
    expect(gatedSection).toMatch(/- memory_create /);
    expect(gatedSection).toMatch(/- recipe_save /);
    expect(gatedSection).toMatch(/- journal_delete /);
    expect(gatedSection).not.toMatch(/- memory_search /);
    expect(gatedSection).not.toMatch(/- recipe_list /);

    // Every gated toolbox gets a "(off) name : description" line with
    // its tools indented below. The conversations and research
    // toolboxes were dropped (their only tools are now always-on).
    expect(gatedSection).toMatch(/\(off\) cooking : /);
    expect(gatedSection).toMatch(/\(off\) memories : /);
    expect(gatedSection).toMatch(/\(off\) journal : /);
    expect(gatedSection).not.toMatch(/\(off\) conversations : /);
    expect(gatedSection).not.toMatch(/\(off\) research : /);
  });

  it('shows (on) marks for enabled toolboxes and (off) for disabled ones', () => {
    // The marks give the model visible current state without a second
    // prompt section. A model reading "(on) cooking" knows it can
    // invoke the cooking write tools this turn without a toolbox
    // flip. Plain English state words instead of [x]/[ ] checkboxes -
    // the checkbox shape was misread as "unchecked = unavailable"
    // and the model was skipping over gated tools rather than
    // enabling their toolboxes.
    const prompt = buildSystemPrompt({ enabledToolboxes: ['cooking', 'journal'] });
    expect(prompt).toMatch(/\(on\) cooking : /);
    expect(prompt).toMatch(/\(off\) memories : /);
    expect(prompt).toMatch(/\(on\) journal : /);
  });

  it('carries the recall framing: long-term memory across four layers, priming is a projection not a full inventory, tools used when stale or for explicit lookups', () => {
    // The recall block has five load-bearing beats:
    //   (1) introduce long-term memory across four parallel layers
    //       (memories, prior conversations, wiki, daily journal) so
    //       the model knows what kinds of persistent state exist;
    //   (2) tell the model that topic-boundary recall is auto-
    //       injected as a <think> block by the chat-loop's context-
    //       recall pipeline (see src/lib/context-recall/);
    //   (3) make clear that the auto-injection is a topic-relevance
    //       projection rather than a full inventory of the store -
    //       drop this beat and the model treats "I don't see anything
    //       pre-injected" as "nothing is stored" and answers "I don't
    //       remember anything specific" while the store is full;
    //   (4) frame the umbrella `context` tool as the preferred first
    //       step for broad lookups - one round-trip across all four
    //       layers instead of four sequential per-layer calls;
    //   (5) route explicit "what do you remember" lookups to the
    //       *_search tools (memory_search, conversation_search,
    //       wiki_search, journal_search) rather than the *_recall
    //       tools.
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/long-term memory/i);
    // Every per-layer recall tool and the umbrella context tool.
    expect(prompt).toMatch(/memory_recall/);
    expect(prompt).toMatch(/conversation_recall/);
    expect(prompt).toMatch(/wiki_recall/);
    expect(prompt).toMatch(/journal_recall/);
    expect(prompt).toMatch(/`context`/);
    // Every direct-search counterpart.
    expect(prompt).toMatch(/memory_search/);
    expect(prompt).toMatch(/conversation_search/);
    expect(prompt).toMatch(/wiki_search/);
    expect(prompt).toMatch(/journal_search/);
    expect(prompt).toMatch(/handled.*automatically/i);
    expect(prompt).toMatch(/<think>/);
    expect(prompt).toMatch(/stale/i);
    // The projection-vs-inventory distinction. "projection" or
    // "not a full inventory" both work as load-bearing markers for
    // this beat; either should survive a phrasing tweak.
    expect(prompt).toMatch(/projection|not.*full.*inventory|not.*everything/i);
    // The umbrella `context` tool's framing: "consider calling
    // context first" should survive the moderate-nudge wording. If
    // the prompt rephrases this beat, that's a deliberate change
    // and the test should be updated alongside it.
    expect(prompt).toMatch(/consider.*context|context.*first/i);
  });

  it('explains the toggle_toolbox gating rule', () => {
    // The policy used to live on the toggle tool's own description;
    // it now belongs here so the model sees it before any gated
    // schemas are on the wire (empty toolboxes_enabled => only the
    // always-on set is sent). A drop here would let a model that
    // doesn't already know about toggle_toolbox try to call
    // memory_search directly.
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/toggle_toolbox\(/);
    expect(prompt).toMatch(/enabled:\s*\[/);
  });

  it('carries the user-message boundary rule and Venice-injection warning', () => {
    // Venice can inject content into what arrives as the user turn -
    // URL scraping (enable_web_scraping) is always on in venice.ts,
    // so any request where the user pasted a URL gets the full
    // scraped page inlined after their text. chat-loop.ts wraps the
    // current user turn unconditionally in <user_message>...</user_message>
    // as the structural boundary; this prompt block is the paired
    // instruction telling the model what to do with the tags.
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('<user_message>');
    expect(prompt).toContain('</user_message>');
    // Behavior beats we don't want to lose on a future phrasing edit:
    // the explicit "not a human-authored instruction" frame, the
    // don't-thank-the-user guidance, and the "instructions come from
    // this system message" anchor that tells the model which source
    // of framing actually binds it.
    // \s+ throughout - the prompt assembles from hard-wrapped template
    // literals, so phrasing tweaks that reflow a wrap can split phrases
    // across a newline. The semantic beats are what matters; the regex
    // shouldn't churn just because a paragraph rewrap shifted.
    expect(prompt).toMatch(/not\s+a\s+human-authored/i);
    expect(prompt).toMatch(/do\s+not\s+thank/i);
    expect(prompt).toMatch(/instructions\s+come\s+from\s+this\s+system\s+message/i);
  });

  it('mentions URL scraping capability unconditionally', () => {
    // URL scraping is always on in venice.ts: any user turn with a
    // pasted link arrives with the page contents inlined. If the
    // prompt didn't say so, the model would refuse "what does this
    // page say?" with a generic "I cannot browse the web" even
    // though the scraped content is already sitting in the user
    // turn waiting to be read.
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/paste[sd]?\s+a\s+url/i);
    expect(prompt).toMatch(/full\s+page\s+content/i);
  });

  it('web_search is always-on - rides with every request, listed in the always-available catalog', () => {
    // Web search is a reflex-level capability, same rationale as the
    // *_recall tools: the model should be able to reach for it on any
    // time-sensitive question without needing a toolbox toggle first.
    // This test is the tripwire for anyone moving it into a gated
    // toolbox.
    expect(buildToolList([]).map((t) => t.function.name)).toContain('web_search');
    expect(buildToolList(GATED_TOOLBOX_NAMES).map((t) => t.function.name)).toContain(
      'web_search'
    );
    // Catalog advertisement - the system prompt's "Always available"
    // section must mention web_search by name + shortDescription so
    // the model knows the tool exists. A gated placement would put
    // it inside one of the toolbox blocks further down.
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(
      /Always available \(no toggle needed\):[\s\S]*- web_search : search the live web/
    );
  });
});

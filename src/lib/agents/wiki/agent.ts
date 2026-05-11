/**
 * Wiki agent. Drives two distinct flows over the user's wiki:
 *
 *   - **Autonomous**: `run()` is called by the worker loop. Reads a
 *     settled thread, appends `WIKI_AUTONOMOUS_PROMPT` as the final
 *     user turn, and runs the headless tool loop with `wikiToolbox`.
 *     The loop's side effects (wiki_search / wiki_create /
 *     wiki_update / wiki_delete calls) ARE the output; final text is
 *     discarded after being captured for logs.
 *
 *   - **Manual**: `updateOne()` runs synchronously on the main thread
 *     when the user clicks "Ask agent to update" on a single article.
 *     One Venice completion, response_format pinned to JSON, no tool
 *     loop. Returns a structured preview the UI displays before
 *     persisting.
 *
 * The two paths share the same model (`agentModel('wiki').id`) and
 * voice (encyclopedic third-person), but the prompts are distinct -
 * autonomous reads a conversation and decides per-topic, manual
 * applies explicit instructions to one article.
 *
 * The agent does NOT acquire or release the lease, claim or mark the
 * thread, or spawn its own worker. Those live in `./loop.ts` and
 * `./worker.ts` respectively. This class is pure logic.
 */
import type { Agent, AgentRunRequest, AgentRunResult } from '../types';
import type { SupabaseService, Message } from '../../supabase';
import type { VeniceClient, VeniceMessage, ResponseFormat } from '../../venice';
import { wikiToolbox } from '../../tools/wiki_toolbox';
import { runHeadlessToolLoop } from '../../tools/run';
import { sanitizeToolCallIdForWire, sanitizeToolCallsForWire } from '../../tools/wire';
import { agentModel } from '../../models';
import { createLogger } from '../../logger.svelte';
import {
  buildWikiAutonomousPrompt,
  buildWikiManualPrompt,
  type WikiUserProfile,
} from './prompt';
import type { WikiInput, WikiOutput } from './types';

const log = createLogger('wiki-worker');

/**
 * Pin response_format=json_object on the manual path. The autonomous
 * path is tool-driven (no JSON output expected) so we leave
 * responseFormat unset there.
 */
const WIKI_MANUAL_RESPONSE_FORMAT: ResponseFormat = { type: 'json_object' };

function messageToVenice(m: Message): VeniceMessage {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      content: m.content,
      tool_call_id:
        m.tool_call_id != null
          ? sanitizeToolCallIdForWire(m.tool_call_id)
          : undefined,
      name: m.name ?? undefined,
    };
  }
  const out: VeniceMessage = { role: m.role, content: m.content };
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
    out.tool_calls = sanitizeToolCallsForWire(m.tool_calls);
  }
  return out;
}

/**
 * Result shape for `updateOne()`. Discriminated union so the UI can
 * tell "model produced an updated article to preview" apart from
 * "model decided no change is warranted" without sniffing strings.
 * Genuine errors (parse failure, abort, network) still throw.
 */
export type WikiUpdateOneResult =
  | { kind: 'preview'; title: string; content: string }
  | { kind: 'noop'; reason: string };

/**
 * Parsed shape the manual path expects. `update` carries title +
 * content; `noop` carries a one-sentence reason. Either action ships
 * with optional fields the parser is tolerant about.
 */
interface ManualDecision {
  action: 'update' | 'noop';
  title: string | null;
  content: string | null;
  reason: string | null;
}

/**
 * Parse the manual-agent's final-text JSON. Tolerant of a markdown
 * fence wrapping the body - some training data carries the fence even
 * when response_format=json_object is set, and stripping it here is
 * cheaper than re-prompting.
 */
function parseManualDecision(text: string): ManualDecision | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const payload = fence ? fence[1] : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const actionRaw = obj.action;
  const action: 'update' | 'noop' =
    actionRaw === 'update' || actionRaw === 'noop' ? actionRaw : 'noop';
  const title = typeof obj.title === 'string' ? obj.title.trim() : null;
  const content = typeof obj.content === 'string' ? obj.content : null;
  const reason =
    typeof obj.reason === 'string' && obj.reason.trim().length > 0
      ? obj.reason.trim()
      : null;
  return { action, title, content, reason };
}

export class WikiAgent implements Agent<WikiInput, WikiOutput> {
  readonly name = 'wiki';
  readonly model: string;
  readonly toolbox = wikiToolbox;
  /**
   * Mutable user profile (Settings -> AI -> About you). Read on
   * every `run()` / `updateOne()` so the worker can live-update it
   * via `setUserProfile` without a restart - mirrors the journal
   * agent's pattern. Null (or both fields empty) suppresses the
   * "About the user" block entirely.
   */
  private userProfile: WikiUserProfile | null = null;

  constructor(
    private venice: VeniceClient,
    private supabase: SupabaseService,
    /**
     * Optional model override. Defaults to the registry's `wiki`
     * slot (currently deepseek-v4-flash). Useful for tests.
     */
    modelId?: string,
    /**
     * Initial user profile. The worker passes this from its
     * StartMessage; the per-article manual flow (called on the
     * main thread) passes the values it just read off
     * `app.userName` / `app.userLocation`. Null keeps the prompt's
     * "About the user" block off.
     */
    userProfile?: WikiUserProfile | null
  ) {
    this.model = modelId ?? agentModel('wiki').id;
    this.userProfile = userProfile ?? null;
  }

  /**
   * Live-update the profile fields. Called by the worker on a
   * `{type:'profile'}` postMessage so a Settings edit reaches the
   * next cycle without a restart.
   */
  setUserProfile(profile: WikiUserProfile | null): void {
    this.userProfile = profile;
  }

  async run(
    req: AgentRunRequest<WikiInput>
  ): Promise<AgentRunResult<WikiOutput>> {
    const signal = req.signal ?? new AbortController().signal;

    if (signal.aborted) {
      return {
        output: { finalText: '', inputMessageCount: 0 },
        toolCalls: 0,
        stoppedReason: 'aborted',
      };
    }

    try {
      const allMessages = await this.supabase.listMessages(req.input.threadId);
      const terminalIdx = allMessages.findIndex(
        (m) => m.id === req.input.terminalMsgId
      );
      const slice =
        terminalIdx >= 0 ? allMessages.slice(0, terminalIdx + 1) : allMessages;

      if (slice.length === 0) {
        // Pathological: no messages. Mark and move on (loop's
        // pointer-advance is unconditional on `done`).
        return {
          output: { finalText: '', inputMessageCount: 0 },
          toolCalls: 0,
          stoppedReason: 'done',
        };
      }

      const convo: VeniceMessage[] = slice.map(messageToVenice);
      convo.push({
        role: 'user',
        content: buildWikiAutonomousPrompt({
          userProfile: this.userProfile,
          threadId: req.input.threadId,
        }),
      });

      log.info(
        `asking model about thread ${req.input.threadId} ` +
          `(${slice.length} messages)`
      );

      const result = await runHeadlessToolLoop({
        venice: this.venice,
        model: this.model,
        messages: convo,
        toolbox: this.toolbox,
        toolCtx: {
          supabase: this.supabase,
          venice: this.venice,
          userId: req.userId,
          threadId: req.input.threadId,
        },
        signal,
        // Bumped from 'low' to 'medium' after production traffic
        // showed the agent surface-pattern-matching its way through
        // conversations - extracting every named entity into a
        // separate article (Kermit protocol, NAK signal, ...) instead
        // of stopping to ask "what aspect of the user does this
        // conversation actually reveal?". Medium gives the model
        // budget to apply the prime-directive framing before
        // dispatching tool calls. The manual updateOne path stays
        // on 'low' - it's a single-completion JSON shape with the
        // user already directing the change.
        reasoningEffort: 'medium',
      });

      return {
        output: {
          finalText: result.finalText,
          inputMessageCount: slice.length,
        },
        toolCalls: result.toolCalls,
        stoppedReason: signal.aborted ? 'aborted' : 'done',
      };
    } catch (err) {
      return {
        output: { finalText: '', inputMessageCount: 0 },
        toolCalls: 0,
        stoppedReason: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * User-initiated "ask agent to update this article" flow. Runs on
   * the main thread, single completion, structured-JSON output. Does
   * NOT write to the DB - the caller (Wiki.svelte) shows a preview
   * and persists on Accept via `supabase.updateWikiArticle`.
   *
   * Throws on parse failure, abort, or network error so the UI can
   * offer a retry. A clean "the instructions don't require a change"
   * decision returns `kind: 'noop'` (not a throw) so the UI can show
   * the reason without an error banner.
   */
  async updateOne(args: {
    articleId: string;
    currentTitle: string;
    currentContent: string;
    userInstructions: string;
    signal?: AbortSignal;
  }): Promise<WikiUpdateOneResult> {
    const signal = args.signal ?? new AbortController().signal;
    if (signal.aborted) throw new Error('Update aborted before start.');
    const instructions = args.userInstructions.trim();
    if (instructions.length === 0) {
      throw new Error('Instructions are required.');
    }

    // The model sees the article first (via the system prompt is the
    // contract) and then the user's instructions as a user turn. The
    // user-content block restates the article so the model has the
    // exact baseline text to preserve.
    const userTurn = [
      'Article to edit:',
      '',
      `Title: ${args.currentTitle}`,
      '',
      'Content:',
      args.currentContent,
      '',
      '---',
      '',
      'Instructions:',
      instructions,
    ].join('\n');

    const convo: VeniceMessage[] = [
      {
        role: 'system',
        content: buildWikiManualPrompt({ userProfile: this.userProfile }),
      },
      { role: 'user', content: userTurn },
    ];

    log.info(
      `manual update on article ${args.articleId} ` +
        `(${args.currentContent.length} chars in, ${instructions.length} chars instructions)`
    );

    const completion = await this.venice.completeChat({
      model: this.model,
      messages: convo,
      signal,
      responseFormat: WIKI_MANUAL_RESPONSE_FORMAT,
      reasoningEffort: 'low',
    });
    if (signal.aborted) throw new Error('Update aborted mid-stream.');

    const decision = parseManualDecision(completion.text);
    if (decision === null) {
      throw new Error(
        "The model returned a response we couldn't parse. Try again."
      );
    }
    if (decision.action === 'noop') {
      return {
        kind: 'noop',
        reason: decision.reason ?? 'No change applied.',
      };
    }
    // action === 'update'
    const finalTitle =
      decision.title && decision.title.length > 0
        ? decision.title
        : args.currentTitle;
    const finalContent =
      decision.content && decision.content.length > 0 ? decision.content : '';
    if (finalContent.length === 0) {
      throw new Error(
        'The model returned an update with empty content. Try again.'
      );
    }
    return { kind: 'preview', title: finalTitle, content: finalContent };
  }
}

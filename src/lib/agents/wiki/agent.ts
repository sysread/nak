/**
 * Wiki manual-edit agent: the per-article "Ask agent to update" flow
 * on Wiki.svelte. One Venice completion, response_format pinned to
 * JSON, no tool loop. Returns a structured preview the UI displays
 * before persisting via `supabase.updateWikiArticle`.
 *
 * This file used to also house the autonomous wiki agent (the
 * background flow that reads settled threads and maintains the wiki
 * through the wiki_* tools). That flow now runs server-side in the
 * venice edge function - the cron-driven sweep plus the Skipped
 * panel's /wiki-retry route; see
 * supabase/functions/venice/agents/wiki.ts. The manual flow stays
 * browser-side because it is a single no-tool completion with a
 * user-interactive preview, the same category as the other no-tool
 * agents.
 */
import type { SupabaseService } from '../../supabase';
import type { VeniceMessage, ResponseFormat } from '../../venice';
import { agentModel } from '../../models';
import { createLogger } from '../../logger.svelte';
import { buildWikiManualPrompt, type WikiUserProfile } from './prompt';

const log = createLogger('wiki-manual');

/**
 * Pin response_format=json_object so the model's reply parses as the
 * ManualDecision shape below.
 */
const WIKI_MANUAL_RESPONSE_FORMAT: ResponseFormat = { type: 'json_object' };

/**
 * Result shape for `updateOne()`. Discriminated union so the UI can
 * tell "model produced an updated article to preview" apart from
 * "model decided no change is warranted" without sniffing strings.
 * Genuine errors (parse failure, abort, network) still throw.
 *
 * The preview variant carries `reason` (the agent's one-line summary
 * of what it changed and why) so the UI can render it next to the
 * preview AND pass it through as the wiki-changelog message on
 * Accept. The agent has the most context for that summary - prompting
 * the user a second time for "describe the edit you just asked for"
 * would be busywork.
 */
export type WikiUpdateOneResult =
  | { kind: 'preview'; title: string; content: string; reason: string }
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

export class WikiAgent {
  readonly model: string;
  /**
   * User profile (Settings -> AI -> About you) for the prompt's
   * "About the user" block. Null (or both fields empty) suppresses
   * the block entirely.
   */
  private userProfile: WikiUserProfile | null = null;

  constructor(
    private supabase: SupabaseService,
    /**
     * Optional model override. Defaults to the registry's `wiki`
     * slot (currently deepseek-v4-flash). Useful for tests.
     */
    modelId?: string,
    /** Initial user profile; null keeps the "About the user" block off. */
    userProfile?: WikiUserProfile | null
  ) {
    this.model = modelId ?? agentModel('wiki').id;
    this.userProfile = userProfile ?? null;
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

    const completion = await this.supabase.complete({
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
    // Older / non-conforming completions may omit `reason` on an
    // update. Fall back to a generic snippet of the user's
    // instructions so the changelog row still carries SOMETHING
    // useful rather than nothing - this is preferable to throwing
    // and forcing the user to retry just because the model
    // forgot a field.
    const reason =
      decision.reason && decision.reason.length > 0
        ? decision.reason
        : `Manual edit: ${instructions.slice(0, 140)}`;
    return {
      kind: 'preview',
      title: finalTitle,
      content: finalContent,
      reason,
    };
  }
}

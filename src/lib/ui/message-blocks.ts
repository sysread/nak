/**
 * The chat transcript's render plan - the fold from the raw message
 * list (src/lib/supabase Message rows in position order) into the
 * block list the message loop in src/screens/Chat.svelte renders.
 * Pure functions only - no runes, no Svelte imports, no DOM. The
 * screen wraps `buildMessageBlocks` in a $derived so message
 * mutations re-group automatically (e.g. when the chat-loop pushes a
 * new tool-result row mid-turn).
 *
 * The decisions encoded here are the ones a port to another framework
 * would carry across unchanged: which rows fold under which (tool
 * results under their assistant parent), which rows are hidden from
 * the user entirely (recovery rows, housekeeping tool calls), and
 * which tool calls sprout dedicated sibling blocks (generated images,
 * renames, ask-user cards) instead of the generic tool-group card.
 *
 * Interacts with: src/lib/conversation-recovery.ts (the recovery-row
 * marker this module filters on), src/lib/ui/generated-image.ts (the
 * per-call image descriptors), src/lib/ask-user.ts (the call-args and
 * result-content parsers behind the ask-user block states).
 */
import type { Message } from '../supabase';
import { isRecoveryMessage } from '../conversation-recovery';
import { generatedImagesForGroup } from './generated-image';
import {
  parseAskUserCallArgs,
  parseAskUserContent,
  ASK_USER_PENDING_FLAG,
  type AskUserAnsweredContent,
} from '../ask-user';

/**
 * One renderable unit of the transcript. Tool-result rows are folded
 * into their parent assistant message's tool-group so the UI sees one
 * card per turn; plain user / assistant-text rows pass through.
 *
 * Exported as the named return shape of `buildMessageBlocks` - no
 * consumer imports it by name today; the screen narrows on the `kind`
 * discriminant directly. Not dead code.
 */
export type MessageBlock =
  | { kind: 'plain'; message: Message }
  | { kind: 'tool-group'; assistant: Message; resultsByCallId: Record<string, Message> }
  // A generate_image tool call's output, rendered as its own card
  // directly below the tool-group block for the turn it fired on.
  // `key` is the tool_call_id (stable across renders); `assistantId`
  // anchors it to the originating row; `filename` + `aspectRatio` let
  // GeneratedImageCard resolve the image by filename and size its
  // loading placeholder. A separate block (not the AssistantBody
  // attachment slot) because the image hydrates by filename, not via
  // the realtime attachment path - see src/lib/ui/generated-image.ts.
  | {
      kind: 'generated-image';
      key: string;
      assistantId: string;
      filename: string;
      aspectRatio: string;
    }
  // Rendered as a single faded "Renamed to X" line where an
  // `update_title` call fired. Carries a stable `key` so the #each
  // keyed loop can distinguish multiple renames within one turn
  // (unlikely, but the model could do it). `assistantId` anchors
  // the block to its originating assistant row for debugging /
  // future deep-link needs.
  | { kind: 'rename'; key: string; assistantId: string; title: string }
  // Rendered as an AskUserCard for an `ask_user` tool call. Three
  // states (pending / answered / abandoned) derive from the tool-
  // result row's content (see parseAskUserContent). `key` is the
  // tool_call_id, stable across renders so the #each loop doesn't
  // tear down the card on every messages mutation. `answeredContent`
  // is set when state isn't 'pending'. The question and options ride
  // on the block rather than being re-parsed in the template because
  // the model's original ask lives only in the call's arguments - the
  // answered result shape doesn't echo it.
  | {
      kind: 'ask-user';
      key: string;
      assistantId: string;
      state: 'pending' | 'answered' | 'abandoned';
      question: string;
      options: { label: string; description: string }[];
      answeredContent: AskUserAnsweredContent | null;
    };

// Tool names rendered as something other than a standard tool-call
// card. `update_title` and `ask_user` are filtered from the standard
// tool-group card because each has its own dedicated rendering
// surface ("Renamed to X" line, AskUserCard respectively). The
// underlying tool_calls and tool-result rows still live in the
// message store and go out on the wire on replay; this is purely a
// display filter.
// `toggle_toolbox` is NOT hidden: it used to be, because the
// persisted tool-result row's realtime INSERT could land after END
// and the missing result then rendered as a red X via statusFor's
// post-END logic. Under streaming-root the toggle almost always
// happens in a non-terminal round (model toggles, then calls the
// gated write tool, then writes a terminal response), so the
// tool-result row has multiple rounds of realtime propagation budget
// before END fires - the timing-race window closed in practice.
// Rendering as a tool card gives the user a persistent chat-thread
// artifact of the toggle, which the 600ms composer-toolbox flash
// alone doesn't.
const HIDDEN_TOOL_NAMES = new Set(['update_title', 'ask_user']);

/**
 * Pull the sanitised title out of an update_title call + its
 * optional result row. Prefers the tool-result (post-sanitisation,
 * post-persist) because that's exactly what was written to the DB;
 * falls back to the call's raw arguments when the result hasn't
 * landed yet (mid-turn, before persistence finishes). Returns null
 * if neither source yields a non-empty title - in which case the
 * rename block is skipped entirely rather than rendering an empty
 * indicator.
 */
function titleFromRenameCall(
  call: { function: { arguments: string } },
  result: Message | undefined
): string | null {
  if (result) {
    try {
      const parsed = JSON.parse(result.content) as unknown;
      if (
        parsed &&
        typeof parsed === 'object' &&
        'title' in parsed &&
        typeof (parsed as { title: unknown }).title === 'string'
      ) {
        const t = (parsed as { title: string }).title.trim();
        if (t) return t;
      }
    } catch {
      // fall through to args
    }
  }
  try {
    const parsed = JSON.parse(call.function.arguments || '{}') as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'title' in parsed &&
      typeof (parsed as { title: unknown }).title === 'string'
    ) {
      const t = (parsed as { title: string }).title.trim();
      if (t) return t;
    }
  } catch {
    // malformed JSON on the wire is the model's fault; skip the block
  }
  return null;
}

/**
 * Fold the transcript's message rows into the render plan. Returns a
 * fresh array; the input rows are never mutated (the one narrowed
 * assistant row is a copy).
 */
export function buildMessageBlocks(messages: readonly Message[]): MessageBlock[] {
  // First pass: index tool rows by their tool_call_id.
  const resultsByCallId: Record<string, Message> = {};
  for (const m of messages) {
    if (m.role === 'tool' && m.tool_call_id) {
      resultsByCallId[m.tool_call_id] = m;
    }
  }
  // Second pass: emit blocks, folding assistant-with-tool_calls rows
  // into a tool-group that carries the matching result rows.
  const blocks: MessageBlock[] = [];
  for (const m of messages) {
    if (m.role === 'tool') continue; // folded under their assistant parent
    // Filter synthetic and persisted recovery rows from the UI.
    // synthesizeRecoveryMessages adds them so the wire shape stays
    // valid for the next provider call (tool -> user without an
    // intervening assistant is a provider 400), but they read as
    // noise to the user - the failure is already conveyed by the
    // failed tool card and the incomplete-turn banner above. Hiding
    // them here keeps the wire fix while sparing the user the meta-
    // note. Catches both shapes via the RECOVERY_MARKER substring
    // test: synthetic rows (created in memory by the recovery walk)
    // and persisted rows (saved to the DB on the next user send).
    if (isRecoveryMessage(m)) continue;
    // Draft user rows (fork-and-edit flow) never render as cards.
    // The composer is the only surface that shows the draft text.
    // On send, the row is promoted to status=null and becomes a
    // normal user message, so this filter only applies while the
    // draft is pending.
    if (m.status === 'draft') continue;
    if (m.role === 'user') {
      blocks.push({ kind: 'plain', message: m });
      continue;
    }
    if (
      m.role === 'assistant' &&
      m.tool_calls &&
      m.tool_calls.length > 0
    ) {
      const visibleCalls = m.tool_calls.filter(
        (c) => !HIDDEN_TOOL_NAMES.has(c.function.name)
      );
      // Pull the rename calls off separately so they render as their
      // own dedicated block below. A turn can contain both rename +
      // other tools; the two render paths coexist, with the rename
      // indicator appearing AFTER the assistant/tool-group block for
      // the turn it fired on (reads as "here's the response. and by
      // the way, renamed").
      const renameCalls = m.tool_calls.filter(
        (c) => c.function.name === 'update_title'
      );

      // If every call on this turn is hidden, we either drop the
      // whole row (no body, nothing to show) or demote it to a
      // plain block so any assistant text still reaches the user.
      // Demoting preserves the rare case where a model emits a
      // short "ok, tools off" reply alongside the toggle call.
      if (visibleCalls.length === 0) {
        if (m.content && m.content.trim().length > 0) {
          blocks.push({ kind: 'plain', message: m });
        }
      } else {
        const scoped: Record<string, Message> = {};
        for (const call of visibleCalls) {
          const r = resultsByCallId[call.id];
          if (r) scoped[call.id] = r;
        }
        // Copy the message so we can narrow tool_calls to just the
        // visible ones without mutating the store-owned row.
        const narrowed: Message = { ...m, tool_calls: visibleCalls };
        blocks.push({ kind: 'tool-group', assistant: narrowed, resultsByCallId: scoped });

        // Emit one generated-image card per successful generate_image
        // call, immediately after the tool-group block so the picture
        // sits right under the tool card that made it. The card
        // resolves the image by filename rather than reading the
        // assistant row's attachments, because the server-side
        // per-round attach never echoes back over realtime (see
        // generated-image.ts). Skipped for failed/in-flight calls -
        // the descriptor is only parseable once the result lands.
        for (const img of generatedImagesForGroup(visibleCalls, scoped)) {
          blocks.push({
            kind: 'generated-image',
            key: img.key,
            assistantId: m.id,
            filename: img.filename,
            aspectRatio: img.aspectRatio,
          });
        }
      }

      // Emit one rename block per successful update_title call on
      // this turn. Placed AFTER the main block (see comment above on
      // reading order).
      for (const call of renameCalls) {
        const title = titleFromRenameCall(call, resultsByCallId[call.id]);
        if (title !== null) {
          blocks.push({
            kind: 'rename',
            key: call.id,
            assistantId: m.id,
            title,
          });
        }
      }

      // Emit one ask-user block per `ask_user` call on this turn.
      // The question and options come from the call's arguments (the
      // model's original ask) so they survive into the answered
      // history view, which carries only the answer payload. The
      // tool-result row's content determines the state and the
      // answer envelope (if any).
      const askUserCalls = m.tool_calls.filter(
        (c) => c.function.name === 'ask_user'
      );
      for (const call of askUserCalls) {
        const args = parseAskUserCallArgs(call.function.arguments);
        if (!args) continue;
        const resultRow = resultsByCallId[call.id];
        const parsedResult = resultRow
          ? parseAskUserContent(resultRow.content)
          : null;
        let state: 'pending' | 'answered' | 'abandoned';
        let answeredContent: AskUserAnsweredContent | null = null;
        if (!parsedResult) {
          // Result row not yet persisted; the chat-loop is in the
          // sub-second window between assistant-row write and
          // tool-row write. Skip the block until the row lands -
          // emitting a card with no backing row would make submit
          // operations target a non-existent tool_call_id.
          continue;
        }
        if (ASK_USER_PENDING_FLAG in parsedResult) {
          state = 'pending';
        } else {
          answeredContent = parsedResult;
          const via = parsedResult.via;
          if (via === 'option' || via === 'free_form') {
            state = 'answered';
          } else {
            state = 'abandoned';
          }
        }
        blocks.push({
          kind: 'ask-user',
          key: call.id,
          assistantId: m.id,
          state,
          question: args.question,
          options: args.options,
          answeredContent,
        });
      }
    } else {
      blocks.push({ kind: 'plain', message: m });
    }
  }
  return blocks;
}

/**
 * Walk backward through messages from the tail to find the most
 * recent role='user' message - the one that opened the currently-
 * suspended (or just-resumed) turn. Returns null if no user
 * message is present (cold thread), which means the resume cannot
 * proceed and the caller surfaces a warning.
 */
export function findOpeningUserMessageIdForTail(
  messages: readonly Message[]
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') return m.id;
  }
  return null;
}

/**
 * Chat-loop orchestrator - runs one user turn from submission through
 * to a final assistant answer. After the streaming-root migration the
 * round chain, tool dispatch, rate-limit retry, output-guard re-rolls,
 * and assistant-row persistence all live server-side inside the venice
 * edge function. This module's job shrinks to:
 *
 *   - Build the per-turn priming layers (samskara fire + compound,
 *     intuition, context recall) and stitch their synthetic `<think>`
 *     blocks into the history baton.
 *   - Assemble the three-layer system-prompt preamble (baseline +
 *     user-configured + per-turn metadata).
 *   - Issue a single `venice.streamChat` call with `streamCtx` pointed
 *     at this thread + anchor user message. The venice client routes
 *     through the /stream endpoint and yields the server-published
 *     event union.
 *   - Map each event onto the UI handler surface so the streaming
 *     bubble, reasoning panel, tool timings, rate-limit indicator,
 *     and slop-notice cards stay live during the turn.
 *   - At END, capture the persisted assistant row id + terminal kind,
 *     fire onAssistantPersisted with the canonical Message, and write
 *     the samskara substrate stub anchoring the (user message, last
 *     assistant) pair.
 *
 * Browser vs function ownership during a turn. The browser writes the
 * `role='user'` message row from the composer-send click before
 * `runChatLoop` runs - that row is browser-owned because its production
 * path is a single user click and "tab crash means user retypes." Once
 * `runChatLoop` calls `venice.streamChat`, the function takes over as
 * writer-of-record for everything that follows: assistant rows
 * (`commit_assistant_message`), `role='tool'` rows, `tool_calls`,
 * `threads.status` transitions, per-round generated-image attachments,
 * and `threads.last_error` on the terminal-error path. This module
 * persists nothing during the turn - it consumes events and updates the
 * UI. The full ownership frame (production-path-per-row, not
 * per-table) is in docs/dev/architecture.md under "Production-path
 * ownership"; the function-side perspective is in
 * supabase/functions/README.md.
 *
 * Cancellation: the caller's AbortSignal aborts the local stream
 * consumer (so the UI stops collecting events). The function-side
 * round chain is cancelled separately via a control-channel publish
 * (see `cancelStream` in venice.ts). Both fire from the stop button
 * so the function-side Venice call and the local UI tear down in
 * lock step.
 *
 * Turn-entry priming (the samskara/intuition/context-recall <think>
 * chain + the bias appendix) runs server-side now, in the venice edge
 * function's priming stage (supabase/functions/venice/priming.ts), so
 * it survives a browser disconnect along with the streaming loop; the
 * browser passes its inputs through `streamCtx.priming` and renders the
 * feedback off the priming events the server publishes. Sibling
 * modules, all under `./chat/`: `prompt-assembly.ts` (the pure
 * request-message builders), `stream-events.ts` (`consumeStreamEvents`,
 * the StreamEvent -> UI-handler mapper, including the priming events),
 * and `types.ts` (the option / result / handler contract). This file is
 * the conductor: assemble the request, issue the single `streamChat`
 * call, consume the stream, write the end-of-turn substrate stub,
 * return.
 */

import type { VeniceMessage } from '../venice';
import { buildToolList, buildToolCatalog } from '../tools';
import { buildSystemPrompt } from './system-prompt';
import { recordSubstrateStub } from '../samskara';
import { createLogger } from '../logger.svelte';
import { consumeStreamEvents } from './stream-events';
import { countUserRounds } from '../intuition';
import {
  buildMetadataSystemMessage,
  splitSystemPreamble,
} from './prompt-assembly';
import type { ChatLoopOptions, ChatLoopResult } from './types';

// `toVeniceMessage` (the stored-row -> wire projection) lives in
// ./prompt-assembly; re-exported here so its external consumers
// (Chat.svelte, tools/wire.ts, the wire test) keep importing it from
// `$lib/chat/loop`.
export { toVeniceMessage } from './prompt-assembly';

const log = createLogger('chat-loop');

export async function runChatLoop(opts: ChatLoopOptions): Promise<ChatLoopResult> {
  const {
    venice,
    supabase,
    thread,
    modelId,
    signal,
    handlers,
    reasoningEffort,
    disableThinking,
    verbosity,
    emphasisMarkdown,
    displayTimezone,
    lastAssistantTimestamp,
    userMessageId,
    supersededIds,
    userName,
    userLocation,
    intuitionModelId,
    intuitionMood,
    contextRecallEnabled,
    skipPriming,
    refinementDoubtNote,
    currentTurnHasAttachments,
  } = opts;
  // Copy so we can extend locally each round without mutating the caller.
  const history: VeniceMessage[] = [...opts.history];
  // Turn-entry snapshot of the thread's toolbox set. Shapes the first
  // round's wire `tools` array and the metadata state block. A mid-turn
  // toggle_toolbox lands server-side: the orchestrator rearms its own
  // tools array from the envelope's toolCatalog, and the browser's
  // thread row catches up via the realtime echo - nothing mutates this
  // snapshot. Returned to the caller for local state rehydration.
  const toolboxesEnabled: readonly string[] = thread.toolboxes_enabled;
  // Snapshot the user's connected MCP integrations as dynamic
  // toolboxes for this turn. Built once at turn entry from the
  // caller-supplied list (Chat.svelte computes it from app state via
  // buildMcpToolboxes) so every round in the multi-round tool chain
  // sees the same MCP catalog. A connect/disconnect mid-turn lands in
  // app state but doesn't re-render here - the next turn picks it up.
  const mcpToolboxes = opts.mcpToolboxes ?? [];
  let finalText = '';
  let roundsRun = 0;
  let stoppedByLimit = false;
  let interrupted = false;
  let conflictDetected = false;
  // Non-null when an ask_user tool call landed this turn and the
  // loop is suspending to wait for the user's answer. Returned to the
  // caller (Chat.svelte) so the UI can flip into "awaiting answer"
  // mode. See ChatLoopResult.awaitingUserAnswer for the contract on
  // what the caller does next.
  let awaitingUserAnswer: ChatLoopResult['awaitingUserAnswer'] = null;
  // Track the last assistant row we persisted across rounds. End-of-
  // turn samskara substrate writes pair the opening user message with
  // whichever assistant row closed the turn — final text or terminal
  // tool-using row, whichever the loop ends on.
  let lastAssistantId: string | null = null;

  // Turn-open metadata inputs. The samskara/context-recall/intuition
  // <think> chain and the bias appendix are assembled server-side in the
  // venice edge function's priming stage
  // (supabase/functions/venice/priming.ts), so the whole turn - priming
  // included - survives a browser disconnect. What remains browser-side
  // are the two deterministic inputs the metadata system message needs:
  // the user-round index and the thread-attachments inventory (neither
  // is LLM priming).
  const currentUserRound = countUserRounds(history);
  // Per-turn thread-attachments inventory. A single thread-scoped SELECT
  // feeding buildMetadataSystemMessage; failure is swallowed - the model
  // falls back to the per-message inline note from buildUserVeniceContent.
  const attachmentSummaries = await supabase
    .listAttachmentSummariesForThread(thread.id)
    .catch(() => []);

  // System-prompt assembly with the per-turn metadata pinned LAST.
  // The baseline prompt (identity, voice, recall framing, toolbox
  // catalog) leads; user-configured system prompts from Settings
  // ride next so a custom "you are a pirate" prompt still wins on
  // voice while the baseline tool framing stays in force; then the
  // whole conversation; then the per-turn metadata system message as
  // the final row, immediately before the model generates.
  //
  // Metadata rides at the tail for prompt-cache economics, not
  // reading order. Venice - like every OpenAI-compatible backend -
  // can only reuse a cached prefix that is byte-identical from token
  // 0, and this block carries a wall-clock timestamp that changes
  // every turn. Positioned ahead of the conversation (where it used
  // to sit) it pushed the first-differing byte to the top of the
  // transcript, so the entire history had to be re-encoded on every
  // turn and every tool round - the conversation never cached.
  // Pinned after the conversation, the stable baseline + user-system
  // + growing history form a cacheable prefix; only this small
  // trailing block falls outside the cache (along with the
  // regenerated <think> priming, which is volatile turn-to-turn
  // regardless). The timestamp is minute-granular (see
  // buildDatetimeParagraph) so multiple tool rounds inside the same
  // minute keep even this trailing block byte-stable.
  //
  // The gated-toolbox on/off state rides in this trailing metadata
  // block too (right after the datetime), NOT in the baseline catalog.
  // The catalog is state-free - it lists what toolboxes exist, not
  // which are enabled - so a toggle_toolbox flip mid-conversation
  // leaves the baseline byte-identical and only churns this trailing
  // block. Carried in the catalog (where it used to live) a toggle
  // shifted the first-differing byte back to the top of the baseline
  // and busted the whole prefix, the same failure the datetime move
  // fixed.
  //
  // Tradeoff accepted deliberately: the model reads ambient context
  // (datetime, toolbox state, attachments inventory, title and
  // emphasis nudges) AFTER its <think> priming chain rather than just
  // before the user turn, and the final wire row is role:system rather
  // than the intuition <think>. The user message still rides bare - no
  // `<user_message>` fence, no `<datetime>` tag, no
  // `<system_reminder>` directive; the role:user / role:system
  // boundary is the structural signal.
  //
  // The metadata message is built once per turn here. Multi-round
  // tool chains live entirely server-side, so the browser-side
  // wall-clock refresh between rounds the previous loop did is gone
  // (the server's getStreamingResponse round chain reuses the same
  // baton it was handed in the envelope POST). The title nudge
  // captures the title at turn entry; a mid-turn update_title call
  // lands in DB but doesn't re-render here - any next-turn priming
  // picks it up on its next user message.
  const { userSystem, conversation } = splitSystemPreamble(history);
  const metadataMessage = buildMetadataSystemMessage({
    userName,
    userLocation,
    displayTimezone,
    lastAssistantTimestamp,
    // Turn-entry snapshot of the gated-toolbox set. Rendered as the
    // on/off state block in the trailing metadata message rather than
    // in the baseline catalog, so a mid-conversation toggle_toolbox
    // flip only churns this block. Server-side tools may flip the set
    // mid-turn; the realtime echo updates the thread row asynchronously,
    // so this is the turn-entry value.
    enabledToolboxes: toolboxesEnabled,
    mcpToolboxes,
    attachmentSummaries,
    currentTurnHasAttachments: currentTurnHasAttachments ?? false,
    emphasisMarkdown,
    threadTitle: thread.title,
    titleManuallySet: thread.title_manually_set,
    currentUserRound,
  });
  const requestMessages: VeniceMessage[] = [
    {
      // Baseline system prompt only. The bias-profile appendix that
      // used to ride at the end here is appended server-side now, in
      // the edge function's priming stage, so the browser ships a
      // bias-free baseline and the orchestrator renders + appends the
      // block before the first round.
      role: 'system',
      content: buildSystemPrompt(mcpToolboxes),
    },
    ...userSystem,
    ...conversation,
    metadataMessage,
  ];

  // The exact message array the browser hands to Venice for this turn's
  // opening round, dumped at debug so it never clutters the default
  // drawer but is one filter-drop away when a turn answers the wrong
  // thing. This is the browser's view of the wire only - it does NOT
  // include the priming <think> chain (context-recall, samskara,
  // intuition) or the bias appendix, which the edge function's priming
  // stage splices in server-side after this POST. To see what a stale or
  // misfired prime actually put on the wire, read the priming stage's
  // logs (source intuition / context-recall) rather than this line.
  log.debug('venice request wire', {
    round: currentUserRound,
    model: modelId,
    messageCount: requestMessages.length,
    messages: requestMessages,
  });

  const consumed = await consumeStreamEvents({
    events: venice.streamChat({
      model: modelId,
      messages: requestMessages,
      signal,
      tools: buildToolList(toolboxesEnabled, mcpToolboxes),
      // Full catalog for the server-side round chain: lets it rearm
      // `tools` mid-turn when the model enables a toolbox, instead of
      // the new box's schemas staying undeclared until the next turn.
      toolCatalog: buildToolCatalog(mcpToolboxes),
      reasoningEffort,
      disableThinking,
      verbosity,
      // Priming inputs ride to the server's priming stage, which runs
      // the samskara/context-recall/intuition pipelines and the bias
      // appendix before the first round. The pipelines run server-side
      // so the whole turn (priming included) survives a browser
      // disconnect; the browser only forwards their inputs.
      streamCtx: {
        threadId: thread.id,
        userMessageId,
        supersededIds,
        priming: { intuitionModelId, intuitionMood, contextRecallEnabled, skipPriming, refinementDoubtNote },
      },
    }),
    signal,
    supabase,
    handlers,
  });
  interrupted = consumed.interrupted;
  conflictDetected = consumed.conflictDetected;
  stoppedByLimit = consumed.stoppedByLimit;
  awaitingUserAnswer = consumed.awaitingUserAnswer;
  lastAssistantId = consumed.lastAssistantId;
  finalText = consumed.finalText;
  roundsRun = consumed.roundsRun;

  // Samskara substrate stub. Written once per turn after the loop
  // settles, paired with whichever assistant row closed the turn.
  // Fire-and-forget: a substrate write failure is logged inside
  // `recordSubstrateStub` but not surfaced — the formation pipeline
  // simply has fewer rows to work from until the next round writes
  // successfully. Skipped when the caller didn't supply
  // userMessageId (older callers, tests) or when no assistant row
  // landed at all (early abort, error path). Also skipped when the
  // loop is suspended on an ask_user pending answer - the turn is
  // not logically complete, the formation pipeline shouldn't see a
  // half-finished round, and the next runChatLoop call (post-answer)
  // will re-enter this path with the same userMessageId and write
  // the stub then.
  if (
    userMessageId &&
    lastAssistantId !== null &&
    awaitingUserAnswer === null
  ) {
    void recordSubstrateStub(supabase, thread.id, userMessageId, lastAssistantId);
  }

  return {
    finalText,
    roundsRun,
    stoppedByLimit,
    interrupted,
    conflictDetected,
    toolboxesEnabled,
    awaitingUserAnswer,
  };
}

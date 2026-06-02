/**
 * Deep-sleep agent. Receives a similarity-clustered batch of
 * memories (seed + top-k neighbors above the threshold) and decides
 * for each pair whether to consolidate, relate, or leave alone. The
 * tool calls it makes ARE the persistent output; the model's final
 * text is the operator-facing summary the loop surfaces in the log
 * drawer.
 *
 * Pure logic - no leases, no claims, no lifecycle. Those live in
 * `./loop.ts` and `./worker.ts`. Same separation as the wiki
 * librarian and reflection agents.
 */
import type { Agent, AgentRunRequest, AgentRunResult } from '../types';
import type { SupabaseService } from '../../supabase';
import type { VeniceClient, VeniceMessage } from '../../venice';
import { memoryLibrarianToolbox } from '../../tools/memory_librarian_toolbox';
import { runHeadlessToolLoop, type HeadlessToolLoopEvent } from '../../tools/run';
import { agentModel } from '../../models';
import { createLogger } from '../../logger.svelte';
import { classifyMemoryConfidence } from '../../memories';
import { buildDeepSleepPrompt } from './prompt';
import type { DeepSleepInput, DeepSleepOutput, DeepSleepMemoryRow } from './types';

const log = createLogger('deep-sleep-worker');

/**
 * Render the batch into the bullet list the prompt embeds. Each row
 * is "[score] (confidence_tag conf=N.NN) `label` - data" so the
 * agent can scan vertically and compare scores against text. The
 * seed appears with score 1.0 and a leading "SEED" marker so the
 * agent knows which row anchored the batch.
 */
function renderBatchList(batch: ReadonlyArray<DeepSleepMemoryRow>): string {
  if (batch.length === 0) return '(empty batch)';
  return batch
    .map((row, idx) => {
      const tag = classifyMemoryConfidence(row.confidence);
      const tagFragment = tag ? `${tag} ` : '';
      const scoreFragment = idx === 0 ? 'SEED' : row.score.toFixed(2);
      const labelFragment = row.label.replace(/\s+/g, ' ').trim();
      const dataFragment = row.data.replace(/\s+/g, ' ').trim();
      return (
        `- [${scoreFragment}] (${tagFragment}conf=${row.confidence.toFixed(2)}, id=${row.id}) ` +
        `\`${labelFragment}\` - ${dataFragment}`
      );
    })
    .join('\n');
}

export class DeepSleepAgent implements Agent<DeepSleepInput, DeepSleepOutput> {
  readonly name = 'deep-sleep';
  readonly model: string;
  readonly toolbox = memoryLibrarianToolbox;

  /**
   * Optional live-progress listener. Set by the main-thread manual
   * runner so the Memories UI can show a step list while the loop
   * runs. The scheduled worker leaves this null - functions don't
   * cross the worker postMessage boundary, and the log drawer is the
   * worker's feedback surface.
   */
  private onProgress: ((event: HeadlessToolLoopEvent) => void) | null = null;

  constructor(
    private venice: VeniceClient,
    private supabase: SupabaseService,
    /**
     * Optional model override. Defaults to the registry's
     * `deepSleep` slot. Useful for tests that pin a specific id.
     */
    modelId?: string
  ) {
    this.model = modelId ?? agentModel('deepSleep').id;
  }

  setProgressListener(
    listener: ((event: HeadlessToolLoopEvent) => void) | null
  ): void {
    this.onProgress = listener;
  }

  async run(
    req: AgentRunRequest<DeepSleepInput>
  ): Promise<AgentRunResult<DeepSleepOutput>> {
    const signal = req.signal ?? new AbortController().signal;
    const batch = req.input.batch;

    if (signal.aborted) {
      return {
        output: { finalText: '', batchSize: 0 },
        toolCalls: 0,
        stoppedReason: 'aborted',
      };
    }

    try {
      const batchList = renderBatchList(batch);
      const promptText = buildDeepSleepPrompt({
        batchList,
        batchSize: batch.length,
      });

      log.info(
        `deep-sleep reviewing batch of ${batch.length} memor${batch.length === 1 ? 'y' : 'ies'}`
      );

      const messages: VeniceMessage[] = [
        { role: 'system', content: promptText },
      ];

      const result = await runHeadlessToolLoop({
        model: this.model,
        messages,
        toolbox: this.toolbox,
        toolCtx: {
          supabase: this.supabase,
          venice: this.venice,
          userId: req.userId,
          // Librarians are not thread-scoped. Pass empty string to
          // satisfy the ToolContext shape; the memory and
          // conversation_search tools both ignore threadId (RLS
          // already scopes to user).
          threadId: '',
        },
        signal,
        reasoningEffort: 'low',
        onProgress: this.onProgress ?? undefined,
      });

      return {
        output: {
          finalText: result.finalText,
          batchSize: batch.length,
        },
        toolCalls: result.toolCalls,
        stoppedReason: signal.aborted ? 'aborted' : 'done',
      };
    } catch (err) {
      return {
        output: { finalText: '', batchSize: batch.length },
        toolCalls: 0,
        stoppedReason: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

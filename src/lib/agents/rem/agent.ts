/**
 * Rem (associative integration) agent. Receives a batch of memories
 * that were referenced together during recall on one conversation
 * and decides whether the relations graph captures the relationships
 * the user's behavior implies. The tool calls it makes ARE the
 * persistent output; the model's final text is the operator-facing
 * summary the loop surfaces in the log drawer.
 */
import type { Agent, AgentRunRequest, AgentRunResult } from '../types';
import type { SupabaseService } from '../../supabase';
import type { VeniceClient, VeniceMessage } from '../../venice';
import { memoryLibrarianToolbox } from '../../tools/memory_librarian_toolbox';
import { runHeadlessToolLoop, type HeadlessToolLoopEvent } from '../../tools/run';
import { agentModel } from '../../models';
import { createLogger } from '../../logger.svelte';
import { classifyMemoryConfidence } from '../../memories';
import { buildRemPrompt } from './prompt';
import type { RemInput, RemMemoryRow, RemOutput } from './types';

const log = createLogger('rem-worker');

function renderBatchList(batch: ReadonlyArray<RemMemoryRow>): string {
  if (batch.length === 0) return '(empty batch)';
  return batch
    .map((row) => {
      const tag = classifyMemoryConfidence(row.confidence);
      const tagFragment = tag ? `${tag} ` : '';
      const labelFragment = row.label.replace(/\s+/g, ' ').trim();
      const dataFragment = row.data.replace(/\s+/g, ' ').trim();
      return (
        `- (${tagFragment}conf=${row.confidence.toFixed(2)}, id=${row.id}) ` +
        `\`${labelFragment}\` - ${dataFragment}`
      );
    })
    .join('\n');
}

export class RemAgent implements Agent<RemInput, RemOutput> {
  readonly name = 'rem';
  readonly model: string;
  readonly toolbox = memoryLibrarianToolbox;

  private onProgress: ((event: HeadlessToolLoopEvent) => void) | null = null;

  constructor(
    private venice: VeniceClient,
    private supabase: SupabaseService,
    modelId?: string
  ) {
    this.model = modelId ?? agentModel('rem').id;
  }

  setProgressListener(
    listener: ((event: HeadlessToolLoopEvent) => void) | null
  ): void {
    this.onProgress = listener;
  }

  async run(
    req: AgentRunRequest<RemInput>
  ): Promise<AgentRunResult<RemOutput>> {
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
      const promptText = buildRemPrompt({ batchList, batchSize: batch.length });

      log.info(
        `rem reviewing batch of ${batch.length} memor${batch.length === 1 ? 'y' : 'ies'} ` +
          `from conversation ${req.input.conversationId}`
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

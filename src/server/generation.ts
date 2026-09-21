/**
 * Generation logic - runs LLM provider and appends run events to the log.
 * Decoupled from connections. Updates Run record as it progresses.
 */

import type { LLMProvider } from './llm/provider.js';
import type { ConversationService } from './conversation-service.js';

export class GenerationEngine {
  private provider: LLMProvider;
  private service: ConversationService;

  constructor(provider: LLMProvider, service: ConversationService) {
    this.provider = provider;
    this.service = service;
  }

  /**
   * Generate a response for a user message.
   * Appends run_started, text_chunk..., and run_completed (or run_failed).
   * Runs asynchronously and does not block.
   */
  async generate(conversationId: string, runId: string, prompt: string): Promise<void> {
    try {
      // Append run_started
      const startEvent = await this.service.append(conversationId, 'run_started', runId, {});

      let accumulatedText = '';

      // Stream chunks
      const generator = this.provider.generate(prompt);
      for await (const chunk of generator) {
        const chunkEvent = await this.service.append(conversationId, 'text_chunk', runId, {
          text: chunk,
        });

        accumulatedText += chunk;

        // Update Run record with new text and lastSeq
        await this.service.updateRun(conversationId, runId, {
          text: accumulatedText,
          lastSeq: chunkEvent.seq,
        });
      }

      // Append run_completed
      const endEvent = await this.service.append(conversationId, 'run_completed', runId, {});

      // Final Run update
      await this.service.updateRun(conversationId, runId, {
        status: 'completed',
        lastSeq: endEvent.seq,
      });
    } catch (error) {
      // Append run_failed
      const reason = error instanceof Error && error.message.includes('Simulated') 
        ? 'generator_error' 
        : 'generator_error';
        
      const errorEvent = await this.service.append(conversationId, 'run_failed', runId, {
        reason: reason as 'generator_error' | 'interrupted',
      });

      // Update Run to failed
      await this.service.updateRun(conversationId, runId, {
        status: 'failed',
        failureReason: reason as 'generator_error' | 'interrupted',
        lastSeq: errorEvent.seq,
      });
    }
  }
}

/**
 * Recovery logic for server restart.
 * Scans all conversations and marks any running runs as failed/interrupted.
 */
export async function recoverInterruptedRuns(
  service: ConversationService,
  store: { listConversations(): Promise<string[]>; listRuns(id: string): Promise<any[]> }
): Promise<void> {
  const conversations = await store.listConversations();

  for (const conversationId of conversations) {
    const runs = await store.listRuns(conversationId);

    for (const run of runs) {
      if (run.status === 'running') {
        // Mark as failed/interrupted
        await service.append(conversationId, 'run_failed', run.runId, {
          reason: 'interrupted',
        });

        await service.updateRun(conversationId, run.runId, {
          status: 'failed',
          failureReason: 'interrupted',
        });
      }
    }
  }
}

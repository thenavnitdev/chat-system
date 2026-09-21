/**
 * ConversationStore interface - abstraction for event persistence.
 * Implementations: MemoryStore (tests), FileStore (production).
 */

import type { ConversationEvent, Run } from '../../shared/protocol.js';

export interface ConversationStore {
  /**
   * Append a new event to the conversation log.
   * The store is responsible for persisting it.
   */
  append(event: ConversationEvent): Promise<void>;

  /**
   * Read all events from a conversation after a given seq.
   * Returns events in seq order.
   * If earliestSeq is set (retention), events before earliestSeq may not be available.
   */
  readFrom(conversationId: string, afterSeq: number): Promise<ConversationEvent[]>;

  /**
   * Get the highest seq number for a conversation, or 0 if empty.
   */
  head(conversationId: string): Promise<number>;

  /**
   * Get the earliest available seq (for retention).
   * Returns 1 if no retention, or max(1, head - RETENTION_MAX_EVENTS + 1).
   */
  earliestSeq(conversationId: string): Promise<number>;

  /**
   * Find the runId for a userMessageId in a conversation.
   * Returns undefined if not found.
   */
  findRunByUserMessageId(
    conversationId: string,
    userMessageId: string
  ): Promise<string | undefined>;

  /**
   * Get a Run record by runId.
   */
  getRun(conversationId: string, runId: string): Promise<Run | undefined>;

  /**
   * Save or update a Run record.
   */
  saveRun(run: Run): Promise<void>;

  /**
   * List all Run records for a conversation (for snapshot building).
   */
  listRuns(conversationId: string): Promise<Run[]>;

  /**
   * List all conversation IDs that have at least one event.
   */
  listConversations(): Promise<string[]>;
}

/**
 * ConversationService - core business logic for managing conversations.
 * Handles event appending with seq assignment, Run state management, and subscriptions.
 */

import type { ConversationEvent, Run, RunStatus } from '../shared/protocol.js';
import type { ConversationStore } from './store/store.js';

type EventListener = (event: ConversationEvent) => void;

export class ConversationService {
  private store: ConversationStore;

  // Per-conversation sequence counters (cached from store head on first use)
  private seqCounters: Map<string, number> = new Map();

  // Per-conversation append queues to ensure sequential seq assignment under concurrency
  private appendQueues: Map<string, Promise<ConversationEvent>> = new Map();

  // Per-conversation submit queues to ensure idempotency check is serialized
  private submitQueues: Map<string, Promise<{ runId: string; duplicate: boolean; seq: number }>> = new Map();

  // Event subscriptions: conversationId -> Set<listener>
  private subscriptions: Map<string, Set<EventListener>> = new Map();

  constructor(store: ConversationStore) {
    this.store = store;
  }

  /**
   * Append an event to the conversation log.
   * Assigns the next seq and notifies subscribers.
   * Thread-safe: parallel calls yield consecutive seq values.
   * 
   * Enforces state machine: rejects events for runs already in terminal state.
   */
  async append(
    conversationId: string,
    type: ConversationEvent['type'],
    runId: string,
    payload: ConversationEvent['payload']
  ): Promise<ConversationEvent> {
    // Check if run is in terminal state (AC5)
    if (type === 'text_chunk' || type === 'run_completed') {
      const run = await this.store.getRun(conversationId, runId);
      if (run && (run.status === 'completed' || run.status === 'failed')) {
        throw new Error(
          `Cannot append ${type} for run ${runId}: run is already ${run.status}`
        );
      }
    }

    // Chain appends per conversation
    const prevAppend = this.appendQueues.get(conversationId) || Promise.resolve({} as ConversationEvent);

    const appendPromise = prevAppend.then(async () => {
      // Initialize seq counter if needed
      if (!this.seqCounters.has(conversationId)) {
        const head = await this.store.head(conversationId);
        this.seqCounters.set(conversationId, head);
      }

      // Assign next seq
      const currentSeq = this.seqCounters.get(conversationId)!;
      const nextSeq = currentSeq + 1;
      this.seqCounters.set(conversationId, nextSeq);

      // Build event
      const event: ConversationEvent = {
        conversationId,
        seq: nextSeq,
        type,
        runId,
        payload,
        createdAt: new Date().toISOString(),
      } as ConversationEvent;

      // Persist
      await this.store.append(event);

      // Notify subscribers
      this.notifySubscribers(conversationId, event);

      return event;
    });

    this.appendQueues.set(conversationId, appendPromise);
    return appendPromise;
  }

  /**
   * Submit a user message with idempotency.
   * Returns { runId, duplicate, seq }.
   * Checks for run_in_progress before starting new run.
   */
  async submitUserMessage(
    conversationId: string,
    userMessageId: string,
    text: string
  ): Promise<{ runId: string; duplicate: boolean; seq: number }> {
    // Chain submits per conversation to avoid race condition in duplicate check
    const prevSubmit = this.submitQueues.get(conversationId) || Promise.resolve({} as any);

    const submitPromise = prevSubmit.then(async () => {
      // Check for duplicate (idempotency)
      const existingRunId = await this.store.findRunByUserMessageId(
        conversationId,
        userMessageId
      );

      if (existingRunId) {
        const run = await this.store.getRun(conversationId, existingRunId);
        return { runId: existingRunId, duplicate: true, seq: run!.firstSeq };
      }

      // Check if there's already a running run
      const allRuns = await this.store.listRuns(conversationId);
      const runningRun = allRuns.find(r => r.status === 'running');
      if (runningRun) {
        throw new Error('run_in_progress');
      }

      // New message: create runId and append user_message event
      const runId = `run-${userMessageId}`;
      const event = await this.append(conversationId, 'user_message', runId, {
        userMessageId,
        text,
      });

      // Create Run record
      const run: Run = {
        runId,
        conversationId,
        userMessageId,
        status: 'running',
        firstSeq: event.seq,
        lastSeq: event.seq,
        text: '',
      };
      await this.store.saveRun(run);

      return { runId, duplicate: false, seq: event.seq };
    });

    this.submitQueues.set(conversationId, submitPromise);
    return submitPromise;
  }

  /**
   * Update a Run record (called by generation to update text and status).
   */
  async updateRun(
    conversationId: string,
    runId: string,
    updates: Partial<Run>
  ): Promise<void> {
    const run = await this.store.getRun(conversationId, runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }

    const updated: Run = { ...run, ...updates };
    await this.store.saveRun(updated);
  }

  /**
   * Subscribe to new events for a conversation.
   * Returns an unsubscribe function.
   */
  subscribe(conversationId: string, listener: EventListener): () => void {
    if (!this.subscriptions.has(conversationId)) {
      this.subscriptions.set(conversationId, new Set());
    }
    this.subscriptions.get(conversationId)!.add(listener);

    return () => {
      this.subscriptions.get(conversationId)?.delete(listener);
    };
  }

  /**
   * Replay events from the store after a given seq.
   */
  async replay(conversationId: string, afterSeq: number): Promise<ConversationEvent[]> {
    return this.store.readFrom(conversationId, afterSeq);
  }

  /**
   * Get the current head seq for a conversation.
   */
  async head(conversationId: string): Promise<number> {
    return this.store.head(conversationId);
  }

  /**
   * Get the earliest available seq (for lastSeq validation).
   */
  async earliestSeq(conversationId: string): Promise<number> {
    return this.store.earliestSeq(conversationId);
  }

  private notifySubscribers(conversationId: string, event: ConversationEvent): void {
    const listeners = this.subscriptions.get(conversationId);
    if (listeners) {
      for (const listener of listeners) {
        // Call listener asynchronously to avoid blocking append
        setImmediate(() => listener(event));
      }
    }
  }
}

/**
 * In-memory implementation of ConversationStore for tests.
 * All data is lost when the process exits.
 */

import type { ConversationEvent, Run } from '../../shared/protocol.js';
import type { ConversationStore } from './store.js';

export class MemoryStore implements ConversationStore {
  // conversationId -> array of events in seq order
  private events: Map<string, ConversationEvent[]> = new Map();

  // conversationId -> userMessageId -> runId
  private userMessageIdIndex: Map<string, Map<string, string>> = new Map();

  // conversationId -> runId -> Run
  private runs: Map<string, Map<string, Run>> = new Map();

  async append(event: ConversationEvent): Promise<void> {
    const { conversationId } = event;

    if (!this.events.has(conversationId)) {
      this.events.set(conversationId, []);
    }
    this.events.get(conversationId)!.push(event);

    // Index userMessageId for user_message events
    if (event.type === 'user_message') {
      if (!this.userMessageIdIndex.has(conversationId)) {
        this.userMessageIdIndex.set(conversationId, new Map());
      }
      this.userMessageIdIndex
        .get(conversationId)!
        .set(event.payload.userMessageId, event.runId);
    }
  }

  async readFrom(
    conversationId: string,
    afterSeq: number
  ): Promise<ConversationEvent[]> {
    const events = this.events.get(conversationId) || [];
    return events.filter((e) => e.seq > afterSeq);
  }

  async head(conversationId: string): Promise<number> {
    const events = this.events.get(conversationId) || [];
    if (events.length === 0) return 0;
    return events[events.length - 1].seq;
  }

  async earliestSeq(conversationId: string): Promise<number> {
    // MemoryStore keeps everything, so earliest is always 1
    const events = this.events.get(conversationId) || [];
    return events.length === 0 ? 1 : 1;
  }

  async findRunByUserMessageId(
    conversationId: string,
    userMessageId: string
  ): Promise<string | undefined> {
    return this.userMessageIdIndex.get(conversationId)?.get(userMessageId);
  }

  async getRun(conversationId: string, runId: string): Promise<Run | undefined> {
    return this.runs.get(conversationId)?.get(runId);
  }

  async saveRun(run: Run): Promise<void> {
    const { conversationId, runId } = run;
    if (!this.runs.has(conversationId)) {
      this.runs.set(conversationId, new Map());
    }
    this.runs.get(conversationId)!.set(runId, run);
  }

  async listRuns(conversationId: string): Promise<Run[]> {
    const conversationRuns = this.runs.get(conversationId);
    if (!conversationRuns) return [];
    return Array.from(conversationRuns.values());
  }

  async listConversations(): Promise<string[]> {
    return Array.from(this.events.keys());
  }
}

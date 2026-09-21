/**
 * File-based implementation of ConversationStore.
 * Each conversation is stored as an append-only JSONL file.
 * On startup, files are read to rebuild in-memory indexes.
 */

import fs from 'fs/promises';
import path from 'path';
import type { ConversationEvent, Run } from '../../shared/protocol.js';
import type { ConversationStore } from './store.js';

export class FileStore implements ConversationStore {
  private dataDir: string;

  // In-memory indexes rebuilt on load
  private heads: Map<string, number> = new Map();
  private userMessageIdIndex: Map<string, Map<string, string>> = new Map();
  private runs: Map<string, Map<string, Run>> = new Map();

  // Per-conversation append locks (simple promise chain)
  private appendLocks: Map<string, Promise<void>> = new Map();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * Load all conversation files and rebuild indexes.
   */
  async load(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });

    const files = await fs.readdir(this.dataDir);
    for (const file of files) {
      if (file.endsWith('.jsonl') && !file.endsWith('-runs.jsonl')) {
        const conversationId = file.replace('.jsonl', '');
        const filePath = this.getEventFilePath(conversationId);
        const content = await fs.readFile(filePath, 'utf-8');

        const lines = content.trim().split('\n').filter(Boolean);
        for (const line of lines) {
          const event: ConversationEvent = JSON.parse(line);

          // Update head
          const currentHead = this.heads.get(conversationId) || 0;
          if (event.seq > currentHead) {
            this.heads.set(conversationId, event.seq);
          }

          // Index userMessageId
          if (event.type === 'user_message') {
            if (!this.userMessageIdIndex.has(conversationId)) {
              this.userMessageIdIndex.set(conversationId, new Map());
            }
            this.userMessageIdIndex
              .get(conversationId)!
              .set(event.payload.userMessageId, event.runId);
          }
        }
      } else if (file.endsWith('-runs.jsonl')) {
        const conversationId = file.replace('-runs.jsonl', '');
        const filePath = this.getRunsFilePath(conversationId);
        const content = await fs.readFile(filePath, 'utf-8');

        const lines = content.trim().split('\n').filter(Boolean);
        for (const line of lines) {
          const run: Run = JSON.parse(line);
          if (!this.runs.has(conversationId)) {
            this.runs.set(conversationId, new Map());
          }
          this.runs.get(conversationId)!.set(run.runId, run);
        }
      }
    }
  }

  async append(event: ConversationEvent): Promise<void> {
    const { conversationId } = event;

    // Chain appends per conversation to ensure ordering even under concurrency
    const prevLock = this.appendLocks.get(conversationId) || Promise.resolve();
    const newLock = prevLock.then(async () => {
      const filePath = this.getEventFilePath(conversationId);
      const line = JSON.stringify(event) + '\n';
      await fs.appendFile(filePath, line, 'utf-8');

      // Update in-memory indexes
      const currentHead = this.heads.get(conversationId) || 0;
      if (event.seq > currentHead) {
        this.heads.set(conversationId, event.seq);
      }

      if (event.type === 'user_message') {
        if (!this.userMessageIdIndex.has(conversationId)) {
          this.userMessageIdIndex.set(conversationId, new Map());
        }
        this.userMessageIdIndex
          .get(conversationId)!
          .set(event.payload.userMessageId, event.runId);
      }
    });

    this.appendLocks.set(conversationId, newLock);
    await newLock;
  }

  async readFrom(
    conversationId: string,
    afterSeq: number
  ): Promise<ConversationEvent[]> {
    const filePath = this.getEventFilePath(conversationId);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      const events: ConversationEvent[] = [];
      for (const line of lines) {
        const event: ConversationEvent = JSON.parse(line);
        if (event.seq > afterSeq) {
          events.push(event);
        }
      }
      return events;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  async head(conversationId: string): Promise<number> {
    return this.heads.get(conversationId) || 0;
  }

  async earliestSeq(conversationId: string): Promise<number> {
    // FileStore keeps everything by default (no retention)
    const head = await this.head(conversationId);
    return head === 0 ? 1 : 1;
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

    // Update in-memory
    if (!this.runs.has(conversationId)) {
      this.runs.set(conversationId, new Map());
    }
    this.runs.get(conversationId)!.set(runId, run);

    // Ensure directory exists
    await fs.mkdir(this.dataDir, { recursive: true });

    // Persist to file (overwrite all runs for this conversation)
    const filePath = this.getRunsFilePath(conversationId);
    const allRuns = await this.listRuns(conversationId);
    const lines = allRuns.map(r => JSON.stringify(r)).join('\n') + '\n';
    await fs.writeFile(filePath, lines, 'utf-8');
  }

  async listRuns(conversationId: string): Promise<Run[]> {
    const conversationRuns = this.runs.get(conversationId);
    if (!conversationRuns) return [];
    return Array.from(conversationRuns.values());
  }

  async listConversations(): Promise<string[]> {
    return Array.from(this.heads.keys());
  }

  private getEventFilePath(conversationId: string): string {
    // Simple filename sanitation
    const safe = conversationId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dataDir, `${safe}.jsonl`);
  }

  private getRunsFilePath(conversationId: string): string {
    const safe = conversationId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dataDir, `${safe}-runs.jsonl`);
  }
}

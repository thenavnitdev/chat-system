/**
 * Tests for ConversationStore implementations and ConversationService.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { MemoryStore } from '../server/store/memory-store.js';
import { FileStore } from '../server/store/file-store.js';
import { ConversationService } from '../server/conversation-service.js';
import type { ConversationEvent, Run } from '../shared/protocol.js';

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  it('should append and read events in order', async () => {
    const event1: ConversationEvent = {
      conversationId: 'c1',
      seq: 1,
      type: 'user_message',
      runId: 'run-msg1',
      payload: { text: 'hello', userMessageId: 'msg1' },
      createdAt: new Date().toISOString(),
    };

    const event2: ConversationEvent = {
      conversationId: 'c1',
      seq: 2,
      type: 'run_started',
      runId: 'run-msg1',
      payload: {},
      createdAt: new Date().toISOString(),
    };

    await store.append(event1);
    await store.append(event2);

    const events = await store.readFrom('c1', 0);
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(2);
  });

  it('should return correct head seq', async () => {
    expect(await store.head('c1')).toBe(0);

    const event: ConversationEvent = {
      conversationId: 'c1',
      seq: 5,
      type: 'user_message',
      runId: 'run-msg1',
      payload: { text: 'hello', userMessageId: 'msg1' },
      createdAt: new Date().toISOString(),
    };

    await store.append(event);
    expect(await store.head('c1')).toBe(5);
  });

  it('should find runId by userMessageId', async () => {
    const event: ConversationEvent = {
      conversationId: 'c1',
      seq: 3,
      type: 'user_message',
      runId: 'run-msg1',
      payload: { text: 'hello', userMessageId: 'msg1' },
      createdAt: new Date().toISOString(),
    };

    await store.append(event);
    const runId = await store.findRunByUserMessageId('c1', 'msg1');
    expect(runId).toBe('run-msg1');
  });

  it('should handle Run records', async () => {
    const run: Run = {
      runId: 'run-msg1',
      conversationId: 'c1',
      userMessageId: 'msg1',
      status: 'running',
      firstSeq: 1,
      lastSeq: 2,
      text: 'hello',
    };

    await store.saveRun(run);
    const retrieved = await store.getRun('c1', 'run-msg1');
    expect(retrieved).toEqual(run);

    const runs = await store.listRuns('c1');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual(run);
  });

  it('should list conversations', async () => {
    const event1: ConversationEvent = {
      conversationId: 'c1',
      seq: 1,
      type: 'user_message',
      runId: 'run-msg1',
      payload: { text: 'hello', userMessageId: 'msg1' },
      createdAt: new Date().toISOString(),
    };

    const event2: ConversationEvent = {
      conversationId: 'c2',
      seq: 1,
      type: 'user_message',
      runId: 'run-msg2',
      payload: { text: 'hi', userMessageId: 'msg2' },
      createdAt: new Date().toISOString(),
    };

    await store.append(event1);
    await store.append(event2);

    const conversations = await store.listConversations();
    expect(conversations.sort()).toEqual(['c1', 'c2']);
  });
});

describe('FileStore', () => {
  let store: FileStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(process.cwd(), `.test-data-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    store = new FileStore(tempDir);
    await store.load();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (err) {
      // ignore
    }
  });

  it('should persist events to disk', async () => {
    const event: ConversationEvent = {
      conversationId: 'c1',
      seq: 1,
      type: 'user_message',
      runId: 'run-msg1',
      payload: { text: 'hello', userMessageId: 'msg1' },
      createdAt: new Date().toISOString(),
    };

    await store.append(event);

    // Create new store instance to test persistence
    const store2 = new FileStore(tempDir);
    await store2.load();

    const events = await store2.readFrom('c1', 0);
    expect(events).toHaveLength(1);
    expect(events[0].seq).toBe(1);
  });

  it('should persist Run records', async () => {
    const run: Run = {
      runId: 'run-msg1',
      conversationId: 'c1',
      userMessageId: 'msg1',
      status: 'completed',
      firstSeq: 1,
      lastSeq: 5,
      text: 'Hello world',
    };

    await store.saveRun(run);

    // Create new store instance to test persistence
    const store2 = new FileStore(tempDir);
    await store2.load();

    const retrieved = await store2.getRun('c1', 'run-msg1');
    expect(retrieved).toEqual(run);
  });
});

describe('ConversationService', () => {
  let service: ConversationService;
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
    service = new ConversationService(store);
  });

  it('should assign sequential seq numbers', async () => {
    const result1 = await service.submitUserMessage('c1', 'msg1', 'hello');
    
    // Complete the first run so we can submit another
    const run1 = await store.getRun('c1', result1.runId);
    if (run1) {
      run1.status = 'completed';
      await store.saveRun(run1);
    }
    
    const result2 = await service.submitUserMessage('c1', 'msg2', 'world');

    expect(result1.seq).toBe(1);
    expect(result2.seq).toBe(2);
    expect(result1.runId).toBe('run-msg1');
    expect(result2.runId).toBe('run-msg2');
  });

  it('should handle duplicate userMessageId (idempotency)', async () => {
    const result1 = await service.submitUserMessage('c1', 'msg1', 'hello');
    const result2 = await service.submitUserMessage('c1', 'msg1', 'hello');

    expect(result1.duplicate).toBe(false);
    expect(result2.duplicate).toBe(true);
    expect(result1.runId).toBe(result2.runId);
    expect(result1.seq).toBe(result2.seq);

    const events = await store.readFrom('c1', 0);
    expect(events).toHaveLength(1); // Only one event created
  });

  it('should replay events from lastSeq', async () => {
    const r1 = await service.submitUserMessage('c1', 'msg1', 'one');
    // Complete run 1
    const run1 = await store.getRun('c1', r1.runId);
    if (run1) {
      run1.status = 'completed';
      await store.saveRun(run1);
    }
    
    const r2 = await service.submitUserMessage('c1', 'msg2', 'two');
    // Complete run 2
    const run2 = await store.getRun('c1', r2.runId);
    if (run2) {
      run2.status = 'completed';
      await store.saveRun(run2);
    }
    
    const r3 = await service.submitUserMessage('c1', 'msg3', 'three');

    const replayed = await service.replay('c1', 1);
    expect(replayed).toHaveLength(2);
    expect(replayed[0].seq).toBe(2);
    expect(replayed[1].seq).toBe(3);
  });

  it('should notify subscribers of new events', async () => {
    const events: ConversationEvent[] = [];
    service.subscribe('c1', (event) => {
      events.push(event);
    });

    await service.submitUserMessage('c1', 'msg1', 'hello');

    // Wait for async notification to fire (setImmediate in notifySubscribers)
    await new Promise(resolve => setImmediate(resolve));

    // submitUserMessage only appends user_message event
    // The subscriber should have been notified
    expect(events.length).toBeGreaterThan(0);
    const userMsgEvents = events.filter(e => e.type === 'user_message');
    expect(userMsgEvents).toHaveLength(1);
    expect(userMsgEvents[0].type).toBe('user_message');
  });
});

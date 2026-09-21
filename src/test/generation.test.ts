/**
 * Tests for LLM provider and generation engine.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeProvider } from '../server/llm/fake-provider.js';
import { GenerationEngine, recoverInterruptedRuns } from '../server/generation.js';
import { ConversationService } from '../server/conversation-service.js';
import { MemoryStore } from '../server/store/memory-store.js';

describe('FakeProvider', () => {
  it('should stream deterministic reply', async () => {
    const provider = new FakeProvider(10);
    const chunks: string[] = [];

    const generator = provider.generate('hello world');
    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('')).toContain('Sure');
  });

  it('should throw mid-stream for [fail] prompt', async () => {
    const provider = new FakeProvider(10);

    const generator = provider.generate('please [fail] now');
    const chunks: string[] = [];

    await expect(async () => {
      for await (const chunk of generator) {
        chunks.push(chunk);
      }
    }).rejects.toThrow('Simulated provider failure');

    // Should have received some chunks before failure
    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe('GenerationEngine', () => {
  let service: ConversationService;
  let engine: GenerationEngine;
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
    service = new ConversationService(store);
    const provider = new FakeProvider(10);
    engine = new GenerationEngine(provider, service);
  });

  it('should append run_started, text_chunk, and run_completed', async () => {
    const { runId } = await service.submitUserMessage('c1', 'msg1', 'hello');
    await engine.generate('c1', runId, 'hello');

    const events = await service.replay('c1', 0);

    const startEvents = events.filter((e) => e.type === 'run_started');
    const chunkEvents = events.filter((e) => e.type === 'text_chunk');
    const completedEvents = events.filter((e) => e.type === 'run_completed');

    expect(startEvents).toHaveLength(1);
    expect(chunkEvents.length).toBeGreaterThan(0);
    expect(completedEvents).toHaveLength(1);

    // All should share the same runId
    expect(chunkEvents.every((e) => e.runId === runId)).toBe(true);
    expect(completedEvents[0].runId).toBe(runId);
  });

  it('should append run_failed on provider failure', async () => {
    const { runId } = await service.submitUserMessage('c1', 'msg1', 'please [fail]');
    await engine.generate('c1', runId, 'please [fail]');

    const events = await service.replay('c1', 0);

    const failedEvents = events.filter((e) => e.type === 'run_failed');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].payload.reason).toBe('generator_error');

    // Should NOT have run_completed
    const completedEvents = events.filter((e) => e.type === 'run_completed');
    expect(completedEvents).toHaveLength(0);
  });

  it('should allow conversation to continue after error', async () => {
    const { runId: runId1 } = await service.submitUserMessage('c1', 'msg1', 'please [fail]');
    await engine.generate('c1', runId1, 'please [fail]');

    // Add another user message
    const { runId: runId2 } = await service.submitUserMessage('c1', 'msg2', 'try again');

    // Generate again (should succeed)
    await engine.generate('c1', runId2, 'normal message');

    const events = await service.replay('c1', 0);

    const failedEvents = events.filter((e) => e.type === 'run_failed');
    const completedEvents = events.filter((e) => e.type === 'run_completed');

    expect(failedEvents).toHaveLength(1);
    expect(completedEvents).toHaveLength(1);
  });

  it('should update Run record on completion', async () => {
    const { runId } = await service.submitUserMessage('c1', 'msg1', 'hello');
    await engine.generate('c1', runId, 'hello');

    const run = await store.getRun('c1', runId);
    expect(run).toBeDefined();
    expect(run!.status).toBe('completed');
    expect(run!.text.length).toBeGreaterThan(0);
  });
});

describe('recoverInterruptedRuns', () => {
  it('should mark interrupted runs as failed on startup', async () => {
    const store = new MemoryStore();
    const service = new ConversationService(store);

    // Create a user message and run
    const { runId } = await service.submitUserMessage('c1', 'msg1', 'hello');
    
    // Simulate interrupted generation by appending run_started only
    await service.append('c1', 'run_started', runId, {});

    // Run recovery
    await recoverInterruptedRuns(service, store);

    // Check that run is marked as failed
    const run = await store.getRun('c1', runId);
    expect(run).toBeDefined();
    expect(run!.status).toBe('failed');
    expect(run!.failureReason).toBe('interrupted');
  });

  it('should not affect completed runs', async () => {
    const store = new MemoryStore();
    const service = new ConversationService(store);
    const provider = new FakeProvider(10);
    const engine = new GenerationEngine(provider, service);

    // Complete a generation
    const { runId } = await service.submitUserMessage('c1', 'msg1', 'hello');
    await engine.generate('c1', runId, 'hello');

    // Run recovery
    await recoverInterruptedRuns(service, store);

    // Should NOT change the run status
    const run = await store.getRun('c1', runId);
    expect(run).toBeDefined();
    expect(run!.status).toBe('completed');

    // Should NOT add any run_failed event
    const events = await service.replay('c1', 0);
    const failedEvents = events.filter((e) => e.type === 'run_failed');
    expect(failedEvents).toHaveLength(0);
  });
});

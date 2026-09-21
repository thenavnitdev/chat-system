/**
 * Tests for ResumableClient and backoff logic.
 */

import { describe, it, expect } from 'vitest';
import { WebSocket } from 'ws';
import { ResumableClient } from '../client/resumable-client.js';
import { ExponentialBackoff } from '../client/backoff.js';

describe('ExponentialBackoff', () => {
  it('should increase delay exponentially', () => {
    const backoff = new ExponentialBackoff({
      initialDelayMs: 1000,
      maxDelayMs: 10000,
      multiplier: 2,
      randomFn: () => 1, // Always max jitter
    });

    const delay1 = backoff.next();
    const delay2 = backoff.next();
    const delay3 = backoff.next();

    expect(delay1).toBe(1000); // 1000 * 2^0 = 1000
    expect(delay2).toBe(2000); // 1000 * 2^1 = 2000
    expect(delay3).toBe(4000); // 1000 * 2^2 = 4000
  });

  it('should cap at maxDelay', () => {
    const backoff = new ExponentialBackoff({
      initialDelayMs: 1000,
      maxDelayMs: 5000,
      multiplier: 2,
      randomFn: () => 1,
    });

    backoff.next(); // 1000
    backoff.next(); // 2000
    backoff.next(); // 4000
    const delay4 = backoff.next(); // capped at 5000

    expect(delay4).toBe(5000);
  });

  it('should reset on reset()', () => {
    const backoff = new ExponentialBackoff({
      initialDelayMs: 1000,
      maxDelayMs: 10000,
      multiplier: 2,
      randomFn: () => 1,
    });

    backoff.next(); // 1000
    backoff.next(); // 2000
    backoff.reset();

    const delay = backoff.next();
    expect(delay).toBe(1000);
  });

  it('should use full jitter', () => {
    let callCount = 0;
    const randomValues = [0, 0.5, 1];

    const backoff = new ExponentialBackoff({
      initialDelayMs: 1000,
      maxDelayMs: 10000,
      multiplier: 2,
      randomFn: () => randomValues[callCount++],
    });

    expect(backoff.next()).toBe(0); // 1000 * 0
    expect(backoff.next()).toBe(1000); // 2000 * 0.5
    expect(backoff.next()).toBe(4000); // 4000 * 1
  });
});

describe('ResumableClient', () => {
  // Integration tests with full WebSocket server are covered in gateway.test.ts
  // This is just to verify the client can be instantiated
  it('should create a client instance', () => {
    const client = new ResumableClient({
      url: 'ws://localhost:3000/ws',
      conversationId: 'test',
      clientId: 'client1',
      WebSocket: WebSocket as any,
    });

    expect(client.getStatus()).toBe('closed');
    expect(client.getLastSeq()).toBe(0);
  });
});

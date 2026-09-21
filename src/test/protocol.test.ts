/**
 * Tests for protocol validation functions.
 */

import { describe, it, expect } from 'vitest';
import { parseClientMessage, validateEvent, type ConversationEvent } from '../shared/protocol.js';

describe('Protocol Validation', () => {
  describe('parseClientMessage', () => {
    it('should parse valid hello message', () => {
      const msg = parseClientMessage({
        type: 'hello',
        conversationId: 'conv1',
        clientId: 'client1',
        lastSeq: 0,
      });
      expect(msg.type).toBe('hello');
      expect(msg).toHaveProperty('conversationId', 'conv1');
      expect(msg).toHaveProperty('lastSeq', 0);
    });

    it('should parse valid send_message', () => {
      const msg = parseClientMessage({
        type: 'send_message',
        userMessageId: 'msg1',
        text: 'hello world',
      });
      expect(msg.type).toBe('send_message');
      expect(msg).toHaveProperty('userMessageId', 'msg1');
    });

    it('should parse valid ping message', () => {
      const msg = parseClientMessage({ type: 'ping' });
      expect(msg.type).toBe('ping');
    });

    it('should reject non-object input', () => {
      expect(() => parseClientMessage(null)).toThrow('not an object');
      expect(() => parseClientMessage('string')).toThrow('not an object');
    });

    it('should reject missing type field', () => {
      expect(() => parseClientMessage({})).toThrow('missing or invalid type');
    });

    it('should reject unknown message type', () => {
      expect(() => parseClientMessage({ type: 'unknown' })).toThrow('Unknown message type');
    });

    it('should reject hello with missing fields', () => {
      expect(() =>
        parseClientMessage({ type: 'hello', conversationId: 'c1' })
      ).toThrow('Invalid hello message');
    });

    it('should reject hello with negative lastSeq', () => {
      expect(() =>
        parseClientMessage({
          type: 'hello',
          conversationId: 'c1',
          clientId: 'cl1',
          lastSeq: -1,
        })
      ).toThrow('Invalid hello message');
    });

    it('should reject send_message with missing fields', () => {
      expect(() =>
        parseClientMessage({ type: 'send_message', userMessageId: 'msg1' })
      ).toThrow('Invalid send_message');
    });
  });

  describe('validateEvent', () => {
    it('should accept valid user_message event', () => {
      const event: ConversationEvent = {
        conversationId: 'conv1',
        seq: 1,
        type: 'user_message',
        runId: 'run-msg1',
        payload: { text: 'hello', userMessageId: 'msg1' },
        createdAt: new Date().toISOString(),
      };
      expect(() => validateEvent(event)).not.toThrow();
    });

    it('should accept valid run_started event', () => {
      const event: ConversationEvent = {
        conversationId: 'conv1',
        seq: 2,
        type: 'run_started',
        runId: 'run-msg1',
        payload: {},
        createdAt: new Date().toISOString(),
      };
      expect(() => validateEvent(event)).not.toThrow();
    });

    it('should reject event with missing conversationId', () => {
      const event = {
        seq: 1,
        type: 'user_message',
        runId: 'run-msg1',
        payload: {},
        createdAt: new Date().toISOString(),
      } as unknown as ConversationEvent;
      expect(() => validateEvent(event)).toThrow('missing or invalid required fields');
    });

    it('should reject event with non-integer seq', () => {
      const event = {
        conversationId: 'conv1',
        seq: 1.5,
        type: 'user_message',
        runId: 'run-msg1',
        payload: {},
        createdAt: new Date().toISOString(),
      } as ConversationEvent;
      expect(() => validateEvent(event)).toThrow('missing or invalid required fields');
    });

    it('should reject event with seq < 1', () => {
      const event = {
        conversationId: 'conv1',
        seq: 0,
        type: 'user_message',
        runId: 'run-msg1',
        payload: {},
        createdAt: new Date().toISOString(),
      } as ConversationEvent;
      expect(() => validateEvent(event)).toThrow('missing or invalid required fields');
    });

    it('should reject event with missing runId', () => {
      const event = {
        conversationId: 'conv1',
        seq: 1,
        type: 'user_message',
        payload: {},
        createdAt: new Date().toISOString(),
      } as unknown as ConversationEvent;
      expect(() => validateEvent(event)).toThrow('missing or invalid required fields');
    });
  });
});

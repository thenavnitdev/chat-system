/**
 * Integration tests for WebSocket gateway.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { ConversationService } from '../server/conversation-service.js';
import { MemoryStore } from '../server/store/memory-store.js';
import { FakeProvider } from '../server/llm/fake-provider.js';
import { GenerationEngine } from '../server/generation.js';
import { WSGateway } from '../server/ws-gateway.js';
import { createApp } from '../server/app.js';

describe('WebSocket Gateway Integration', () => {
  let server: http.Server;
  let gateway: WSGateway;
  let service: ConversationService;
  let port: number;

  beforeEach(async () => {
    // Setup
    const store = new MemoryStore();
    service = new ConversationService(store);
    const provider = new FakeProvider(10);
    const engine = new GenerationEngine(provider, service);

    server = http.createServer();
    gateway = new WSGateway(server, service, engine);

    const app = createApp(gateway);
    server.on('request', app);

    // Start server on random port
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(async () => {
    gateway.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('should handle hello and send ready', async () => {
    const client = new WebSocket(`ws://localhost:${port}/ws`);

    await new Promise<void>((resolve, reject) => {
      client.on('open', () => {
        client.send(
          JSON.stringify({
            type: 'hello',
            conversationId: 'c1',
            clientId: 'client1',
            lastSeq: 0,
          })
        );
      });

      client.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ready') {
          expect(msg.headSeq).toBe(0);
          client.close();
          resolve();
        }
      });

      client.on('error', reject);
    });
  });

  it('should handle send_message and trigger generation', async () => {
    const client = new WebSocket(`ws://localhost:${port}/ws`);

    const events: any[] = [];

    await new Promise<void>((resolve, reject) => {
      client.on('open', () => {
        client.send(
          JSON.stringify({
            type: 'hello',
            conversationId: 'c1',
            clientId: 'client1',
            lastSeq: 0,
          })
        );
      });

      client.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'ready') {
          // Send a message
          client.send(
            JSON.stringify({
              type: 'send_message',
              userMessageId: 'msg1',
              text: 'hello',
            })
          );
        } else if (msg.type === 'ack') {
          expect(msg.userMessageId).toBe('msg1');
        } else if (msg.type === 'event') {
          events.push(msg.event);

          // Wait for run_completed
          if (msg.event.type === 'run_completed') {
            // Should have user_message, run_started, text_chunk(s), run_completed
            const types = events.map((e) => e.type);
            expect(types).toContain('user_message');
            expect(types).toContain('run_started');
            expect(types).toContain('text_chunk');
            expect(types).toContain('run_completed');

            client.close();
            resolve();
          }
        }
      });

      client.on('error', reject);
      setTimeout(() => reject(new Error('Test timeout')), 5000);
    });
  });

  it('should handle duplicate send_message', async () => {
    const client = new WebSocket(`ws://localhost:${port}/ws`);

    let ackCount = 0;

    await new Promise<void>((resolve, reject) => {
      client.on('open', () => {
        client.send(
          JSON.stringify({
            type: 'hello',
            conversationId: 'c1',
            clientId: 'client1',
            lastSeq: 0,
          })
        );
      });

      client.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'ready') {
          // Send the same message twice
          client.send(
            JSON.stringify({
              type: 'send_message',
              userMessageId: 'msg1',
              text: 'hello',
            })
          );
          client.send(
            JSON.stringify({
              type: 'send_message',
              userMessageId: 'msg1',
              text: 'hello',
            })
          );
        } else if (msg.type === 'ack') {
          ackCount++;
          if (ackCount === 2) {
            // Both acks should have been received
            client.close();
            resolve();
          }
        }
      });

      client.on('error', reject);
      setTimeout(() => reject(new Error('Test timeout')), 2000);
    });
  });

  it('should support two clients on same conversation', async () => {
    const client1 = new WebSocket(`ws://localhost:${port}/ws`);
    const client2 = new WebSocket(`ws://localhost:${port}/ws`);

    const client1Events: any[] = [];
    const client2Events: any[] = [];

    await new Promise<void>((resolve, reject) => {
      let ready1 = false;
      let ready2 = false;

      client1.on('open', () => {
        client1.send(
          JSON.stringify({
            type: 'hello',
            conversationId: 'c1',
            clientId: 'client1',
            lastSeq: 0,
          })
        );
      });

      client2.on('open', () => {
        client2.send(
          JSON.stringify({
            type: 'hello',
            conversationId: 'c1',
            clientId: 'client2',
            lastSeq: 0,
          })
        );
      });

      client1.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ready') {
          ready1 = true;
          if (ready1 && ready2) {
            // Both ready, client1 sends message
            client1.send(
              JSON.stringify({
                type: 'send_message',
                userMessageId: 'msg1',
                text: 'hello',
              })
            );
          }
        } else if (msg.type === 'event') {
          client1Events.push(msg.event);
        }
      });

      client2.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ready') {
          ready2 = true;
          if (ready1 && ready2) {
            // Both ready
          }
        } else if (msg.type === 'event') {
          client2Events.push(msg.event);

          // When client2 receives user_message, check both have it
          if (msg.event.type === 'user_message') {
            setTimeout(() => {
              expect(client1Events.length).toBeGreaterThan(0);
              expect(client2Events.length).toBeGreaterThan(0);

              const c1UserMsg = client1Events.find((e) => e.type === 'user_message');
              const c2UserMsg = client2Events.find((e) => e.type === 'user_message');

              expect(c1UserMsg).toBeDefined();
              expect(c2UserMsg).toBeDefined();

              client1.close();
              client2.close();
              resolve();
            }, 100);
          }
        }
      });

      client1.on('error', reject);
      client2.on('error', reject);
      setTimeout(() => reject(new Error('Test timeout')), 5000);
    });
  });
});

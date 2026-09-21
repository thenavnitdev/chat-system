/**
 * ResumableClient - framework-agnostic WebSocket client with resumability.
 * Features:
 * - Tracks lastSeq and applies events in order
 * - Detects gaps and triggers reconnection
 * - Maintains outbox for reliable message delivery
 * - Exponential backoff for reconnection
 * - Heartbeat timeout detection
 */

import { ExponentialBackoff } from './backoff.js';
import type {
  ClientMessage,
  ServerMessage,
  ConversationEvent,
} from '../shared/protocol.js';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ResumableClientConfig {
  url: string;
  conversationId: string;
  clientId: string;
  // Inject WebSocket constructor for testing (Node.js vs browser)
  WebSocket: typeof WebSocket;
  heartbeatTimeoutMs?: number;
  backoffConfig?: {
    initialDelayMs: number;
    maxDelayMs: number;
    multiplier: number;
    randomFn?: () => number;
  };
}

export type EventHandler = (event: ConversationEvent) => void;
export type StatusHandler = (status: ConnectionStatus) => void;

interface OutboxMessage {
  clientMessageId: string;
  text: string;
}

export class ResumableClient {
  private config: ResumableClientConfig;
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'closed';
  private lastSeq: number = 0;
  private backoff: ExponentialBackoff;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private shouldReconnect: boolean = true;

  // Outbox for unacknowledged messages
  private outbox: Map<string, OutboxMessage> = new Map();

  // Event handlers
  private eventHandlers: EventHandler[] = [];
  private statusHandlers: StatusHandler[] = [];

  constructor(config: ResumableClientConfig) {
    this.config = {
      heartbeatTimeoutMs: 40000,
      backoffConfig: {
        initialDelayMs: 1000,
        maxDelayMs: 30000,
        multiplier: 2,
      },
      ...config,
    };

    this.backoff = new ExponentialBackoff(this.config.backoffConfig!);
  }

  /**
   * Connect to the server.
   */
  connect(): void {
    if (this.ws && this.ws.readyState !== this.ws.CLOSED) {
      return; // Already connected or connecting
    }

    this.setStatus(this.lastSeq === 0 ? 'connecting' : 'reconnecting');

    this.ws = new this.config.WebSocket(this.config.url);

    this.ws.onopen = () => this.handleOpen();
    this.ws.onmessage = (event) => this.handleMessage(event);
    this.ws.onclose = () => this.handleClose();
    this.ws.onerror = () => {
      // Error will be followed by close
    };
  }

  /**
   * Send a user message.
   * Adds to outbox for reliability and sends when connected.
   */
  sendMessage(clientMessageId: string, text: string): void {
    // Add to outbox for reliability (will be removed on ack)
    this.outbox.set(clientMessageId, { clientMessageId, text });

    // Send immediately if connected
    if (this.status === 'open' && this.ws && this.ws.readyState === this.ws.OPEN) {
      this.send({
        type: 'send_message',
        userMessageId: clientMessageId,
        text,
      });
    }
  }

  /**
   * Manually disconnect (will not auto-reconnect).
   */
  disconnect(): void {
    this.shouldReconnect = false;
    this.cleanup();
    this.setStatus('closed');
  }

  /**
   * Subscribe to conversation events.
   */
  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    };
  }

  /**
   * Subscribe to status changes.
   */
  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.push(handler);
    return () => {
      this.statusHandlers = this.statusHandlers.filter((h) => h !== handler);
    };
  }

  /**
   * Get current connection status.
   */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * Get current lastSeq.
   */
  getLastSeq(): number {
    return this.lastSeq;
  }

  private handleOpen(): void {
    // Send hello
    this.send({
      type: 'hello',
      conversationId: this.config.conversationId,
      clientId: this.config.clientId,
      lastSeq: this.lastSeq,
    });

    // Start heartbeat
    this.startHeartbeat();
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const message: ServerMessage = JSON.parse(event.data);

      switch (message.type) {
        case 'ready':
          this.handleReady();
          break;

        case 'event':
          this.handleEvent(message.event);
          break;

        case 'ack':
          this.handleAck(message.userMessageId);
          break;

        case 'pong':
          this.resetHeartbeat();
          break;

        case 'error':
          console.error('Server error:', message.message);
          break;
      }
    } catch (error) {
      console.error('Failed to parse message:', error);
    }
  }

  private handleReady(): void {
    this.setStatus('open');
    this.backoff.reset();

    // Re-send outbox messages
    this.trySendOutbox();
  }

  private handleEvent(event: ConversationEvent): void {
    // Apply events in order
    if (event.seq === this.lastSeq + 1) {
      // Next expected event
      this.lastSeq = event.seq;
      this.notifyEvent(event);
    } else if (event.seq <= this.lastSeq) {
      // Duplicate, ignore
      return;
    } else {
      // Gap detected (seq > lastSeq + 1)
      console.warn(`Gap detected: expected ${this.lastSeq + 1}, got ${event.seq}. Reconnecting...`);
      this.triggerReconnect();
    }
  }

  private handleAck(clientMessageId: string): void {
    // Remove from outbox
    this.outbox.delete(clientMessageId);
  }

  private handleClose(): void {
    this.cleanup();

    if (this.shouldReconnect) {
      // Schedule reconnect with backoff
      const delay = this.backoff.next();
      this.setStatus('reconnecting');

      this.reconnectTimer = setTimeout(() => {
        this.connect();
      }, delay);
    } else {
      this.setStatus('closed');
    }
  }

  private triggerReconnect(): void {
    // Force close and reconnect
    if (this.ws) {
      this.ws.close();
    }
  }

  private trySendOutbox(): void {
    if (this.status !== 'open') return;

    for (const msg of this.outbox.values()) {
      this.send({
        type: 'send_message',
        userMessageId: msg.clientMessageId,
        text: msg.text,
      });
    }
  }

  private send(message: ClientMessage): void {
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private startHeartbeat(): void {
    this.resetHeartbeat();
  }

  private resetHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }

    this.heartbeatTimer = setTimeout(() => {
      console.warn('Heartbeat timeout, closing connection');
      if (this.ws) {
        this.ws.close();
      }
    }, this.config.heartbeatTimeoutMs);

    // Send ping
    this.send({ type: 'ping' });
  }

  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.ws = null;
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.notifyStatus(status);
    }
  }

  private notifyEvent(event: ConversationEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('Event handler error:', error);
      }
    }
  }

  private notifyStatus(status: ConnectionStatus): void {
    for (const handler of this.statusHandlers) {
      try {
        handler(status);
      } catch (error) {
        console.error('Status handler error:', error);
      }
    }
  }
}

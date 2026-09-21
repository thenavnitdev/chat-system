/**
 * WebSocket gateway - handles socket lifecycle and protocol implementation.
 * Implements the resume protocol: hello -> ready -> replay -> live.
 */

import { WebSocket, WebSocketServer } from 'ws';
import type { Server as HTTPServer } from 'http';
import type { ConversationService } from './conversation-service.js';
import type { GenerationEngine } from './generation.js';
import { parseClientMessage, type ConversationEvent } from '../shared/protocol.js';
import { log } from './logger.js';

const HEARTBEAT_INTERVAL = 30000; // 30 seconds

interface SocketState {
  socket: WebSocket;
  conversationId?: string;
  clientId?: string;
  lastSeq: number; // last sequence number processed by this client
  isAlive: boolean;
  unsubscribe?: () => void;
}

export class WSGateway {
  private wss: WebSocketServer;
  private service: ConversationService;
  private engine: GenerationEngine;
  private sockets: Map<WebSocket, SocketState> = new Map();
  private heartbeatTimer?: NodeJS.Timeout;

  // Track sockets by conversation for debug endpoint
  private conversationSockets: Map<string, Set<WebSocket>> = new Map();

  constructor(
    server: HTTPServer,
    service: ConversationService,
    engine: GenerationEngine
  ) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.service = service;
    this.engine = engine;

    this.wss.on('connection', (socket) => this.handleConnection(socket));
    this.startHeartbeat();

    log('info', 'WebSocket gateway initialized');
  }

  private handleConnection(socket: WebSocket): void {
    const state: SocketState = {
      socket,
      lastSeq: 0,
      isAlive: true,
    };

    this.sockets.set(socket, state);
    log('info', 'Client connected');

    socket.on('message', (data) => this.handleMessage(socket, data));
    socket.on('close', () => this.handleClose(socket));
    socket.on('error', (err) => {
      log('error', 'Socket error', { error: err.message });
    });

    // Pong response keeps connection alive
    socket.on('pong', () => {
      const st = this.sockets.get(socket);
      if (st) st.isAlive = true;
    });
  }

  private async handleMessage(socket: WebSocket, data: unknown): Promise<void> {
    const state = this.sockets.get(socket);
    if (!state) return;

    try {
      // Handle different data types from WebSocket
      let dataStr: string;
      if (typeof data === 'string') {
        dataStr = data;
      } else if (Buffer.isBuffer(data)) {
        dataStr = data.toString('utf-8');
      } else if (data instanceof ArrayBuffer) {
        dataStr = new TextDecoder().decode(data);
      } else if (Array.isArray(data)) {
        dataStr = Buffer.concat(data).toString('utf-8');
      } else {
        console.error('Unknown data type:', typeof data);
        return;
      }

      const raw = JSON.parse(dataStr);
      const message = parseClientMessage(raw);

      switch (message.type) {
        case 'hello':
          await this.handleHello(socket, state, message);
          break;

        case 'send_message':
          await this.handleSendMessage(socket, state, message);
          break;

        case 'ping':
          this.send(socket, { type: 'pong' });
          break;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      log('warn', 'Message handling error', { error: errorMsg });
      this.send(socket, { type: 'error', message: errorMsg });
    }
  }

  private async handleHello(
    socket: WebSocket,
    state: SocketState,
    message: { conversationId: string; clientId: string; lastSeq: number }
  ): Promise<void> {
    state.conversationId = message.conversationId;
    state.clientId = message.clientId;
    state.lastSeq = message.lastSeq;

    // Track socket by conversation
    if (!this.conversationSockets.has(message.conversationId)) {
      this.conversationSockets.set(message.conversationId, new Set());
    }
    this.conversationSockets.get(message.conversationId)!.add(socket);

    log('info', 'Client hello', {
      conversationId: message.conversationId,
      clientId: message.clientId,
      lastSeq: message.lastSeq,
    });

    // Get current head
    const headSeq = await this.service.head(message.conversationId);

    // Subscribe to live events FIRST (to avoid replay/live race)
    const buffer: ConversationEvent[] = [];
    let replayDone = false;

    state.unsubscribe = this.service.subscribe(message.conversationId, (event) => {
      if (!replayDone) {
        // Buffer events during replay
        buffer.push(event);
      } else {
        // Send live events
        this.sendEvent(socket, event);
      }
    });

    // Send ready
    this.send(socket, { type: 'ready', headSeq });

    // Replay events from store
    const replayEvents = await this.service.replay(
      message.conversationId,
      message.lastSeq
    );

    log('info', 'Replaying events', {
      conversationId: message.conversationId,
      count: replayEvents.length,
    });

    for (const event of replayEvents) {
      this.sendEvent(socket, event);
    }

    // Flush buffered events (skip any seq already sent during replay)
    replayDone = true;
    const lastReplayedSeq = replayEvents.length > 0
      ? replayEvents[replayEvents.length - 1].seq
      : message.lastSeq;

    for (const event of buffer) {
      if (event.seq > lastReplayedSeq) {
        this.sendEvent(socket, event);
      }
    }
  }

  private async handleSendMessage(
    socket: WebSocket,
    state: SocketState,
    message: { userMessageId: string; text: string }
  ): Promise<void> {
    if (!state.conversationId) {
      this.send(socket, { type: 'error', message: 'Not connected (send hello first)' });
      return;
    }

    try {
      const { runId, duplicate, seq } = await this.service.submitUserMessage(
        state.conversationId,
        message.userMessageId,
        message.text
      );

      if (duplicate) {
        log('info', 'Duplicate send ignored', {
          conversationId: state.conversationId,
          userMessageId: message.userMessageId,
        });
      }

      // Send ack
      const ackMessage: any = {
        type: 'ack',
        userMessageId: message.userMessageId,
        runId,
        seq,
      };
      if (duplicate) {
        ackMessage.duplicate = true;
      }
      this.send(socket, ackMessage);

      // Trigger generation (only if not duplicate)
      if (!duplicate) {
        // Fire and forget (runs independently)
        this.engine.generate(state.conversationId, runId, message.text).catch((err) => {
          log('error', 'Generation error', { error: err.message });
        });
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'run_in_progress') {
        this.send(socket, { 
          type: 'error', 
          code: 'run_in_progress',
          message: 'A run is already in progress for this conversation'
        });
      } else {
        throw error;
      }
    }
  }

  private sendEvent(socket: WebSocket, event: ConversationEvent): void {
    this.send(socket, { type: 'event', event });
  }

  private send(socket: WebSocket, message: unknown): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  private handleClose(socket: WebSocket): void {
    const state = this.sockets.get(socket);
    if (state) {
      if (state.unsubscribe) {
        state.unsubscribe();
      }

      // Remove from conversation tracking
      if (state.conversationId) {
        this.conversationSockets.get(state.conversationId)?.delete(socket);
      }

      log('info', 'Client disconnected', {
        conversationId: state.conversationId,
        clientId: state.clientId,
      });
    }

    this.sockets.delete(socket);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.sockets.forEach((state, socket) => {
        if (!state.isAlive) {
          log('info', 'Heartbeat timeout, closing socket');
          socket.terminate();
          return;
        }

        state.isAlive = false;
        socket.ping();
      });
    }, HEARTBEAT_INTERVAL);
  }

  /**
   * Force-close all sockets for a conversation (debug endpoint).
   */
  dropConversation(conversationId: string): number {
    const sockets = this.conversationSockets.get(conversationId);
    if (!sockets) return 0;

    let count = 0;
    for (const socket of sockets) {
      socket.close(1000, 'Debug drop');
      count++;
    }

    log('info', 'Dropped sockets for conversation', { conversationId, count });
    return count;
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.wss.close();
  }
}

/**
 * Protocol definitions shared between client and server.
 * Defines the WebSocket message types and conversation event types.
 */

// ============ CLIENT -> SERVER MESSAGES ============

export type HelloMessage = {
  type: 'hello';
  conversationId: string;
  clientId: string;
  lastSeq: number; // last sequence number processed by client
};

export type SendMessageRequest = {
  type: 'send_message';
  userMessageId: string; // renamed from clientMessageId (client-generated UUID)
  text: string;
};

export type PingMessage = {
  type: 'ping';
};

export type ClientMessage = HelloMessage | SendMessageRequest | PingMessage;

// ============ SERVER -> CLIENT MESSAGES ============

export type ReadyMessage = {
  type: 'ready';
  headSeq: number;
};

export type AckMessage = {
  type: 'ack';
  userMessageId: string;
  runId: string;
  seq: number;
  duplicate?: boolean;
};

export type EventMessage = {
  type: 'event';
  event: ConversationEvent;
};

export type SeqRejectedMessage = {
  type: 'seq_rejected';
  code: 'seq_invalid' | 'seq_ahead' | 'seq_expired';
  earliestSeq: number;
  headSeq: number;
  recoverable: true;
};

export type RunInProgressError = {
  type: 'error';
  code: 'run_in_progress';
  message: string;
};

export type PongMessage = {
  type: 'pong';
};

export type ErrorMessage = {
  type: 'error';
  message: string;
  code?: string;
};

export type ServerMessage =
  | ReadyMessage
  | AckMessage
  | EventMessage
  | SeqRejectedMessage
  | RunInProgressError
  | PongMessage
  | ErrorMessage;

// ============ CONVERSATION EVENTS ============

export type UserMessageEvent = {
  conversationId: string;
  seq: number;
  type: 'user_message';
  runId: string; // run-<userMessageId>
  payload: {
    userMessageId: string;
    text: string;
  };
  createdAt: string;
};

export type RunStartedEvent = {
  conversationId: string;
  seq: number;
  type: 'run_started';
  runId: string;
  payload: Record<string, never>;
  createdAt: string;
};

export type TextChunkEvent = {
  conversationId: string;
  seq: number;
  type: 'text_chunk';
  runId: string;
  payload: {
    text: string;
  };
  createdAt: string;
};

export type RunCompletedEvent = {
  conversationId: string;
  seq: number;
  type: 'run_completed';
  runId: string;
  payload: Record<string, never>;
  createdAt: string;
};

export type RunFailedEvent = {
  conversationId: string;
  seq: number;
  type: 'run_failed';
  runId: string;
  payload: {
    reason: 'generator_error' | 'interrupted';
  };
  createdAt: string;
};

export type ConversationEvent =
  | UserMessageEvent
  | RunStartedEvent
  | TextChunkEvent
  | RunCompletedEvent
  | RunFailedEvent;

// ============ RUN RECORDS ============

export type RunStatus = 'running' | 'completed' | 'failed';

export type Run = {
  runId: string;
  conversationId: string;
  userMessageId: string;
  status: RunStatus;
  failureReason?: 'generator_error' | 'interrupted';
  firstSeq: number;
  lastSeq: number;
  text: string; // accumulated text from chunks
};

// ============ SNAPSHOT ============

export type ConversationSnapshot = {
  cursor: number; // headSeq at snapshot time (for client to resume from)
  messages: SnapshotMessage[];
};

export type SnapshotMessage = {
  userMessageId: string;
  userText: string;
  runId: string;
  status: RunStatus;
  assistantText: string;
  failureReason?: 'generator_error' | 'interrupted';
};

// ============ VALIDATION ============

/**
 * Validates and parses a client message from raw JSON.
 * Returns the parsed message or throws with a descriptive error.
 */
export function parseClientMessage(raw: unknown): ClientMessage {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid message: not an object');
  }

  const msg = raw as Record<string, unknown>;

  if (!msg.type || typeof msg.type !== 'string') {
    throw new Error('Invalid message: missing or invalid type field');
  }

  switch (msg.type) {
    case 'hello':
      if (
        typeof msg.conversationId !== 'string' ||
        typeof msg.clientId !== 'string' ||
        typeof msg.lastSeq !== 'number' ||
        !Number.isInteger(msg.lastSeq) ||
        msg.lastSeq < 0
      ) {
        throw new Error('Invalid hello message: missing or invalid fields');
      }
      return msg as HelloMessage;

    case 'send_message':
      if (
        typeof msg.userMessageId !== 'string' ||
        typeof msg.text !== 'string'
      ) {
        throw new Error('Invalid send_message: missing or invalid fields');
      }
      return msg as SendMessageRequest;

    case 'ping':
      return msg as PingMessage;

    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}

/**
 * Validates that a conversation event has all required fields.
 */
export function validateEvent(event: ConversationEvent): void {
  if (
    !event.conversationId ||
    typeof event.seq !== 'number' ||
    !Number.isInteger(event.seq) ||
    event.seq < 1 ||
    !event.type ||
    !event.runId ||
    !event.createdAt
  ) {
    throw new Error('Invalid event: missing or invalid required fields');
  }
}

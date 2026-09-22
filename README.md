# Resumable Conversation

A TypeScript chat system that streams assistant replies over WebSocket and **resumes from the last processed sequence** after a client drop, network blip, or server restart.

Repository: [https://github.com/thenavnitdev/chat-system](https://github.com/thenavnitdev/chat-system)

> There is no assignment submission form in this repository. Submit only through the official link from the original assignment README if you were given a different GitHub URL.

## Scope

In scope:

- Ordered, append-only conversation events with a per-conversation `seq`
- WebSocket resume protocol: `hello(lastSeq)` → `ready` → replay missed events → live stream
- Exactly-once user send via client-generated `userMessageId` (duplicate `send_message` is acked, not re-run)
- One active generation run per conversation (`run_in_progress` if another run is live)
- Streaming fake LLM with mid-stream failure when the prompt contains `[fail]`
- Durable JSONL store under `data/` and recovery of interrupted runs on server start
- Browser UI plus a framework-agnostic `ResumableClient`
- Unit/integration tests for protocol, store, generation, gateway, and client backoff

Out of scope:

- Real LLM APIs, auth, multi-user accounts, or horizontal scaling
- Message editing, branching, or tool-calling

## How it works

```
Browser UI  →  ResumableClient  →  WS /ws  →  WSGateway
                                              ↓
                                    ConversationService
                                              ↓
                                    FileStore (JSONL) + GenerationEngine
                                              ↓
                                    FakeProvider (word-by-word stream)
```

1. Client connects and sends `{ type: "hello", conversationId, clientId, lastSeq }`.
2. Server replies `{ type: "ready", headSeq }`, then replays events with `seq > lastSeq`.
3. Client sends `{ type: "send_message", userMessageId, text }`.
4. Server persists `user_message`, acks, then streams `run_started` → `text_chunk*` → `run_completed` or `run_failed`.
5. On reconnect the client repeats `hello` with its latest `lastSeq` and catches up without duplicates.

### Client → server

| Type | Purpose |
| --- | --- |
| `hello` | Bind to a conversation and resume from `lastSeq` |
| `send_message` | Submit a user turn (`userMessageId` is a client UUID) |
| `ping` | Keepalive; server replies `pong` |

### Server → client

| Type | Purpose |
| --- | --- |
| `ready` | Handshake complete; includes current `headSeq` |
| `ack` | User message accepted (`duplicate: true` if already seen) |
| `event` | Conversation event (`user_message`, `run_started`, `text_chunk`, `run_completed`, `run_failed`) |
| `seq_rejected` | Resume cursor is invalid (`seq_invalid`, `seq_ahead`, `seq_expired`) |
| `error` | Protocol or business error (`run_in_progress`, etc.) |
| `pong` | Heartbeat reply |

## Setup

Requirements: Node.js 20+ and npm.

```bash
npm install
npm test
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Production-style start (compile server + bundle client):

```bash
npm start
```

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP + WebSocket port |
| `DATA_DIR` | `./data` | JSONL conversation files |
| `FAKE_LLM_DELAY_MS` | `300` | Delay between streamed words |
| `DEBUG_ENDPOINTS` | unset | Set to `1` to enable `POST /debug/drop/:conversationId` |

## Demo the resume path

1. Send a message and watch the assistant stream word by word.
2. Click **Drop Connection (Client)** or **Drop Connection (Server)** mid-stream.
3. The client reconnects with backoff, sends `hello` with the last applied `seq`, and continues the same run.
4. Click **Send Failure Message** to force a `[fail]` prompt. The run ends as `run_failed`; the next user message starts a new run.
5. Restart the server while a run is `running`. On boot, `recoverInterruptedRuns` marks it `failed` / `interrupted` so it is not left hanging.

## Project layout

```
src/
  client/     ResumableClient, backoff, browser entry
  server/     HTTP app, WS gateway, conversation service, generation, stores
  shared/     Protocol types and validators
  test/       Vitest coverage for protocol, store, generation, gateway, client
public/       Static UI (client bundle is built to public/client.js)
```

## Tests

```bash
npm test          # single run
npm run test:watch
```

Coverage includes monotonic seq assignment, duplicate `userMessageId` handling, run state machine, replay after disconnect, and exponential reconnect backoff.

## License

Private assignment / portfolio project. Not licensed for reuse unless you add a license file.

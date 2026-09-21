/**
 * Browser entry point - initializes ResumableClient and renders UI.
 * Optimized to avoid unnecessary re-renders.
 */

import { ResumableClient, type ConnectionStatus } from './resumable-client.js';
import type { ConversationEvent } from '../shared/protocol.js';

// Get conversation ID from URL or localStorage
const urlParams = new URLSearchParams(window.location.search);
const conversationId = urlParams.get('c') || localStorage.getItem('conversationId') || `conv-${Date.now()}`;
localStorage.setItem('conversationId', conversationId);

const clientId = localStorage.getItem('clientId') || `client-${Date.now()}`;
localStorage.setItem('clientId', clientId);

// Initialize client
const client = new ResumableClient({
  url: `ws://${window.location.host}/ws`,
  conversationId,
  clientId,
  WebSocket: window.WebSocket,
});

// UI elements
const messagesEl = document.getElementById('messages')!;
const inputEl = document.getElementById('message-input') as HTMLInputElement;
const sendBtn = document.getElementById('send-btn')!;
const statusEl = document.getElementById('status')!;
const lastSeqEl = document.getElementById('last-seq')!;
const dropClientBtn = document.getElementById('drop-client-btn')!;
const dropServerBtn = document.getElementById('drop-server-btn')!;
const sendFailBtn = document.getElementById('send-fail-btn')!;

// Transcript state: fold events into messages
interface Message {
  id: string; // runId for assistant, userMessageId for user
  role: 'user' | 'assistant';
  text: string;
  status: 'complete' | 'streaming' | 'error' | 'interrupted';
}

const transcript: Message[] = [];
const assistantMessages: Map<string, Message> = new Map();
const messageElements: Map<string, HTMLElement> = new Map(); // Cache DOM elements

// Debounce rendering to avoid excessive DOM updates
let renderScheduled = false;
function scheduleRender() {
  if (!renderScheduled) {
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      renderTranscript();
    });
  }
}

// Event handlers
client.onEvent((event: ConversationEvent) => {
  let needsRender = false;

  switch (event.type) {
    case 'user_message':
      const userMsg: Message = {
        id: event.runId,
        role: 'user',
        text: event.payload.text,
        status: 'complete',
      };
      transcript.push(userMsg);
      needsRender = true;
      break;

    case 'run_started':
      const msg: Message = {
        id: event.runId,
        role: 'assistant',
        text: '',
        status: 'streaming',
      };
      transcript.push(msg);
      assistantMessages.set(event.runId, msg);
      needsRender = true;
      break;

    case 'text_chunk':
      const chunkMsg = assistantMessages.get(event.runId);
      if (chunkMsg) {
        chunkMsg.text += event.payload.text;
        // Update only this specific message element
        updateMessageElement(chunkMsg);
      }
      break;

    case 'run_completed':
      const endMsg = assistantMessages.get(event.runId);
      if (endMsg) {
        endMsg.status = 'complete';
        assistantMessages.delete(event.runId);
        updateMessageElement(endMsg);
      }
      break;

    case 'run_failed':
      const errorMsg = assistantMessages.get(event.runId);
      if (errorMsg) {
        errorMsg.status = event.payload.reason === 'interrupted' ? 'interrupted' : 'error';
        errorMsg.text += ` [${event.payload.reason}]`;
        assistantMessages.delete(event.runId);
        updateMessageElement(errorMsg);
      }
      break;
  }

  if (needsRender) {
    scheduleRender();
  }

  lastSeqEl.textContent = client.getLastSeq().toString();
});

client.onStatus((status: ConnectionStatus) => {
  updateStatus(status);
});

// Update a specific message element without re-rendering everything
function updateMessageElement(msg: Message) {
  const el = messageElements.get(msg.id);
  if (el) {
    const textEl = el.querySelector('.text') as HTMLElement;
    if (textEl) {
      textEl.textContent = msg.text || '...';
    }

    // Update status classes
    el.className = `message message-${msg.role}`;
    if (msg.status === 'streaming') {
      el.classList.add('streaming');
    } else if (msg.status === 'error' || msg.status === 'interrupted') {
      el.classList.add('error');
    }
  }
}

// Render transcript (only called when new messages are added)
function renderTranscript() {
  // Only add new messages that don't have DOM elements yet
  for (const msg of transcript) {
    if (!messageElements.has(msg.id)) {
      const msgEl = createMessageElement(msg);
      messagesEl.appendChild(msgEl);
      messageElements.set(msg.id, msgEl);
    }
  }

  // Auto-scroll to bottom
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Create a message DOM element
function createMessageElement(msg: Message): HTMLElement {
  const msgEl = document.createElement('div');
  msgEl.className = `message message-${msg.role}`;
  msgEl.setAttribute('data-id', msg.id);

  if (msg.status === 'streaming') {
    msgEl.classList.add('streaming');
  } else if (msg.status === 'error' || msg.status === 'interrupted') {
    msgEl.classList.add('error');
  }

  const roleEl = document.createElement('div');
  roleEl.className = 'role';
  roleEl.textContent = msg.role === 'user' ? 'You' : 'Assistant';

  const textEl = document.createElement('div');
  textEl.className = 'text';
  textEl.textContent = msg.text || '...';

  msgEl.appendChild(roleEl);
  msgEl.appendChild(textEl);

  return msgEl;
}

function updateStatus(status: ConnectionStatus) {
  const statusEl = document.getElementById('status')!;
  const statusDot = statusEl.querySelector('.status-dot')!;
  const statusText = statusEl.querySelector('span')!;
  
  // Update text
  const statusMap: Record<ConnectionStatus, string> = {
    'connecting': 'Connecting',
    'open': 'Connected',
    'reconnecting': 'Reconnecting',
    'closed': 'Disconnected'
  };
  statusText.textContent = statusMap[status] || status;
  
  // Update class
  statusEl.className = `status status-${status}`;

  const sendBtnTyped = sendBtn as HTMLButtonElement;
  if (status === 'open') {
    sendBtnTyped.disabled = false;
  } else {
    sendBtnTyped.disabled = true;
  }
}

function sendMessage(text: string) {
  if (!text.trim()) return;

  const clientMessageId = `msg-${Date.now()}-${Math.random()}`;
  client.sendMessage(clientMessageId, text);
  inputEl.value = '';
}

// Event listeners
sendBtn.addEventListener('click', () => {
  sendMessage(inputEl.value);
});

inputEl.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    sendMessage(inputEl.value);
  }
});

dropClientBtn.addEventListener('click', () => {
  client.disconnect();
  setTimeout(() => client.connect(), 100);
});

dropServerBtn.addEventListener('click', async () => {
  try {
    await fetch(`/debug/drop/${conversationId}`, { method: 'POST' });
  } catch (err) {
    console.error('Failed to drop from server:', err);
  }
});

sendFailBtn.addEventListener('click', () => {
  sendMessage('please [fail] now');
});

// Connect
client.connect();
updateStatus(client.getStatus());
lastSeqEl.textContent = client.getLastSeq().toString();

// Display conversation info
document.getElementById('conversation-id')!.textContent = conversationId;

/**
 * Server entry point.
 * Loads store, recovers interrupted streams, and starts HTTP/WS server.
 */

import http from 'http';
import path from 'path';
import { FileStore } from './store/file-store.js';
import { ConversationService } from './conversation-service.js';
import { FakeProvider } from './llm/fake-provider.js';
import { GenerationEngine, recoverInterruptedRuns } from './generation.js';
import { WSGateway } from './ws-gateway.js';
import { createApp } from './app.js';
import { log } from './logger.js';

async function main() {
  const port = parseInt(process.env.PORT || '3000', 10);
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const fakeLlmDelay = parseInt(process.env.FAKE_LLM_DELAY_MS || '300', 10);

  log('info', 'Starting server', { port, dataDir, fakeLlmDelay });

  // Initialize store and service
  const store = new FileStore(dataDir);
  await store.load();
  log('info', 'Store loaded');

  const service = new ConversationService(store);

  // Recover interrupted streams
  await recoverInterruptedRuns(service, store);
  log('info', 'Interrupted runs recovered');

  // Initialize generation engine
  const provider = new FakeProvider(fakeLlmDelay);
  const engine = new GenerationEngine(provider, service);

  // Create HTTP server
  const server = http.createServer();

  // Initialize WebSocket gateway
  const gateway = new WSGateway(server, service, engine);

  // Attach Express app
  const app = createApp(gateway);
  server.on('request', app);

  // Start listening
  server.listen(port, () => {
    log('info', `Server listening on http://localhost:${port}`);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    log('info', 'Shutting down...');
    gateway.close();
    server.close(() => {
      log('info', 'Server closed');
      process.exit(0);
    });
  });
}

main().catch((error) => {
  log('error', 'Fatal error', { error: error.message });
  process.exit(1);
});

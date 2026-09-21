/**
 * Express application setup.
 * Serves static files, /health endpoint, and debug endpoint.
 */

import express, { type Application } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import type { WSGateway } from './ws-gateway.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp(gateway: WSGateway): Application {
  const app = express();

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Debug endpoint (enabled by DEBUG_ENDPOINTS=1)
  if (process.env.DEBUG_ENDPOINTS === '1') {
    app.post('/debug/drop/:conversationId', (req, res) => {
      const { conversationId } = req.params;
      const count = gateway.dropConversation(conversationId);
      res.json({ dropped: count });
    });
  }

  // Serve static files from public/
  const publicDir = path.join(__dirname, '../../public');
  app.use(express.static(publicDir));

  return app;
}

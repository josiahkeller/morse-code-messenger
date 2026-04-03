import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
};

const server = http.createServer((req, res) => {
  let urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(PUBLIC, urlPath);

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end();
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// clients: Map<clientId, { ws, signalTimeout }>
const clients = new Map();

function broadcast(data, excludeId = null) {
  const msg = JSON.stringify(data);
  for (const [id, client] of clients) {
    if (id !== excludeId && client.ws.readyState === 1 /* OPEN */) {
      client.ws.send(msg);
    }
  }
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const clientId = randomUUID();
  clients.set(clientId, { ws, signalTimeout: null });

  // Send this client its assigned ID and current count (including itself)
  ws.send(JSON.stringify({ type: 'init', clientId, count: clients.size }));

  // Tell everyone else the new count
  broadcast({ type: 'user_count', count: clients.size }, clientId);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const client = clients.get(clientId);
    if (!client) return;

    if (msg.type === 'signal_start') {
      // Clear any existing safety timeout
      clearTimeout(client.signalTimeout);
      // Safety: auto-end if client doesn't send signal_end within 3100ms
      client.signalTimeout = setTimeout(() => {
        broadcast({ type: 'signal_end', clientId });
      }, 3100);
      broadcast({ type: 'signal_start', clientId });

    } else if (msg.type === 'signal_end') {
      clearTimeout(client.signalTimeout);
      client.signalTimeout = null;
      broadcast({ type: 'signal_end', clientId });
    }
  });

  ws.on('close', () => {
    const client = clients.get(clientId);
    if (client) {
      // If signal was active, broadcast a synthetic end
      if (client.signalTimeout) {
        clearTimeout(client.signalTimeout);
        broadcast({ type: 'signal_end', clientId });
      }
      clients.delete(clientId);
    }
    broadcast({ type: 'user_count', count: clients.size });
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

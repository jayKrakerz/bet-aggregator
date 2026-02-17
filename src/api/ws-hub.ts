import { logger } from '../utils/logger.js';

interface WebSocket {
  readyState: number;
  send(data: string): void;
  on(event: string, cb: () => void): void;
}

const clients = new Set<WebSocket>();

export function addClient(ws: WebSocket): void {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  logger.debug({ count: clients.size }, 'WS client connected');
}

export function broadcast(event: string, data: unknown): void {
  if (clients.size === 0) return;
  const msg = JSON.stringify({ event, data, ts: Date.now() });
  for (const ws of clients) {
    try {
      if (ws.readyState === 1) ws.send(msg);
    } catch {
      clients.delete(ws);
    }
  }
}

export function getClientCount(): number {
  return clients.size;
}

import websocket from '@fastify/websocket';
import type { FastifyPluginAsync } from 'fastify';
import { addClient } from '../ws-hub.js';

export const websocketPlugin: FastifyPluginAsync = async (app) => {
  await app.register(websocket);

  app.get('/ws', { websocket: true }, (socket) => {
    addClient(socket);
    socket.send(JSON.stringify({ event: 'connected', ts: Date.now() }));
  });
};

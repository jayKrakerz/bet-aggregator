import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { healthRoutes } from './routes/health.js';
import { predictionsRoutes } from './routes/predictions.js';
import { sourcesRoutes } from './routes/sources.js';
import { analystRoutes } from './routes/analyst.js';
import { bullBoardPlugin } from './plugins/bull-board.js';
import websocket from '@fastify/websocket';
import { addClient } from './ws-hub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function createServer() {
  const app = Fastify({
    logger: {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    },
  });

  // Register websocket BEFORE static to avoid route conflict
  await app.register(websocket);
  app.get('/ws', { websocket: true }, (socket) => {
    addClient(socket);
    socket.send(JSON.stringify({ event: 'connected', ts: Date.now() }));
  });

  // Serve static dashboard from public/
  await app.register(fastifyStatic, {
    root: path.join(__dirname, '..', '..', 'public'),
    prefix: '/',
  });
  await app.register(healthRoutes);
  await app.register(predictionsRoutes, { prefix: '/predictions' });
  await app.register(sourcesRoutes, { prefix: '/sources' });
  await app.register(analystRoutes, { prefix: '/analyst' });
  await app.register(bullBoardPlugin);

  // Serve analyst page
  app.get('/analyst', async (_request, reply) => {
    return reply.sendFile('analyst.html');
  });

  return app;
}

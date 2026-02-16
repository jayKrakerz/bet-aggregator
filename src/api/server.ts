import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { healthRoutes } from './routes/health.js';
import { predictionsRoutes } from './routes/predictions.js';
import { sourcesRoutes } from './routes/sources.js';
import { bullBoardPlugin } from './plugins/bull-board.js';

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

  // Serve static dashboard from public/
  await app.register(fastifyStatic, {
    root: path.join(__dirname, '..', '..', 'public'),
    prefix: '/',
  });

  await app.register(healthRoutes);
  await app.register(predictionsRoutes, { prefix: '/predictions' });
  await app.register(sourcesRoutes, { prefix: '/sources' });
  await app.register(bullBoardPlugin);

  return app;
}

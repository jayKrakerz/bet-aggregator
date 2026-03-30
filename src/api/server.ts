import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { healthRoutes } from './routes/health.js';
import { predictionsRoutes } from './routes/predictions.js';
import { vflRoutes } from './vfl/routes.js';
import { initStore as initVflStore } from './vfl/store.js';

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

  await app.register(fastifyStatic, {
    root: path.join(__dirname, '..', '..', 'public'),
    prefix: '/',
  });
  await app.register(healthRoutes);
  await app.register(predictionsRoutes, { prefix: '/predictions' });
  await initVflStore();
  await app.register(vflRoutes, { prefix: '/vfl' });

  return app;
}

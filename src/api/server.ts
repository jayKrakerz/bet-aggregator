import Fastify from 'fastify';
import { healthRoutes } from './routes/health.js';
import { predictionsRoutes } from './routes/predictions.js';
import { sourcesRoutes } from './routes/sources.js';
import { bullBoardPlugin } from './plugins/bull-board.js';

export async function createServer() {
  const app = Fastify({
    logger: {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    },
  });

  await app.register(healthRoutes);
  await app.register(predictionsRoutes, { prefix: '/predictions' });
  await app.register(sourcesRoutes, { prefix: '/sources' });
  await app.register(bullBoardPlugin);

  return app;
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { healthRoutes } from '../src/api/routes/health.js';
import { predictionsRoutes } from '../src/api/routes/predictions.js';
import { sourcesRoutes } from '../src/api/routes/sources.js';
import { analystRoutes } from '../src/api/routes/analyst.js';

let app: ReturnType<typeof Fastify> | null = null;

async function getApp() {
  if (app) return app;

  app = Fastify({ logger: false });

  // CORS for Vercel (static assets served from same origin, but just in case)
  app.addHook('onSend', async (_req: FastifyRequest, reply: FastifyReply) => {
    void reply.header('Access-Control-Allow-Origin', '*');
    void reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    void reply.header('Access-Control-Allow-Headers', 'Content-Type, If-None-Match');
  });

  await app.register(healthRoutes);
  await app.register(predictionsRoutes, { prefix: '/predictions' });
  await app.register(sourcesRoutes, { prefix: '/sources' });
  await app.register(analystRoutes, { prefix: '/analyst' });
  await app.ready();
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const fastify = await getApp();
  fastify.server.emit('request', req, res);
}

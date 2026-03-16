import type { IncomingMessage, ServerResponse } from 'node:http';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { predictionsRoutes } from '../src/api/routes/predictions.js';

let app: ReturnType<typeof Fastify> | null = null;

async function getApp() {
  if (app) return app;

  app = Fastify({ logger: false });

  app.addHook('onSend', async (_req: FastifyRequest, reply: FastifyReply) => {
    void reply.header('Access-Control-Allow-Origin', '*');
    void reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    void reply.header('Access-Control-Allow-Headers', 'Content-Type');
  });

  app.options('/*', async (_req, reply) => reply.status(204).send());

  app.get('/health', async () => ({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    wsClients: 0,
    services: { database: 'n/a' },
  }));

  await app.register(predictionsRoutes, { prefix: '/predictions' });
  await app.ready();
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const fastify = await getApp();
  fastify.server.emit('request', req, res);
}

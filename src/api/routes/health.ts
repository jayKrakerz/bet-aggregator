import type { FastifyPluginAsync } from 'fastify';
import { sql } from '../../db/pool.js';
import { getClientCount } from '../ws-hub.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => {
    const dbCheck = await sql`SELECT 1 as ok`.catch(() => null);
    return {
      status: dbCheck ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      wsClients: getClientCount(),
      services: {
        database: dbCheck ? 'up' : 'down',
      },
    };
  });
};

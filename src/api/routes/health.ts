import type { FastifyPluginAsync } from 'fastify';
import { sql } from '../../db/pool.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => {
    const dbCheck = await sql`SELECT 1 as ok`.catch(() => null);
    return {
      status: dbCheck ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      services: {
        database: dbCheck ? 'up' : 'down',
      },
    };
  });
};

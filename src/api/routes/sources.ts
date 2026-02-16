import type { FastifyPluginAsync } from 'fastify';
import { sql } from '../../db/pool.js';

export const sourcesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async () => {
    const sources = await sql`
      SELECT id, slug, name, base_url, fetch_method, is_active, last_fetched_at, created_at
      FROM sources
      ORDER BY name
    `;
    return { data: sources };
  });
};

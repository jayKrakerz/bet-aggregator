import type { FastifyPluginAsync } from 'fastify';
import { Queue } from 'bullmq';
import { sql } from '../../db/pool.js';
import { config } from '../../config.js';
import { QUEUE_NAMES, JOB_NAMES } from '../../scheduler/constants.js';
import { getAllAdapters } from '../../adapters/index.js';

export const sourcesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async () => {
    const sources = await sql`
      SELECT id, slug, name, base_url, fetch_method, is_active, last_fetched_at, created_at
      FROM sources
      ORDER BY name
    `;
    return { data: sources };
  });

  app.get('/status', async () => {
    const rows = await sql`
      SELECT s.slug, s.name, s.last_fetched_at,
        COUNT(p.id) FILTER (WHERE p.created_at >= CURRENT_DATE) as today_count,
        COUNT(p.id) FILTER (WHERE p.created_at >= CURRENT_DATE - INTERVAL '7 days') as week_count
      FROM sources s
      LEFT JOIN predictions p ON p.source_id = s.id
      GROUP BY s.id, s.slug, s.name, s.last_fetched_at
      ORDER BY today_count DESC, week_count DESC
    `;
    return { data: rows };
  });

  app.post('/trigger-all', async () => {
    const fetchQueue = new Queue(QUEUE_NAMES.FETCH, {
      connection: { host: config.REDIS_HOST, port: config.REDIS_PORT },
    });

    const adapters = getAllAdapters();
    const jobIds: string[] = [];

    for (const adapter of adapters) {
      const { id, baseUrl, paths } = adapter.config;
      for (const [sport, urlPath] of Object.entries(paths)) {
        const url = `${baseUrl}${urlPath}`;
        const job = await fetchQueue.add(JOB_NAMES.FETCH_SITE, {
          adapterId: id,
          sport,
          path: urlPath,
          url,
        });
        if (job.id) jobIds.push(job.id);
      }
    }

    await fetchQueue.close();
    return { success: true, enqueued: jobIds.length, jobIds };
  });

  app.post<{ Body: { jobIds: string[] } }>('/fetch-status', async (request) => {
    const { jobIds } = request.body;
    if (!jobIds || !jobIds.length) return { completed: 0, failed: 0, pending: 0, total: 0 };

    const fetchQueue = new Queue(QUEUE_NAMES.FETCH, {
      connection: { host: config.REDIS_HOST, port: config.REDIS_PORT },
    });

    let completed = 0;
    let failed = 0;
    let pending = 0;

    for (const id of jobIds) {
      const job = await fetchQueue.getJob(id);
      if (!job) { completed++; continue; }
      const state = await job.getState();
      if (state === 'completed') completed++;
      else if (state === 'failed') failed++;
      else pending++;
    }

    await fetchQueue.close();
    return { completed, failed, pending, total: jobIds.length };
  });
};

import { getAllAdapters } from '../adapters/index.js';
import { fetchQueue } from './queues.js';
import { JOB_NAMES } from './constants.js';
import { logger } from '../utils/logger.js';

/**
 * Sets up BullMQ repeatable job schedulers for each adapter + sport combo.
 * Uses upsertJobScheduler so restarts are idempotent.
 */
export async function startScheduler(): Promise<void> {
  const adapters = getAllAdapters();

  for (const adapter of adapters) {
    const { id, cron, paths, baseUrl } = adapter.config;

    for (const [sport, urlPath] of Object.entries(paths)) {
      const schedulerId = `${id}:${sport}`;

      await fetchQueue.upsertJobScheduler(
        schedulerId,
        { pattern: cron },
        {
          name: JOB_NAMES.FETCH_SITE,
          data: {
            adapterId: id,
            sport,
            path: urlPath,
            url: `${baseUrl}${urlPath}`,
          },
          opts: {
            attempts: adapter.config.maxRetries,
            backoff: adapter.config.backoff,
          },
        },
      );

      logger.info({ schedulerId, cron }, `Registered job scheduler`);
    }
  }

  logger.info(`Scheduler initialized with ${adapters.length} adapters`);
}

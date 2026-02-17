import { getAllAdapters } from '../adapters/index.js';
import { fetchQueue, resultsQueue, alertQueue } from './queues.js';
import { JOB_NAMES } from './constants.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const RESULTS_SPORTS = ['nba', 'nfl', 'nhl', 'mlb'];

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

  // Results fetching: hourly 9-23h for today, 3x/day for yesterday
  for (const sport of RESULTS_SPORTS) {
    // Today's results — hourly during active hours
    await resultsQueue.upsertJobScheduler(
      `results:${sport}:today`,
      { pattern: '0 9-23 * * *' },
      {
        name: JOB_NAMES.FETCH_RESULTS,
        data: {
          sport,
          date: 'today',
        },
      },
    );

    // Yesterday's results — 3x per day to catch late finalizations
    await resultsQueue.upsertJobScheduler(
      `results:${sport}:yesterday`,
      { pattern: '0 6,12,18 * * *' },
      {
        name: JOB_NAMES.FETCH_RESULTS,
        data: {
          sport,
          date: 'yesterday',
        },
      },
    );

    logger.info({ sport }, 'Registered results scheduler');
  }

  // Telegram alert scheduler — every 2 hours (only processes if token is set)
  if (config.TELEGRAM_BOT_TOKEN) {
    await alertQueue.upsertJobScheduler(
      'telegram-alerts',
      { pattern: '0 */2 * * *' },
      {
        name: JOB_NAMES.SEND_ALERTS,
        data: {},
      },
    );
    logger.info('Registered Telegram alert scheduler');
  }

  logger.info(`Scheduler initialized with ${adapters.length} adapters`);
}

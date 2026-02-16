import { createServer } from './api/server.js';
import { startScheduler } from './scheduler/index.js';
import { createFetchWorker } from './workers/fetch-worker.js';
import { createParseWorker } from './workers/parse-worker.js';
import { loadTeamAliases } from './pipeline/team-resolver.js';
import { closeBrowser } from './workers/browser-pool.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  logger.info('Starting bet-aggregator...');

  // Load team alias cache
  await loadTeamAliases();

  // Start scheduler (registers cron jobs)
  await startScheduler();

  // Start workers
  const fetchWorker = createFetchWorker();
  const parseWorker = createParseWorker();
  logger.info('Workers started: fetch-worker, parse-worker');

  // Start API server
  const server = await createServer();
  await server.listen({ port: config.PORT, host: '0.0.0.0' });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await server.close();
    await fetchWorker.close();
    await parseWorker.close();
    await closeBrowser();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal(err, 'Failed to start');
  process.exit(1);
});

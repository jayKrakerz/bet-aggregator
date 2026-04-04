import 'dotenv/config';
import { createServer } from './api/server.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { closeVirtualBrowser, getBrowser } from './api/virtual-scraper.js';
import { setBrowserProvider, scrapeResults as collectVirtualResults } from './api/virtual-results.js';

const VIRTUAL_COLLECT_INTERVAL = 5 * 60 * 1000; // 5 minutes

async function main(): Promise<void> {
  const server = await createServer();
  await server.listen({ port: config.PORT, host: '0.0.0.0' });

  // Wire virtual results scraper to share the browser instance
  setBrowserProvider(getBrowser);

  // Background collection of virtual results every 5 minutes
  const collectLoop = async () => {
    try {
      await collectVirtualResults();
    } catch (err) {
      logger.error({ err }, 'Background virtual collection failed');
    }
  };
  // First collection after 30s (let server stabilize)
  setTimeout(() => void collectLoop(), 30_000);
  setInterval(() => void collectLoop(), VIRTUAL_COLLECT_INTERVAL);

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await closeVirtualBrowser();
    await server.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal(err, 'Failed to start');
  process.exit(1);
});

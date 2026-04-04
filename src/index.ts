import 'dotenv/config';
import { createServer } from './api/server.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';

const VIRTUAL_COLLECT_INTERVAL = 5 * 60 * 1000; // 5 minutes

async function main(): Promise<void> {
  const server = await createServer();
  await server.listen({ port: config.PORT, host: '0.0.0.0' });

  // Virtual results collection — lazy-load to avoid crash when puppeteer is unavailable (e.g. Vercel)
  try {
    const { getBrowser, closeVirtualBrowser } = await import('./api/virtual-scraper.js');
    const { setBrowserProvider, scrapeResults: collectVirtualResults } = await import('./api/virtual-results.js');

    setBrowserProvider(getBrowser);

    const collectLoop = async () => {
      try {
        await collectVirtualResults();
      } catch (err) {
        logger.error({ err }, 'Background virtual collection failed');
      }
    };
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
  } catch (err) {
    logger.warn({ err }, 'Virtual scraper unavailable — skipping background collection');

    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down...`);
      await server.close();
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  }
}

main().catch((err) => {
  logger.fatal(err, 'Failed to start');
  process.exit(1);
});

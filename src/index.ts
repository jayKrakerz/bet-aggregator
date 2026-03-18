import 'dotenv/config';
import { createServer } from './api/server.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  const server = await createServer();
  await server.listen({ port: config.PORT, host: '0.0.0.0' });

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
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

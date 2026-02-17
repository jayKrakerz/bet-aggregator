import { Redis } from 'ioredis';
import { config } from '../config.js';

const isVercel = !!process.env.VERCEL;

function createRedis(): Redis {
  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    // Cloud Redis (Upstash, Redis Cloud, etc.) — URL includes auth + TLS
    return new Redis(redisUrl, {
      maxRetriesPerRequest: isVercel ? 1 : null,
      lazyConnect: true,
      enableOfflineQueue: !isVercel,
    });
  }

  return new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    maxRetriesPerRequest: isVercel ? 1 : null,
    lazyConnect: true,
    enableOfflineQueue: !isVercel,
  });
}

export const redis = createRedis();

redis.connect().catch(() => {
  // Connection will retry automatically (or fail fast on Vercel)
});

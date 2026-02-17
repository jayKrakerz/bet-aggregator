import { createHash } from 'node:crypto';
import { redis } from '../db/redis.js';
import { logger } from '../utils/logger.js';

const TTL_SECONDS = 300; // 5 minutes

function buildKey(parts: string[]): string {
  return `scored:${parts.join(':')}`;
}

export async function getCached<T>(parts: string[]): Promise<T | null> {
  try {
    const raw = await redis.get(buildKey(parts));
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setCached(parts: string[], data: unknown): Promise<void> {
  try {
    await redis.set(buildKey(parts), JSON.stringify(data), 'EX', TTL_SECONDS);
  } catch (err) {
    logger.warn({ err }, 'Cache set failed');
  }
}

/**
 * Invalidate all cached keys for a given sport+date pattern using SCAN.
 */
export async function invalidateCache(sport: string, date: string): Promise<void> {
  try {
    const pattern = `scored:${sport}:${date}:*`;
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.warn({ err }, 'Cache invalidation failed');
  }
}

export function computeETag(data: unknown): string {
  const hash = createHash('md5').update(JSON.stringify(data)).digest('hex');
  return `"${hash}"`;
}

import { redis } from '../db/redis.js';

const PREFIX = 'alert:sent:';
const TTL_SECONDS = 86400; // 24 hours

export async function isAlertSent(key: string): Promise<boolean> {
  const exists = await redis.exists(`${PREFIX}${key}`);
  return exists === 1;
}

export async function markAlertSent(key: string): Promise<void> {
  await redis.set(`${PREFIX}${key}`, '1', 'EX', TTL_SECONDS);
}

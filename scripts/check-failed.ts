import { Queue } from 'bullmq';
import { config } from '../src/config.js';

const q = new Queue('fetch-queue', { connection: { host: config.REDIS_HOST, port: config.REDIS_PORT } });

const failed = await q.getFailed(0, 20);
console.log(`Total failed: ${failed.length}\n`);
for (const j of failed) {
  console.log(`${j.data.adapterId} | ${j.data.sport} | ${(j.failedReason || '').slice(0, 200)}`);
}

await q.close();

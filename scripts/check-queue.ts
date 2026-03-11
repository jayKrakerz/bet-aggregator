import { Queue } from 'bullmq';
import { config } from '../src/config.js';

const q = new Queue('fetch-queue', { connection: { host: config.REDIS_HOST, port: config.REDIS_PORT } });

const failed = await q.getFailed(0, 10);
console.log(`\nFailed jobs (${failed.length} shown):`);
for (const j of failed) {
  console.log(`  ${j.data.adapterId}:${j.data.sport} — ${j.failedReason?.slice(0, 150)}`);
}

const waiting = await q.getWaiting(0, 10);
console.log(`\nWaiting jobs (${waiting.length} shown):`);
for (const j of waiting) {
  console.log(`  ${j.data.adapterId}:${j.data.sport}`);
}

const counts = await q.getJobCounts();
console.log('\nQueue counts:', counts);

await q.close();

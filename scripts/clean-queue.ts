import { Queue } from 'bullmq';
import { config } from '../src/config.js';

const q = new Queue('fetch-queue', { connection: { host: config.REDIS_HOST, port: config.REDIS_PORT } });

// Clean failed and completed jobs
const failedCount = await q.clean(0, 10000, 'failed');
const completedCount = await q.clean(0, 10000, 'completed');

// Drain waiting jobs
await q.drain();

const counts = await q.getJobCounts();
console.log(`Cleaned ${failedCount.length} failed, ${completedCount.length} completed jobs`);
console.log('Queue counts after clean:', counts);

await q.close();

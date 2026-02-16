/**
 * Check BullMQ queue status.
 * Usage: npx tsx scripts/check-queues.ts
 */
import { Queue } from 'bullmq';
import { config } from '../src/config.js';
import { QUEUE_NAMES } from '../src/scheduler/constants.js';

const connection = { host: config.REDIS_HOST, port: config.REDIS_PORT };

for (const name of [QUEUE_NAMES.FETCH, QUEUE_NAMES.PARSE]) {
  const queue = new Queue(name, { connection });

  const counts = await queue.getJobCounts();
  console.log(`\n=== Queue: ${name} ===`);
  console.log(`  waiting: ${counts.waiting}, active: ${counts.active}, completed: ${counts.completed}, failed: ${counts.failed}, delayed: ${counts.delayed}`);

  // Show recent failed jobs
  const failed = await queue.getFailed(0, 5);
  for (const job of failed) {
    console.log(`  FAILED [${job.id}]: ${job.failedReason}`);
    console.log(`    data: ${JSON.stringify(job.data).slice(0, 200)}`);
  }

  // Show recent completed jobs
  const completed = await queue.getCompleted(0, 5);
  for (const job of completed) {
    console.log(`  COMPLETED [${job.id}]: ${JSON.stringify(job.data).slice(0, 200)}`);
  }

  // Show waiting jobs
  const waiting = await queue.getWaiting(0, 5);
  for (const job of waiting) {
    console.log(`  WAITING [${job.id}]: ${JSON.stringify(job.data).slice(0, 200)}`);
  }

  await queue.close();
}

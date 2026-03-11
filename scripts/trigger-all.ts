/**
 * Trigger fetch jobs for ALL adapter/sport combos immediately.
 * Usage: npx tsx scripts/trigger-all.ts
 */
import { Queue } from 'bullmq';
import { config } from '../src/config.js';
import { QUEUE_NAMES, JOB_NAMES } from '../src/scheduler/constants.js';
import { getAllAdapters } from '../src/adapters/index.js';

const fetchQueue = new Queue(QUEUE_NAMES.FETCH, {
  connection: { host: config.REDIS_HOST, port: config.REDIS_PORT },
});

const adapters = getAllAdapters();
let count = 0;

for (const adapter of adapters) {
  const { id, baseUrl, paths } = adapter.config;
  for (const [sport, urlPath] of Object.entries(paths)) {
    const url = `${baseUrl}${urlPath}`;
    await fetchQueue.add(JOB_NAMES.FETCH_SITE, {
      adapterId: id,
      sport,
      path: urlPath,
      url,
    });
    count++;
    console.log(`  enqueued ${id}:${sport}`);
  }
}

console.log(`\nEnqueued ${count} fetch jobs. Watch logs in the running app process.`);
await fetchQueue.close();

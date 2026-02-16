/**
 * Manually trigger a fetch job for testing the full pipeline.
 * Usage: npx tsx scripts/trigger-fetch.ts [adapterId] [sport]
 * Default: covers-com nba
 */
import { Queue } from 'bullmq';
import { config } from '../src/config.js';
import { QUEUE_NAMES, JOB_NAMES } from '../src/scheduler/constants.js';
import { getAdapter } from '../src/adapters/index.js';

const adapterId = process.argv[2] || 'covers-com';
const sport = process.argv[3] || 'nba';

const adapter = getAdapter(adapterId);
const urlPath = adapter.config.paths[sport];
if (!urlPath) {
  console.error(`No path configured for adapter=${adapterId} sport=${sport}`);
  process.exit(1);
}

const url = `${adapter.config.baseUrl}${urlPath}`;

const fetchQueue = new Queue(QUEUE_NAMES.FETCH, {
  connection: { host: config.REDIS_HOST, port: config.REDIS_PORT },
});

const job = await fetchQueue.add(JOB_NAMES.FETCH_SITE, {
  adapterId,
  sport,
  path: urlPath,
  url,
});

console.log(`Enqueued fetch job: ${job.id}`);
console.log(`  adapter: ${adapterId}`);
console.log(`  sport: ${sport}`);
console.log(`  url: ${url}`);
console.log(`\nWatch logs in the running app process.`);

await fetchQueue.close();

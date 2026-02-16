import { Worker, type Job } from 'bullmq';
import fs from 'node:fs';
import { config } from '../config.js';
import { QUEUE_NAMES } from '../scheduler/constants.js';
import { getAdapter } from '../adapters/index.js';
import { normalizeAndInsert } from '../pipeline/normalizer.js';
import { logger } from '../utils/logger.js';

interface ParseJobData {
  adapterId: string;
  sport: string;
  snapshotPath: string;
  fetchedAt: string;
}

const connection = { host: config.REDIS_HOST, port: config.REDIS_PORT };

export function createParseWorker() {
  const worker = new Worker<ParseJobData>(
    QUEUE_NAMES.PARSE,
    async (job: Job<ParseJobData>) => {
      const { adapterId, sport, snapshotPath, fetchedAt } = job.data;
      const adapter = getAdapter(adapterId);
      const log = logger.child({ job: job.id, adapter: adapterId, sport });

      const html = fs.readFileSync(snapshotPath, 'utf-8');
      const rawPredictions = adapter.parse(html, sport, new Date(fetchedAt));

      log.info({ count: rawPredictions.length }, 'Parsed predictions from snapshot');

      if (rawPredictions.length === 0) {
        log.warn('No predictions parsed from snapshot — adapter selectors may need updating');
        return;
      }

      const inserted = await normalizeAndInsert(rawPredictions);
      log.info({ inserted }, 'Predictions normalized and inserted');
    },
    {
      connection,
      concurrency: 5,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error({ job: job?.id, err: err.message }, 'Parse job failed');
  });

  return worker;
}

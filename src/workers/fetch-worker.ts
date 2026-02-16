import { Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { QUEUE_NAMES, JOB_NAMES } from '../scheduler/constants.js';
import { fetchQueue, parseQueue } from '../scheduler/queues.js';
import { getAdapter } from '../adapters/index.js';
import { fetchHttp } from './http-client.js';
import { fetchBrowser } from './browser-pool.js';
import { saveSnapshot } from '../snapshots/storage.js';
import { checkRobotsTxt } from '../compliance/robots-checker.js';
import { acquireRateLimit } from '../compliance/rate-limiter.js';
import { updateSourceLastFetched } from '../db/queries.js';
import { logger } from '../utils/logger.js';

interface FetchJobData {
  adapterId: string;
  sport: string;
  path: string;
  url: string;
  /** If true, this is a discovered sub-URL (skip discoverUrls) */
  isSubUrl?: boolean;
}

const connection = { host: config.REDIS_HOST, port: config.REDIS_PORT };

async function doFetch(
  url: string,
  adapter: ReturnType<typeof getAdapter>,
): Promise<{ html: string; httpStatus: number | null }> {
  if (adapter.config.fetchMethod === 'browser') {
    return {
      html: await fetchBrowser(url, adapter.browserActions?.bind(adapter)),
      httpStatus: null,
    };
  }
  const result = await fetchHttp(url);
  return { html: result.body, httpStatus: result.status };
}

export function createFetchWorker() {
  const worker = new Worker<FetchJobData>(
    QUEUE_NAMES.FETCH,
    async (job: Job<FetchJobData>) => {
      const { adapterId, sport, path: urlPath, url, isSubUrl } = job.data;
      const adapter = getAdapter(adapterId);
      const log = logger.child({ job: job.id, adapter: adapterId, sport, url });

      // Compliance: check robots.txt
      const pathToCheck = isSubUrl ? new URL(url).pathname : urlPath;
      const allowed = await checkRobotsTxt(adapter.config.baseUrl, pathToCheck);
      if (!allowed) {
        log.warn('Blocked by robots.txt, skipping');
        return;
      }

      // Rate limiting
      await acquireRateLimit(adapterId, adapter.config.rateLimitMs);

      const startMs = Date.now();
      const { html, httpStatus } = await doFetch(url, adapter);
      const durationMs = Date.now() - startMs;
      const fetchedAt = new Date();

      // Save snapshot to disk
      const snapshotMeta = saveSnapshot({
        sourceId: adapterId,
        sport,
        url,
        fetchMethod: adapter.config.fetchMethod,
        httpStatus,
        durationMs,
        sizeBytes: Buffer.byteLength(html, 'utf-8'),
        fetchedAt: fetchedAt.toISOString(),
        html,
      });

      log.info({ durationMs, sizeBytes: snapshotMeta.sizeBytes }, 'Fetch completed');
      await updateSourceLastFetched(adapterId);

      // If adapter supports URL discovery and this is the landing page,
      // enqueue child fetch jobs for each discovered URL
      if (!isSubUrl && adapter.discoverUrls) {
        const subUrls = adapter.discoverUrls(html, sport);
        if (subUrls.length > 0) {
          log.info({ count: subUrls.length }, 'Discovered sub-URLs, enqueuing');
          for (const subUrl of subUrls) {
            await fetchQueue.add(JOB_NAMES.FETCH_SITE, {
              adapterId,
              sport,
              path: new URL(subUrl).pathname,
              url: subUrl,
              isSubUrl: true,
            });
          }
          // Fall through — landing page may also contain predictions
        }
      }

      // Enqueue parse job for this page
      await parseQueue.add(JOB_NAMES.PARSE_SNAPSHOT, {
        adapterId,
        sport,
        snapshotPath: snapshotMeta.htmlPath,
        fetchedAt: fetchedAt.toISOString(),
      });
    },
    {
      connection,
      concurrency: 3,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error({ job: job?.id, err: err.message }, 'Fetch job failed');
  });

  return worker;
}

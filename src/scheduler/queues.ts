import { Queue } from 'bullmq';
import { config } from '../config.js';
import { QUEUE_NAMES } from './constants.js';

const connection = { host: config.REDIS_HOST, port: config.REDIS_PORT };

export const fetchQueue = new Queue(QUEUE_NAMES.FETCH, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

export const parseQueue = new Queue(QUEUE_NAMES.PARSE, {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 2000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

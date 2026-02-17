export const QUEUE_NAMES = {
  FETCH: 'fetch-queue',
  PARSE: 'parse-queue',
  RESULTS: 'results-queue',
  ALERT: 'alert-queue',
} as const;

export const JOB_NAMES = {
  FETCH_SITE: 'fetch-site',
  PARSE_SNAPSHOT: 'parse-snapshot',
  FETCH_RESULTS: 'fetch-results',
  SEND_ALERTS: 'send-alerts',
} as const;

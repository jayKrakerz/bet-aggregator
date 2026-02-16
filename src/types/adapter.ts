import type { Page } from 'playwright';
import type { RawPrediction } from './prediction.js';

export type FetchMethod = 'http' | 'browser';

export interface SiteAdapterConfig {
  id: string;
  name: string;
  baseUrl: string;
  fetchMethod: FetchMethod;
  /** URL paths to scrape, keyed by sport slug */
  paths: Record<string, string>;
  /** Cron expression (6-field with seconds) */
  cron: string;
  /** Minimum delay between requests in ms */
  rateLimitMs: number;
  maxRetries: number;
  backoff: { type: 'exponential' | 'fixed'; delay: number };
}

export interface SiteAdapter {
  readonly config: SiteAdapterConfig;

  /** Parse raw HTML into an array of raw predictions. */
  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[];

  /**
   * Optional: discover sub-URLs from a landing/index page.
   * If present, the fetch worker will fetch each discovered URL
   * and feed it back through parse().
   */
  discoverUrls?(html: string, sport: string): string[];

  /** For browser-rendered sites: actions before capturing HTML. */
  browserActions?(page: Page): Promise<void>;
}

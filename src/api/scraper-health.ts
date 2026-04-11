/**
 * Scraper Health Registry
 *
 * Central in-memory tracker for every scraper's last run. Lets the
 * dashboard (and humans debugging a yield drop) see which source just
 * died instead of guessing which of 15+ scrapers is broken.
 *
 * Usage: every scraper's top-level invocation wraps itself in
 * withScraperHealth(name, fn) or calls recordScraperRun() directly.
 */

export interface ScraperHealth {
  /** Scraper identifier, e.g. "sportPremi" or "betclan" */
  name: string;
  /** Millis since epoch of the most recent run (success or failure) */
  lastRunAt: number;
  /** Millis since epoch of the most recent successful run */
  lastSuccessAt: number | null;
  /** Most recent run's duration in ms */
  lastDurationMs: number;
  /** Items returned by the most recent successful run */
  lastCount: number;
  /** Error message from the most recent failed run (cleared on success) */
  lastError: string | null;
  /** Total runs recorded since process start */
  totalRuns: number;
  /** Total successes */
  successes: number;
  /** Total failures */
  failures: number;
  /** Rolling success rate, 0-1 */
  successRate: number;
  /** Health classification for the UI */
  status: 'healthy' | 'stale' | 'degraded' | 'failing' | 'unknown';
}

const registry = new Map<string, ScraperHealth>();

// A scraper that hasn't run in this long is "stale" — probably lost from
// the refresh loop or stuck behind a hung import.
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

function classify(h: ScraperHealth): ScraperHealth['status'] {
  if (h.totalRuns === 0) return 'unknown';
  const sinceLast = Date.now() - h.lastRunAt;
  if (sinceLast > STALE_THRESHOLD_MS) return 'stale';
  // Last run failed AND recent success rate is poor → failing
  if (h.lastError && h.successRate < 0.3) return 'failing';
  // Last run failed but overall rate is OK → degraded (transient blip)
  if (h.lastError) return 'degraded';
  return 'healthy';
}

export function recordScraperRun(
  name: string,
  outcome: { ok: boolean; count?: number; durationMs: number; error?: string },
): void {
  let entry = registry.get(name);
  if (!entry) {
    entry = {
      name,
      lastRunAt: 0,
      lastSuccessAt: null,
      lastDurationMs: 0,
      lastCount: 0,
      lastError: null,
      totalRuns: 0,
      successes: 0,
      failures: 0,
      successRate: 0,
      status: 'unknown',
    };
    registry.set(name, entry);
  }

  const now = Date.now();
  entry.lastRunAt = now;
  entry.lastDurationMs = outcome.durationMs;
  entry.totalRuns++;

  if (outcome.ok) {
    entry.successes++;
    entry.lastSuccessAt = now;
    entry.lastCount = outcome.count ?? 0;
    entry.lastError = null;
  } else {
    entry.failures++;
    entry.lastError = outcome.error ?? 'unknown error';
  }

  entry.successRate = Math.round((entry.successes / entry.totalRuns) * 1000) / 1000;
  entry.status = classify(entry);
}

/**
 * Convenience wrapper: run a scraper fn, time it, and record the
 * outcome. Resolves to the scraper's return value on success or throws
 * on failure (so callers can still handle the error).
 */
export async function withScraperHealth<T>(
  name: string,
  fn: () => Promise<T>,
  countOf?: (result: T) => number,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    recordScraperRun(name, {
      ok: true,
      count: countOf ? countOf(result) : undefined,
      durationMs: Date.now() - start,
    });
    return result;
  } catch (err) {
    recordScraperRun(name, {
      ok: false,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Snapshot every scraper's current health. Refreshes the `status` field
 * so a scraper that was healthy 40 min ago is now reported as `stale`.
 */
export function getScraperHealth(): ScraperHealth[] {
  const out: ScraperHealth[] = [];
  for (const entry of registry.values()) {
    entry.status = classify(entry);
    out.push({ ...entry });
  }
  // Sort: failing / stale / degraded first, then healthy, by name
  const order: Record<ScraperHealth['status'], number> = {
    failing: 0,
    stale: 1,
    degraded: 2,
    unknown: 3,
    healthy: 4,
  };
  out.sort((a, b) => {
    const d = order[a.status] - order[b.status];
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
  return out;
}

/**
 * Aggregate rollup for a dashboard tile.
 */
export function getScraperHealthSummary(): {
  total: number;
  healthy: number;
  stale: number;
  degraded: number;
  failing: number;
  unknown: number;
  oldestLastRunAgo: number | null;
} {
  const all = getScraperHealth();
  const summary = {
    total: all.length,
    healthy: 0,
    stale: 0,
    degraded: 0,
    failing: 0,
    unknown: 0,
    oldestLastRunAgo: null as number | null,
  };
  const now = Date.now();
  let oldestLastRun: number | null = null;
  for (const s of all) {
    summary[s.status]++;
    if (s.lastRunAt > 0 && (oldestLastRun === null || s.lastRunAt < oldestLastRun)) {
      oldestLastRun = s.lastRunAt;
    }
  }
  if (oldestLastRun !== null) summary.oldestLastRunAgo = now - oldestLastRun;
  return summary;
}

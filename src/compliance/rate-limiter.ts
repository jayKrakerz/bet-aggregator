/**
 * Simple in-memory per-source rate limiter.
 * Sufficient for Phase 1 single-process deployment.
 */
const lastRequest = new Map<string, number>();

export async function acquireRateLimit(
  sourceId: string,
  minDelayMs: number,
): Promise<void> {
  const now = Date.now();
  const last = lastRequest.get(sourceId) ?? 0;
  const elapsed = now - last;

  if (elapsed < minDelayMs) {
    const waitMs = minDelayMs - elapsed;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  lastRequest.set(sourceId, Date.now());
}

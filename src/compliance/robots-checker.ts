import { request } from 'undici';
import { logger } from '../utils/logger.js';

const cache = new Map<string, { lines: string[]; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function checkRobotsTxt(
  baseUrl: string,
  path: string,
): Promise<boolean> {
  const cached = cache.get(baseUrl);
  const now = Date.now();

  let lines: string[];

  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    lines = cached.lines;
  } else {
    try {
      const { body } = await request(`${baseUrl}/robots.txt`, {
        headersTimeout: 5000,
      });
      const text = await body.text();
      lines = text.split('\n');
      cache.set(baseUrl, { lines, fetchedAt: now });
    } catch (err) {
      logger.warn({ baseUrl, err }, 'Failed to fetch robots.txt, allowing by default');
      return true;
    }
  }

  // Simple parser: find User-agent: * block and check Disallow rules
  let inWildcardBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith('user-agent:')) {
      const agent = trimmed.split(':')[1]?.trim();
      inWildcardBlock = agent === '*';
    }
    if (inWildcardBlock && trimmed.toLowerCase().startsWith('disallow:')) {
      const disallowed = trimmed
        .split(':')
        .slice(1)
        .join(':')
        .trim()
        .split('#')[0]
        ?.trim();
      if (disallowed && path.startsWith(disallowed)) {
        logger.info({ baseUrl, path, disallowed }, 'Path blocked by robots.txt');
        return false;
      }
    }
  }

  return true;
}

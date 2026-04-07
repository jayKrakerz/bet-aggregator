/**
 * Meta Code Scrapers
 *
 * Scrapes codes from meta-sources: Reddit, DuckDuckGo search results,
 * and any other aggregation points that collect codes from the wider internet.
 */

import { logger } from '../utils/logger.js';
import { isValidCode, todayLocal, type BookingCode } from './booking-codes-scraper.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

function extractValidCodes(text: string): string[] {
  const upper = text.toUpperCase();
  const matches = upper.match(/\b[A-Z0-9]{6}\b/g) || [];
  return [...new Set(matches.filter(m => {
    if (!isValidCode(m)) return false;
    if (!/[0-9]/.test(m)) return false;
    if ((m.match(/[A-Z]/g) || []).length < 2) return false;
    if (/^\d+[A-Z]+$/.test(m)) return false;
    return true;
  }))];
}

function makeCode(code: string, source: string, sourceUrl: string): BookingCode {
  return {
    code, source, sourceUrl,
    events: null, totalOdds: null, market: null,
    date: todayLocal(), status: 'pending', postedAgo: null,
    validated: false, isValid: false, selections: [],
    wonCount: 0, lostCount: 0, pendingCount: 0,
  };
}

// =========================================================================
// REDDIT — search r/SportyBetcodes and related subreddits
// =========================================================================

const REDDIT_SEARCHES = [
  'https://old.reddit.com/r/sportsbetting/search.json?q=sportybet+code&sort=new&limit=50&restrict_sr=off&t=week',
  'https://old.reddit.com/r/SportyBetcodes/new.json?limit=50',
  'https://old.reddit.com/search.json?q=sportybet+booking+code&sort=new&limit=50&t=week',
];

async function scrapeReddit(): Promise<BookingCode[]> {
  const codes: BookingCode[] = [];
  const seen = new Set<string>();

  for (const url of REDDIT_SEARCHES) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'BetAggregator/1.0' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;

      const data = await res.json() as {
        data?: { children?: Array<{ data: { title: string; selftext: string; subreddit: string; permalink: string; created_utc: number } }> };
      };

      for (const child of data.data?.children ?? []) {
        const post = child.data;
        const text = `${post.title} ${post.selftext}`;
        const extracted = extractValidCodes(text);

        for (const code of extracted) {
          if (seen.has(code)) continue;
          seen.add(code);
          const c = makeCode(code, `Reddit (r/${post.subreddit})`, `https://old.reddit.com${post.permalink}`);
          // Calculate time ago
          const ago = Math.floor((Date.now() / 1000 - post.created_utc) / 3600);
          c.postedAgo = ago < 24 ? `${ago} hours ago` : `${Math.floor(ago / 24)} days ago`;
          codes.push(c);
        }
      }
    } catch {
      // silently skip
    }
  }

  return codes;
}

// =========================================================================
// SEARCH ENGINE — extract codes from DuckDuckGo search result snippets
// =========================================================================

const SEARCH_QUERIES = [
  'sportybet+booking+code+today',
  'sportybet+free+code+today',
  'sportybet+code+of+the+day',
];

async function scrapeSearchEngines(): Promise<BookingCode[]> {
  const codes: BookingCode[] = [];
  const seen = new Set<string>();

  for (const query of SEARCH_QUERIES) {
    try {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${query}`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;

      const html = await res.text();

      // Extract snippets
      const snippetRegex = /class="result__snippet">(.*?)<\/a>/gs;
      let match;
      while ((match = snippetRegex.exec(html)) !== null) {
        const snippet = match[1]!.replace(/<[^>]+>/g, ' ');
        const extracted = extractValidCodes(snippet);
        for (const code of extracted) {
          if (seen.has(code)) continue;
          seen.add(code);
          codes.push(makeCode(code, 'Search (DuckDuckGo)', 'https://duckduckgo.com/?q=' + query));
        }
      }

      // Also extract from result titles
      const titleRegex = /class="result__a"[^>]*>(.*?)<\/a>/gs;
      while ((match = titleRegex.exec(html)) !== null) {
        const title = match[1]!.replace(/<[^>]+>/g, ' ');
        const extracted = extractValidCodes(title);
        for (const code of extracted) {
          if (seen.has(code)) continue;
          seen.add(code);
          codes.push(makeCode(code, 'Search (DuckDuckGo)', 'https://duckduckgo.com/?q=' + query));
        }
      }
    } catch {
      // silently skip
    }
  }

  return codes;
}

// =========================================================================
// CONFIRMBETS — Nigerian prediction site with booking codes
// =========================================================================

async function scrapeConfirmBets(): Promise<BookingCode[]> {
  const urls = [
    'https://confirmbets.com/free-booking-codes',
    'https://confirmbets.com/booking-codes/sportybet',
  ];

  const codes: BookingCode[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;

      const html = await res.text();
      if (!/sportybet/i.test(html)) continue;

      // Look for codes near sportybet mentions
      const sections = html.split(/sportybet/i);
      for (const section of sections.slice(1)) {
        // Get 500 chars after each sportybet mention
        const context = section.slice(0, 500);
        const extracted = extractValidCodes(context);
        for (const code of extracted) {
          if (seen.has(code)) continue;
          seen.add(code);
          codes.push(makeCode(code, 'ConfirmBets', url));
        }
      }
    } catch {
      // silently skip
    }
  }

  return codes;
}

// =========================================================================
// MAIN ENTRY
// =========================================================================

export async function scrapeMetaCodes(): Promise<BookingCode[]> {
  const [reddit, search, confirm] = await Promise.allSettled([
    scrapeReddit(),
    scrapeSearchEngines(),
    scrapeConfirmBets(),
  ]);

  const all: BookingCode[] = [];
  const seen = new Set<string>();

  for (const r of [reddit, search, confirm]) {
    if (r.status !== 'fulfilled') continue;
    for (const code of r.value) {
      if (seen.has(code.code)) continue;
      seen.add(code.code);
      all.push(code);
    }
  }

  logger.info({
    total: all.length,
    reddit: reddit.status === 'fulfilled' ? reddit.value.length : 0,
    search: search.status === 'fulfilled' ? search.value.length : 0,
    confirm: confirm.status === 'fulfilled' ? confirm.value.length : 0,
  }, 'Meta codes scraped');

  return all;
}

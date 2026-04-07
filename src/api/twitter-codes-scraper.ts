/**
 * Twitter/X Sportybet Code Scraper
 *
 * Scrapes booking codes from tipster accounts on Twitter/X using the
 * public syndication timeline endpoint (no API key needed).
 *
 * Falls back to Twitter API v2 search if TWITTER_BEARER_TOKEN is set.
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { isValidCode, todayLocal, type BookingCode } from './booking-codes-scraper.js';

// =========================================================================
// TIPSTER ACCOUNTS — add/remove accounts that post Sportybet booking codes
// =========================================================================

const TIPSTER_ACCOUNTS = [
  'SportyBet',        // Official — posts booking codes with odds
  'sportybetcode1',   // Dedicated sportybet codes account
  'BettingTipsMan',   // Posts daily sportybet codes
  'Dhavidtips',       // Tipster with sportybet codes
  'SportyBetNG',      // Sportybet Nigeria official
];

const SYNDICATION_URL = 'https://syndication.twitter.com/srv/timeline-profile/screen-name';

const HEADERS = {
  'Referer': 'https://platform.twitter.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// =========================================================================
// Types for syndication response
// =========================================================================

interface SyndicationTweet {
  text: string;
  created_at: string;
  conversation_id_str: string;
  user: { screen_name: string };
  entities: {
    urls: Array<{ expanded_url: string }>;
  };
}

interface SyndicationEntry {
  type: string;
  entry_id: string;
  content: {
    tweet: SyndicationTweet;
  };
}

interface SyndicationData {
  props: {
    pageProps: {
      timeline: {
        entries: SyndicationEntry[];
      };
    };
  };
}

// =========================================================================
// Helpers
// =========================================================================

function extractCodesFromText(text: string): string[] {
  const upper = text.toUpperCase();
  const matches = upper.match(/\b[A-Z0-9]{6,8}\b/g) || [];
  return [...new Set(matches.filter(m => {
    if (m.length !== 6 || !isValidCode(m)) return false;
    // Twitter tweets are full of English words that pass isValidCode.
    // Real Sportybet codes almost always mix letters and digits (e.g. ABLM3D, W4KYCJ).
    // Require at least 1 digit AND at least 2 letters to filter out junk.
    if (!/[0-9]/.test(m)) return false;
    if ((m.match(/[A-Z]/g) || []).length < 2) return false;
    // Reject tokens that are clearly not codes (time/number words)
    if (/^\d+[A-Z]+$/.test(m)) return false; // e.g. 10KODD, 3WEEKS, 2MONTH, 5ASIDE
    return true;
  }))];
}

function timeAgo(dateStr: string): string | null {
  try {
    const then = new Date(dateStr).getTime();
    const now = Date.now();
    const diffMs = now - then;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `${mins} minutes ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hours ago`;
    const days = Math.floor(hours / 24);
    return `${days} days ago`;
  } catch {
    return null;
  }
}

// =========================================================================
// SYNDICATION SCRAPER (free, no API key)
// =========================================================================

async function scrapeAccountTimeline(username: string): Promise<BookingCode[]> {
  try {
    const url = `${SYNDICATION_URL}/${username}?dnt=true&frame=false&hideHeader=true&hideFooter=true&hideScrollBar=true&tweetLimit=20`;
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(12000),
    });

    if (res.status === 429) {
      logger.warn({ username }, 'Twitter syndication rate limited');
      return [];
    }
    if (!res.ok) return [];

    const html = await res.text();

    // Extract __NEXT_DATA__ JSON from the server-rendered page
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/);
    if (!match) return [];

    const data = JSON.parse(match[1]!) as SyndicationData;
    const entries = data.props?.pageProps?.timeline?.entries ?? [];

    const codes: BookingCode[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
      if (entry.type !== 'tweet') continue;
      const tweet = entry.content?.tweet;
      if (!tweet?.text) continue;

      const extracted = extractCodesFromText(tweet.text);
      if (extracted.length === 0) continue;

      const screenName = tweet.user?.screen_name || username;
      const tweetId = entry.entry_id.replace('tweet-', '');
      const tweetUrl = `https://x.com/${screenName}/status/${tweetId}`;

      // Try to extract odds from tweet text
      const oddsMatch = tweet.text.match(/([\d,]+\.?\d*)\s*odds/i);
      const totalOdds = oddsMatch ? parseFloat(oddsMatch[1]!.replace(/,/g, '')) : null;

      for (const code of extracted) {
        if (seen.has(code)) continue;
        seen.add(code);

        codes.push({
          code,
          source: `Twitter (@${screenName})`,
          sourceUrl: tweetUrl,
          events: null,
          totalOdds,
          market: null,
          date: todayLocal(),
          status: 'pending',
          postedAgo: tweet.created_at ? timeAgo(tweet.created_at) : null,
          validated: false,
          isValid: false,
          selections: [],
          wonCount: 0,
          lostCount: 0,
          pendingCount: 0,
        });
      }
    }

    return codes;
  } catch (err) {
    logger.warn({ err, username }, 'Failed to scrape Twitter account');
    return [];
  }
}

// =========================================================================
// TWITTER API v2 SEARCH (requires TWITTER_BEARER_TOKEN)
// =========================================================================

const SEARCH_QUERIES = [
  'sportybet booking code -is:retweet',
  'sportybet code of the day -is:retweet',
  '"sportybet" "code" -is:retweet',
];

interface TwitterSearchResponse {
  data?: Array<{
    id: string;
    text: string;
    created_at?: string;
    author_id?: string;
  }>;
  includes?: {
    users?: Array<{ id: string; username: string }>;
  };
}

async function searchTwitterAPI(query: string, token: string): Promise<BookingCode[]> {
  const params = new URLSearchParams({
    query,
    max_results: '50',
    'tweet.fields': 'created_at,author_id',
    expansions: 'author_id',
    'user.fields': 'username',
  });

  const res = await fetch(`https://api.twitter.com/2/tweets/search/recent?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    if (res.status === 429) logger.warn('Twitter API rate limited');
    else logger.warn({ status: res.status }, 'Twitter API request failed');
    return [];
  }

  const data = (await res.json()) as TwitterSearchResponse;
  if (!data.data?.length) return [];

  const userMap = new Map<string, string>();
  for (const user of data.includes?.users ?? []) {
    userMap.set(user.id, user.username);
  }

  const codes: BookingCode[] = [];
  const seen = new Set<string>();

  for (const tweet of data.data) {
    const extracted = extractCodesFromText(tweet.text);
    if (extracted.length === 0) continue;

    const username = tweet.author_id ? userMap.get(tweet.author_id) : null;
    const tweetUrl = username
      ? `https://x.com/${username}/status/${tweet.id}`
      : `https://x.com/i/status/${tweet.id}`;

    const oddsMatch = tweet.text.match(/([\d,]+\.?\d*)\s*odds/i);

    for (const code of extracted) {
      if (seen.has(code)) continue;
      seen.add(code);
      codes.push({
        code,
        source: username ? `Twitter (@${username})` : 'Twitter',
        sourceUrl: tweetUrl,
        events: null,
        totalOdds: oddsMatch ? parseFloat(oddsMatch[1]!.replace(/,/g, '')) : null,
        market: null,
        date: todayLocal(),
        status: 'pending',
        postedAgo: tweet.created_at ? timeAgo(tweet.created_at) : null,
        validated: false,
        isValid: false,
        selections: [],
        wonCount: 0,
        lostCount: 0,
        pendingCount: 0,
      });
    }
  }

  return codes;
}

// =========================================================================
// MAIN ENTRY
// =========================================================================

/**
 * Scrape Sportybet booking codes from Twitter/X.
 *
 * Primary method: syndication timeline scraping (free, no key needed).
 * Bonus: if TWITTER_BEARER_TOKEN is set, also runs API search.
 */
export async function scrapeTwitterCodes(): Promise<BookingCode[]> {
  // 1. Scrape tipster account timelines via syndication (batched to avoid rate limits)
  const syndicationResults: BookingCode[][] = [];
  for (let i = 0; i < TIPSTER_ACCOUNTS.length; i += 3) {
    const batch = TIPSTER_ACCOUNTS.slice(i, i + 3);
    const results = await Promise.allSettled(
      batch.map(acct => scrapeAccountTimeline(acct)),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') syndicationResults.push(r.value);
    }
  }

  // 2. Optionally run API search if token is available
  const apiResults: BookingCode[][] = [];
  const token = config.TWITTER_BEARER_TOKEN;
  if (token) {
    const results = await Promise.allSettled(
      SEARCH_QUERIES.map(q => searchTwitterAPI(q, token)),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') apiResults.push(r.value);
    }
  }

  // 3. Merge and deduplicate
  const allCodes: BookingCode[] = [];
  const seen = new Set<string>();

  for (const batch of [...syndicationResults, ...apiResults]) {
    for (const code of batch) {
      if (seen.has(code.code)) continue;
      seen.add(code.code);
      allCodes.push(code);
    }
  }

  logger.info({
    count: allCodes.length,
    syndication: syndicationResults.reduce((n, b) => n + b.length, 0),
    api: apiResults.reduce((n, b) => n + b.length, 0),
  }, 'Twitter: codes scraped');

  return allCodes;
}

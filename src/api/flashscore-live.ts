/**
 * FlashScore Live Feed
 *
 * Fetches live match data from FlashScore's public feed.
 * Works globally (no geo-restriction unlike Sportybet live API).
 * Returns structured match data with scores, minutes, and league info.
 *
 * Used as fallback when Sportybet pcLiveEvents is unavailable.
 */

import { logger } from '../utils/logger.js';

export interface FlashLiveMatch {
  id: string;
  home: string;
  away: string;
  scoreHome: number;
  scoreAway: number;
  minute: string;
  status: 'live' | 'ht' | 'finished';
  half: '1H' | '2H' | 'HT' | 'FT' | '?';
  league: string;
  country: string;
  sport: string;
  startTime: number;
}

// ── Cache ────────────────────────────────────────────────

let cache: FlashLiveMatch[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 60 * 1000; // 1 minute

const FEED_URL = 'https://www.flashscore.com/x/feed/f_1_0_3_en-gb_1';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'X-Fsign': 'SW9D1eZo',
  'Referer': 'https://www.flashscore.com/',
};

// ── Parser ───────────────────────────────────────────────

function parseFlashFeed(raw: string): FlashLiveMatch[] {
  const matches: FlashLiveMatch[] = [];
  const entries = raw.split('~AA÷');
  let league = '';
  let country = '';

  for (const entry of entries.slice(1)) {
    const fields: Record<string, string> = {};
    for (const kv of ('AA÷' + entry).split('¬')) {
      const idx = kv.indexOf('÷');
      if (idx > 0) {
        fields[kv.slice(0, idx)] = kv.slice(idx + 1);
      }
    }

    // League header (ZA field, sometimes prefixed with ~)
    const leagueField = fields['~ZA'] || fields['ZA'];
    if (leagueField) {
      // Format: "COUNTRY: League Name"
      const colonIdx = leagueField.indexOf(':');
      if (colonIdx > 0) {
        country = leagueField.slice(0, colonIdx).trim();
        league = leagueField.slice(colonIdx + 1).trim();
      } else {
        league = leagueField;
      }
    }
    if (fields['ZY']) country = fields['ZY'];

    const statusCode = fields['AB'];
    if (!statusCode || !['1', '2', '3'].includes(statusCode)) continue;

    const home = fields['CX'] || fields['AE'] || '';
    const away = fields['AF'] || '';
    if (!home || !away) continue;

    const half = statusCode === '1' ? '1H' as const
      : statusCode === '2' ? '2H' as const
      : statusCode === '3' ? 'HT' as const
      : '?' as const;

    matches.push({
      id: fields['AA'] || '',
      home,
      away,
      scoreHome: parseInt(fields['AG'] || '0', 10) || 0,
      scoreAway: parseInt(fields['AH'] || '0', 10) || 0,
      minute: fields['BA'] || '',
      status: statusCode === '3' ? 'ht' : 'live',
      half,
      league,
      country,
      sport: 'Football',
      startTime: parseInt(fields['AD'] || '0', 10) * 1000 || Date.now(),
    });
  }

  return matches;
}

// ── Public API ───────────────────────────────────────────

export async function getFlashLiveMatches(): Promise<FlashLiveMatch[]> {
  if (cache && Date.now() - cacheTime < CACHE_TTL) {
    return cache;
  }

  try {
    const res = await fetch(FEED_URL, {
      headers: HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'FlashScore feed failed');
      return cache || [];
    }

    const raw = await res.text();
    const matches = parseFlashFeed(raw);

    cache = matches;
    cacheTime = Date.now();
    logger.info({ count: matches.length }, 'FlashScore live matches fetched');
    return matches;
  } catch (err) {
    logger.warn({ err }, 'FlashScore live feed error');
    return cache || [];
  }
}

/**
 * Convert FlashScore matches to the same shape as Sportybet tournaments
 * so the frontend can render them identically.
 */
export function toSportyFormat(matches: FlashLiveMatch[]): {
  totalNum: number;
  tournaments: Array<{
    id: string;
    name: string;
    events: Array<{
      eventId: string;
      homeTeamName: string;
      awayTeamName: string;
      estimateStartTime: number;
      matchStatus: string;
      setScore: string;
      sport: {
        id: string;
        name: string;
        category: { name: string; tournament: { name: string } };
      };
      markets: Array<Record<string, unknown>>;
    }>;
  }>;
} {
  // Group by league
  const byLeague = new Map<string, FlashLiveMatch[]>();
  for (const m of matches) {
    const key = `${m.country}: ${m.league}`;
    if (!byLeague.has(key)) byLeague.set(key, []);
    byLeague.get(key)!.push(m);
  }

  const tournaments = [...byLeague.entries()].map(([name, events]) => ({
    id: `flash:${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
    name,
    events: events.map(m => ({
      eventId: `flash:${m.id}`,
      homeTeamName: m.home,
      awayTeamName: m.away,
      estimateStartTime: m.startTime,
      matchStatus: m.half,
      setScore: `${m.scoreHome}:${m.scoreAway}`,
      sport: {
        id: 'sr:sport:1',
        name: 'Football',
        category: {
          name: m.country,
          tournament: { name: m.league },
        },
      },
      markets: [],
    })),
  }));

  return {
    totalNum: matches.length,
    tournaments,
  };
}

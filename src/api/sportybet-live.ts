/**
 * Sportybet Live Games Scraper
 *
 * Fetches all live games across all sports from Sportybet Ghana's API.
 * Uses the liveOrPrematchEvents endpoint with group=Live.
 * Results are cached for 60 seconds to avoid hammering the API.
 */

import { logger } from '../utils/logger.js';

// ── Types ────────────────────────────────────────────────

export interface LiveMarketOutcome {
  id: string;
  odds: string;
  desc: string;
  isActive: number;
}

export interface LiveMarket {
  id: string;
  desc: string;
  name: string;
  outcomes: LiveMarketOutcome[];
  specifier?: string;
}

export interface LiveGame {
  eventId: string;
  gameId: string;
  homeTeamName: string;
  awayTeamName: string;
  score: string;
  gameScore: string[];
  minute: string | null;
  matchStatus: string;       // H1, H2, HT, FT, etc.
  period: string;
  startTime: number;
  sport: string;
  sportId: string;
  country: string;
  league: string;
  tournamentId: string;
  totalMarkets: number;
  markets: LiveMarket[];
  isUpcoming?: boolean;
  odds: {
    home: number;
    draw: number;
    away: number;
    over25: number | null;
    under25: number | null;
    bttsYes: number | null;
    bttsNo: number | null;
  };
}

export interface LiveGamesResult {
  games: LiveGame[];
  totalCount: number;
  bySport: Record<string, number>;
  scrapedAt: string;
  source: string;
}

// ── Config ───────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const COUNTRY = 'gh';  // Ghana — most reliable endpoint

const SPORTS = [
  { id: 'sr:sport:1',  name: 'Football' },
  { id: 'sr:sport:2',  name: 'Basketball' },
  { id: 'sr:sport:3',  name: 'Baseball' },
  { id: 'sr:sport:4',  name: 'Ice Hockey' },
  { id: 'sr:sport:5',  name: 'Tennis' },
  { id: 'sr:sport:6',  name: 'Handball' },
  { id: 'sr:sport:21', name: 'Cricket' },
  { id: 'sr:sport:22', name: 'Darts' },
  { id: 'sr:sport:23', name: 'Volleyball' },
  { id: 'sr:sport:29', name: 'Table Tennis' },
  { id: 'sr:sport:31', name: 'Badminton' },
  { id: 'sr:sport:34', name: 'American Football' },
  { id: 'sr:sport:137', name: 'eSports' },
];

// ── Cache ────────────────────────────────────────────────

let cache: LiveGamesResult | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000; // 1 minute

let upcomingCache: LiveGamesResult | null = null;
let upcomingCacheTime = 0;
const UPCOMING_CACHE_TTL = 5 * 60_000; // 5 minutes — upcoming fixtures change slowly

const ESPN_SOCCER_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard';

const LEAGUE_MAP: Record<string, { name: string; country: string }> = {
  'premier-league':    { name: 'Premier League',    country: 'England' },
  'laliga':            { name: 'La Liga',            country: 'Spain' },
  'bundesliga':        { name: 'Bundesliga',         country: 'Germany' },
  'ligue-1':           { name: 'Ligue 1',            country: 'France' },
  'italian-serie-a':   { name: 'Serie A',            country: 'Italy' },
  'serie-a':           { name: 'Serie A',            country: 'Italy' },
  'champions-league':  { name: 'Champions League',   country: 'Europe' },
  'europa-league':     { name: 'Europa League',      country: 'Europe' },
  'conference-league': { name: 'Conference League',  country: 'Europe' },
  'eredivisie':        { name: 'Eredivisie',         country: 'Netherlands' },
  'primeira-liga':     { name: 'Primeira Liga',      country: 'Portugal' },
};

function parseESPNLeague(slug: string): { name: string; country: string } {
  const cleaned = slug.replace(/^\d{4}-\d{2}-/, '');
  if (LEAGUE_MAP[cleaned]) return LEAGUE_MAP[cleaned];
  const name = cleaned.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return { name, country: '' };
}

// ── API Types ────────────────────────────────────────────

interface ApiOutcome {
  id: string;
  odds: string;
  desc?: string;
  isActive?: number;
  probability?: string;
}

interface ApiMarket {
  id: string;
  desc?: string;
  name?: string;
  specifier?: string;
  outcomes?: ApiOutcome[];
}

interface ApiEvent {
  eventId: string;
  gameId?: string;
  homeTeamName: string;
  awayTeamName: string;
  estimateStartTime: number;
  status?: number;
  setScore?: string;
  gameScore?: string[];
  period?: string;
  matchStatus?: string;
  playedSeconds?: string;
  sport: {
    id: string;
    name: string;
    category: {
      id?: string;
      name: string;
      tournament: { id?: string; name: string };
    };
  };
  totalMarketSize?: number;
  markets?: ApiMarket[];
}

interface ApiTournament {
  id?: string;
  name: string;
  events: ApiEvent[];
}

// ── Helpers ──────────────────────────────────────────────

function parsePlayedSeconds(ps: string | undefined): string | null {
  if (!ps) return null;
  // Format: "62:22" → "62'"
  const parts = ps.split(':');
  if (parts.length >= 1) return `${parts[0]}'`;
  return ps;
}

function extractOdds(markets: ApiMarket[]): LiveGame['odds'] {
  const result: LiveGame['odds'] = {
    home: 0, draw: 0, away: 0,
    over25: null, under25: null,
    bttsYes: null, bttsNo: null,
  };

  for (const mkt of markets) {
    const outcomes = mkt.outcomes || [];
    const specifier = mkt.specifier || '';

    if (mkt.id === '1') {
      // 1X2
      for (const o of outcomes) {
        const odds = parseFloat(o.odds || '0');
        if (o.id === '1') result.home = odds;
        else if (o.id === '2') result.draw = odds;
        else if (o.id === '3') result.away = odds;
      }
    } else if (mkt.id === '18' && specifier.includes('total=2.5')) {
      // Over/Under 2.5
      for (const o of outcomes) {
        const odds = parseFloat(o.odds || '0');
        if (o.id === '12') result.over25 = odds;
        else if (o.id === '13') result.under25 = odds;
      }
    } else if (mkt.id === '29') {
      // Both Teams to Score
      for (const o of outcomes) {
        const odds = parseFloat(o.odds || '0');
        const desc = (o.desc || '').toLowerCase();
        if (desc.includes('yes') || o.id === '74') result.bttsYes = odds;
        else if (desc.includes('no') || o.id === '76') result.bttsNo = odds;
      }
    }
  }

  return result;
}

function parseMarkets(apiMarkets: ApiMarket[]): LiveMarket[] {
  return apiMarkets.map(m => ({
    id: m.id,
    desc: m.desc || '',
    name: m.name || '',
    specifier: m.specifier,
    outcomes: (m.outcomes || []).map(o => ({
      id: o.id,
      odds: o.odds,
      desc: o.desc || '',
      isActive: o.isActive ?? 1,
    })),
  }));
}

// ── Fetch ────────────────────────────────────────────────

async function fetchLiveSport(sportId: string, sportName: string, group: 'Live' | 'Prematch' = 'Live'): Promise<LiveGame[]> {
  // Explicit marketId list — without this the API returns a compact subset
  // that omits Double Chance (10), Draw No Bet (11), BTTS (29), and Odd/Even (26).
  // Union of every market id consumed by downstream modules.
  const markets = '1,10,11,18,26,29';
  const url = `https://www.sportybet.com/api/${COUNTRY}/factsCenter/liveOrPrematchEvents?_t=${Date.now()}&sportId=${encodeURIComponent(sportId)}&group=${group}&marketId=${markets}&pageSize=100&pageNum=1`;

  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) return [];

  const json = await res.json() as { bizCode?: number; data?: ApiTournament[] };
  if (json.bizCode !== 10000 || !Array.isArray(json.data)) return [];

  const games: LiveGame[] = [];

  for (const tournament of json.data) {
    for (const ev of tournament.events) {
      const markets = ev.markets || [];

      games.push({
        eventId: ev.eventId,
        gameId: ev.gameId || '',
        homeTeamName: ev.homeTeamName,
        awayTeamName: ev.awayTeamName,
        score: ev.setScore || '0:0',
        gameScore: ev.gameScore || [],
        minute: parsePlayedSeconds(ev.playedSeconds),
        matchStatus: ev.matchStatus || (group === 'Prematch' ? 'Not started' : 'Live'),
        period: ev.period || '',
        startTime: ev.estimateStartTime,
        sport: sportName,
        sportId,
        country: ev.sport.category.name,
        league: ev.sport.category.tournament.name,
        tournamentId: tournament.id || '',
        totalMarkets: ev.totalMarketSize || markets.length,
        markets: parseMarkets(markets),
        isUpcoming: group === 'Prematch',
        odds: extractOdds(markets),
      });
    }
  }

  return games;
}

// ── Public API ───────────────────────────────────────────

export async function getSportyLiveGames(forceRefresh = false): Promise<LiveGamesResult> {
  if (!forceRefresh && cache && Date.now() - cacheTime < CACHE_TTL) {
    return cache;
  }

  const startMs = Date.now();

  // Fetch all sports in parallel
  const results = await Promise.allSettled(
    SPORTS.map(s => fetchLiveSport(s.id, s.name)),
  );

  const allGames: LiveGame[] = [];
  const bySport: Record<string, number> = {};

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const sport = SPORTS[i]!;
    if (r.status === 'fulfilled' && r.value.length > 0) {
      allGames.push(...r.value);
      bySport[sport.name] = r.value.length;
    }
  }

  // Sort: football first, then by start time
  allGames.sort((a, b) => {
    if (a.sport === 'Football' && b.sport !== 'Football') return -1;
    if (a.sport !== 'Football' && b.sport === 'Football') return 1;
    return a.startTime - b.startTime;
  });

  const result: LiveGamesResult = {
    games: allGames,
    totalCount: allGames.length,
    bySport,
    scrapedAt: new Date().toISOString(),
    source: 'sportybet-gh',
  };

  cache = result;
  cacheTime = Date.now();

  logger.info({
    total: allGames.length,
    bySport,
    elapsed: Date.now() - startMs,
  }, 'Sportybet live games scraped');

  return result;
}

// Fetch upcoming football matches starting within the next 3 hours via ESPN.
// Sportybet's liveOrPrematchEvents API only exposes in-play games; ESPN's
// public scoreboard is used as the fixture source instead.
export async function getSportyUpcomingGames(forceRefresh = false): Promise<LiveGamesResult> {
  if (!forceRefresh && upcomingCache && Date.now() - upcomingCacheTime < UPCOMING_CACHE_TTL) {
    return upcomingCache;
  }

  const startMs = Date.now();
  const now = Date.now();
  const cutoff = now + 6 * 60 * 60 * 1000;

  const res = await fetch(ESPN_SOCCER_URL, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);

  const games: LiveGame[] = [];

  if (res?.ok) {
    const json = await res.json() as { events?: unknown[] };
    for (const ev of (json.events || []) as Record<string, unknown>[]) {
      const startTime = new Date(ev.date as string).getTime();
      if (startTime <= now || startTime > cutoff) continue;

      const comp = (Array.isArray(ev.competitions) ? ev.competitions[0] : ev.competitions) as Record<string, unknown> | undefined;
      const competitors = (comp?.competitors as Record<string, unknown>[] | undefined) || [];
      const home = competitors.find(c => c.homeAway === 'home');
      const away = competitors.find(c => c.homeAway === 'away');
      const homeTeamName = (home?.team as Record<string,string> | undefined)?.displayName || String(home?.name ?? '');
      const awayTeamName = (away?.team as Record<string,string> | undefined)?.displayName || String(away?.name ?? '');
      if (!homeTeamName || !awayTeamName) continue;

      const { name: league, country } = parseESPNLeague(String((ev.season as Record<string,unknown>)?.slug ?? ev.name ?? ''));

      games.push({
        eventId: 'espn-' + String(ev.id),
        gameId: '',
        homeTeamName,
        awayTeamName,
        score: '0:0',
        gameScore: [],
        minute: null,
        matchStatus: 'Not started',
        period: '',
        startTime,
        sport: 'Football',
        sportId: 'sr:sport:1',
        country,
        league,
        tournamentId: '',
        totalMarkets: 0,
        markets: [],
        isUpcoming: true,
        odds: { home: 0, draw: 0, away: 0, over25: null, under25: null, bttsYes: null, bttsNo: null },
      });
    }
    games.sort((a, b) => a.startTime - b.startTime);
  }

  const result: LiveGamesResult = {
    games,
    totalCount: games.length,
    bySport: games.length > 0 ? { Football: games.length } : {},
    scrapedAt: new Date().toISOString(),
    source: 'espn',
  };

  upcomingCache = result;
  upcomingCacheTime = Date.now();

  logger.info({ total: games.length, elapsed: Date.now() - startMs }, 'ESPN upcoming football fixtures fetched');

  return result;
}

/**
 * Football Match Enrichment via API-Football
 *
 * Fetches real match data (team form, H2H, predictions) to improve
 * code generation accuracy. Requires FOOTBALL_API_KEY env var.
 *
 * Free tier: 100 requests/day at https://dashboard.api-football.com
 */

import { logger } from '../utils/logger.js';

const API_BASE = 'https://v3.football.api-sports.io';
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// In-memory cache (survives across warm Vercel invocations)
const fixtureCache = new Map<string, { data: FixtureMatch[]; ts: number }>();
const predictionCache = new Map<number, { data: MatchEnrichment; ts: number }>();

export interface MatchEnrichment {
  fixtureId: number;
  homeForm: string;       // "WWDLW"
  awayForm: string;       // "LWWDW"
  homeWinPct: number;     // 0-100
  drawPct: number;        // 0-100
  awayWinPct: number;     // 0-100
  goalsOver25Pct: number; // predicted % for over 2.5
  goalsUnder25Pct: number;
  advice: string;         // "Double chance : Manchester City or draw"
  homeLeaguePos: number | null;
  awayLeaguePos: number | null;
  homeGoalsFor: number;   // avg goals scored
  homeGoalsAgainst: number;
  awayGoalsFor: number;
  awayGoalsAgainst: number;
  h2hHomeWins: number;
  h2hAwayWins: number;
  h2hDraws: number;
  // Lineup/injury info (from ESPN rosters)
  injuries?: {
    home: Array<{ name: string; position: string; status: string }>;
    away: Array<{ name: string; position: string; status: string }>;
    severity: 'none' | 'low' | 'medium' | 'high';
  };
}

interface FixtureMatch {
  fixture: { id: number; date: string };
  teams: {
    home: { id: number; name: string };
    away: { id: number; name: string };
  };
}

interface ApiPrediction {
  predictions?: {
    winner?: { id: number; name: string; comment: string };
    percent?: { home: string; draw: string; away: string };
    advice?: string;
    goals?: { home: string; away: string };
    under_over?: string;
  };
  league?: { id: number; name: string };
  teams?: {
    home: {
      id: number; name: string;
      league?: { form: string; goals: { for: { average: { total: string } }; against: { average: { total: string } } } };
      last_5?: { form: string };
    };
    away: {
      id: number; name: string;
      league?: { form: string; goals: { for: { average: { total: string } }; against: { average: { total: string } } } };
      last_5?: { form: string };
    };
  };
  h2h?: Array<{
    teams: { home: { id: number; winner: boolean | null }; away: { id: number; winner: boolean | null } };
  }>;
}

function getApiKey(): string | null {
  return process.env.FOOTBALL_API_KEY || null;
}

async function apiFetch<T>(endpoint: string): Promise<T | null> {
  const key = getApiKey();
  if (!key) return null;

  // Try direct API-Sports endpoint first, then RapidAPI fallback
  const attempts: Array<{ url: string; headers: Record<string, string> }> = [
    { url: `${API_BASE}${endpoint}`, headers: { 'x-apisports-key': key } },
    { url: `https://api-football-v1.p.rapidapi.com/v3${endpoint}`, headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'api-football-v1.p.rapidapi.com' } },
  ];

  for (const attempt of attempts) {
    try {
      const res = await fetch(attempt.url, {
        headers: attempt.headers,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;

      const json = await res.json() as { response?: T; errors?: Record<string, string>; message?: string };
      if (json.message) continue; // RapidAPI error
      if (json.errors && Object.keys(json.errors).length > 0) {
        logger.warn({ errors: json.errors, url: attempt.url }, 'API-Football errors');
        continue;
      }
      if (json.response) return json.response;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Normalize a team name for fuzzy matching.
 * "Liverpool FC" → "liverpool"
 * "Manchester United" → "manchester united"
 * "Borussia Dortmund" → "borussia dortmund"
 */
function normName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*(fc|sc|cf|afc|srl|hd|ac|as|ss|us|rc)\s*$/i, '')
    .replace(/^\s*(fc|sc|cf|afc|ac|as|rc)\s+/i, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function nameMatch(a: string, b: string): boolean {
  const na = normName(a);
  const nb = normName(b);
  if (na === nb) return true;
  // One contains the other (e.g. "liverpool" matches "liverpool fc")
  if (na.includes(nb) || nb.includes(na)) return true;
  // First word match for compound names (e.g. "arsenal" matches "arsenal london")
  const fa = na.split(/\s+/)[0]!;
  const fb = nb.split(/\s+/)[0]!;
  if (fa.length >= 4 && fa === fb) return true;
  return false;
}

/**
 * Fetch today's fixtures from API-Football and cache them.
 */
async function getTodayFixtures(dateStr: string): Promise<FixtureMatch[]> {
  const cached = fixtureCache.get(dateStr);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const fixtures = await apiFetch<FixtureMatch[]>(`/fixtures?date=${dateStr}&status=NS-1H-2H-HT`);
  if (!fixtures) return [];

  fixtureCache.set(dateStr, { data: fixtures, ts: Date.now() });
  return fixtures;
}

/**
 * Find the API-Football fixture ID for a match by team names and date.
 */
async function findFixtureId(homeTeam: string, awayTeam: string, matchDate: string | null): Promise<number | null> {
  const dateStr = matchDate || new Date().toISOString().split('T')[0]!;

  // Try the exact date first, then try searching by team names directly
  const fixtures = await getTodayFixtures(dateStr);

  for (const f of fixtures) {
    if (nameMatch(homeTeam, f.teams.home.name) && nameMatch(awayTeam, f.teams.away.name)) {
      return f.fixture.id;
    }
    if (nameMatch(homeTeam, f.teams.away.name) && nameMatch(awayTeam, f.teams.home.name)) {
      return f.fixture.id;
    }
  }

  // Fallback: search by team name using the search endpoint
  // This works when date-based search fails (e.g. timezone mismatch)
  try {
    const searchResults = await apiFetch<FixtureMatch[]>(
      `/fixtures?season=2025&search=${encodeURIComponent(homeTeam)}&next=5`,
    );
    if (searchResults) {
      for (const f of searchResults) {
        if (nameMatch(awayTeam, f.teams.away.name) || nameMatch(awayTeam, f.teams.home.name)) {
          return f.fixture.id;
        }
      }
    }
  } catch {
    // Ignore search failures
  }

  return null;
}

/**
 * Fetch prediction data for a specific fixture.
 */
async function fetchPrediction(fixtureId: number): Promise<MatchEnrichment | null> {
  const cached = predictionCache.get(fixtureId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const preds = await apiFetch<ApiPrediction[]>(`/predictions?fixture=${fixtureId}`);
  if (!preds || !preds[0]) return null;

  const p = preds[0];
  const homePct = parseInt(p.predictions?.percent?.home || '0');
  const drawPct = parseInt(p.predictions?.percent?.draw || '0');
  const awayPct = parseInt(p.predictions?.percent?.away || '0');

  // Parse H2H
  let h2hHomeWins = 0, h2hAwayWins = 0, h2hDraws = 0;
  if (p.h2h) {
    const homeId = p.teams?.home?.id;
    for (const match of p.h2h.slice(0, 10)) {
      if (match.teams.home.winner === true) {
        if (match.teams.home.id === homeId) h2hHomeWins++;
        else h2hAwayWins++;
      } else if (match.teams.away.winner === true) {
        if (match.teams.away.id === homeId) h2hHomeWins++;
        else h2hAwayWins++;
      } else {
        h2hDraws++;
      }
    }
  }

  const enrichment: MatchEnrichment = {
    fixtureId,
    homeForm: p.teams?.home?.last_5?.form || p.teams?.home?.league?.form || '',
    awayForm: p.teams?.away?.last_5?.form || p.teams?.away?.league?.form || '',
    homeWinPct: homePct,
    drawPct,
    awayWinPct: awayPct,
    goalsOver25Pct: 0,
    goalsUnder25Pct: 0,
    advice: p.predictions?.advice || '',
    homeLeaguePos: null,
    awayLeaguePos: null,
    homeGoalsFor: parseFloat(p.teams?.home?.league?.goals?.for?.average?.total || '0'),
    homeGoalsAgainst: parseFloat(p.teams?.home?.league?.goals?.against?.average?.total || '0'),
    awayGoalsFor: parseFloat(p.teams?.away?.league?.goals?.for?.average?.total || '0'),
    awayGoalsAgainst: parseFloat(p.teams?.away?.league?.goals?.against?.average?.total || '0'),
    h2hHomeWins,
    h2hAwayWins,
    h2hDraws,
  };

  predictionCache.set(fixtureId, { data: enrichment, ts: Date.now() });
  return enrichment;
}

/**
 * Enrich a match with external data.
 * Returns null if API key not set or match not found.
 */
export async function enrichMatch(
  homeTeam: string,
  awayTeam: string,
  matchDate: string | null,
): Promise<MatchEnrichment | null> {
  if (!getApiKey()) return null;

  const fixtureId = await findFixtureId(homeTeam, awayTeam, matchDate);
  if (!fixtureId) return null;

  return fetchPrediction(fixtureId);
}

/**
 * Batch-enrich multiple matches. Respects rate limits by limiting concurrent requests.
 */
export async function enrichMatches(
  matches: Array<{ homeTeam: string; awayTeam: string; matchDate: string | null; eventId: string }>,
): Promise<Map<string, MatchEnrichment>> {
  if (!getApiKey()) return new Map();

  const results = new Map<string, MatchEnrichment>();

  // Process in batches of 5 to avoid hammering the API
  for (let i = 0; i < matches.length; i += 5) {
    const batch = matches.slice(i, i + 5);
    const enrichments = await Promise.allSettled(
      batch.map(m => enrichMatch(m.homeTeam, m.awayTeam, m.matchDate)),
    );

    for (let j = 0; j < batch.length; j++) {
      const r = enrichments[j]!;
      if (r.status === 'fulfilled' && r.value) {
        results.set(batch[j]!.eventId, r.value);
      }
    }
  }

  logger.info({ requested: matches.length, enriched: results.size }, 'Match enrichment complete');
  return results;
}

/**
 * Check if the API key is configured.
 */
export function hasFootballApi(): boolean {
  return !!getApiKey();
}

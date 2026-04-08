/**
 * Pinnacle Sharp Odds via Guest API (no key required)
 *
 * Fetches real Pinnacle exchange-grade odds for value detection.
 * Pinnacle has ~2% margin — the sharpest line in the market.
 * Comparing Sportybet odds vs Pinnacle reveals genuine value.
 */

import { logger } from '../utils/logger.js';

const PINNACLE_BASE = 'https://guest.api.arcadia.pinnacle.com/0.1';
const CACHE_TTL = 30 * 60 * 1000; // 30 min (odds move fast)
const REQUEST_TIMEOUT = 10_000;

// League IDs on Pinnacle (guest API) — soccer + basketball + tennis
const PINNACLE_LEAGUES: Record<string, number> = {
  // Basketball
  'nba': 487,
  'euroleague': 578,
  'ncaa': 493,
  'nbl': 5612,
  'basketball': 487,        // fallback to NBA
  // Top 5 European leagues
  'premier league': 1980,
  'laliga': 2196,
  'la liga': 2196,
  'bundesliga': 1842,
  'serie a': 2436,
  'ligue 1': 2036,
  // Other European leagues
  'championship': 1977,
  'eredivisie': 1817,
  'liga portugal': 2245,
  'primeira liga': 2245,
  'super lig': 2197,
  'superliga': 1928,       // Denmark
  'eliteserien': 1975,     // Norway
  'allsvenskan': 2185,     // Sweden
  'pro league': 2231,      // Belgium
  // European cups
  'champions league': 2627,
  'europa league': 2630,
  'conference league': 2635,
  // Americas
  'mls': 2663,
  'libertadores': 2640,
  'sudamericana': 2641,
  // Other
  'saudi pro': 7932,
  'premiership': 2270,     // South Africa / Scotland
};

// ===== TYPES =====

export interface PinnacleMatch {
  matchupId: number;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  leagueId: number;
}

export interface PinnacleOdds {
  matchupId: number;
  homeTeam: string;
  awayTeam: string;
  moneyline?: { home: number; draw: number; away: number };
  totals?: Array<{ line: number; over: number; under: number }>;
  spreads?: Array<{ line: number; home: number; away: number }>;
}

// ===== CACHE =====

const matchupCache = new Map<number, { data: PinnacleMatch[]; ts: number }>();
const oddsCache = new Map<number, { data: Map<number, PinnacleOdds>; ts: number }>();

// ===== FETCH =====

async function pinnacleFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${PINNACLE_BASE}${path}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// American to decimal odds
function toDecimal(american: number): number {
  if (american > 0) return american / 100 + 1;
  return -100 / american + 1;
}

// ===== MATCHUPS =====

interface RawMatchup {
  id: number;
  type: string;
  special?: boolean;
  participants?: Array<{ name: string; alignment: string }>;
  startTime?: string;
}

async function getMatchups(leagueId: number): Promise<PinnacleMatch[]> {
  const cached = matchupCache.get(leagueId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const raw = await pinnacleFetch<RawMatchup[]>(`/leagues/${leagueId}/matchups`);
  if (!raw) return [];

  const matches: PinnacleMatch[] = [];
  for (const m of raw) {
    if (m.type !== 'matchup' || m.special) continue;
    const home = m.participants?.find(p => p.alignment === 'home');
    const away = m.participants?.find(p => p.alignment === 'away');
    if (!home || !away) continue;
    matches.push({
      matchupId: m.id,
      homeTeam: home.name,
      awayTeam: away.name,
      startTime: m.startTime || '',
      leagueId,
    });
  }

  matchupCache.set(leagueId, { data: matches, ts: Date.now() });
  return matches;
}

// ===== ODDS =====

interface RawMarket {
  matchupId: number;
  type: string; // "moneyline", "total", "spread"
  period: number; // 0 = full game
  isAlternate?: boolean;
  points?: number;
  prices?: Array<{ designation: string; price: number; points?: number }>;
}

async function getOdds(leagueId: number): Promise<Map<number, PinnacleOdds>> {
  const cached = oddsCache.get(leagueId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  // Fetch matchups and markets in parallel
  const [matchups, markets] = await Promise.all([
    getMatchups(leagueId),
    pinnacleFetch<RawMarket[]>(`/leagues/${leagueId}/markets/straight`),
  ]);

  const matchMap = new Map(matchups.map(m => [m.matchupId, m]));
  const oddsMap = new Map<number, PinnacleOdds>();

  // Initialize odds entries from matchups
  for (const m of matchups) {
    oddsMap.set(m.matchupId, {
      matchupId: m.matchupId,
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
    });
  }

  if (markets) {
    for (const mkt of markets) {
      if (mkt.period !== 0 || mkt.isAlternate) continue;
      const entry = oddsMap.get(mkt.matchupId);
      if (!entry || !mkt.prices) continue;

      if (mkt.type === 'moneyline') {
        const home = mkt.prices.find(p => p.designation === 'home');
        const draw = mkt.prices.find(p => p.designation === 'draw');
        const away = mkt.prices.find(p => p.designation === 'away');
        if (home && draw && away) {
          entry.moneyline = {
            home: Math.round(toDecimal(home.price) * 100) / 100,
            draw: Math.round(toDecimal(draw.price) * 100) / 100,
            away: Math.round(toDecimal(away.price) * 100) / 100,
          };
        }
      } else if (mkt.type === 'total') {
        const over = mkt.prices.find(p => p.designation === 'over');
        const under = mkt.prices.find(p => p.designation === 'under');
        if (over && under) {
          if (!entry.totals) entry.totals = [];
          entry.totals.push({
            line: over.points ?? mkt.points ?? 0,
            over: Math.round(toDecimal(over.price) * 100) / 100,
            under: Math.round(toDecimal(under.price) * 100) / 100,
          });
        }
      } else if (mkt.type === 'spread') {
        const home = mkt.prices.find(p => p.designation === 'home');
        const away = mkt.prices.find(p => p.designation === 'away');
        if (home && away) {
          if (!entry.spreads) entry.spreads = [];
          entry.spreads.push({
            line: home.points ?? mkt.points ?? 0,
            home: Math.round(toDecimal(home.price) * 100) / 100,
            away: Math.round(toDecimal(away.price) * 100) / 100,
          });
        }
      }
    }
  }

  oddsCache.set(leagueId, { data: oddsMap, ts: Date.now() });
  return oddsMap;
}

// ===== NAME MATCHING =====

function normName(name: string): string {
  if (!name) return '';
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
  if (na.includes(nb) || nb.includes(na)) return true;
  const fa = na.split(/\s+/)[0]!;
  const fb = nb.split(/\s+/)[0]!;
  if (fa.length >= 4 && fa === fb) return true;
  return false;
}

// ===== PUBLIC API =====

/**
 * Find Pinnacle odds for a match by team names and league.
 */
export async function findPinnacleOdds(
  homeTeam: string,
  awayTeam: string,
  league: string,
): Promise<PinnacleOdds | null> {
  // Try to find the league — normalize spaces, dashes, accents
  const leagueNorm = (league || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let leagueId: number | null = null;
  for (const [name, id] of Object.entries(PINNACLE_LEAGUES)) {
    const nameNorm = name.replace(/[^a-z0-9]/g, '');
    if (leagueNorm.includes(nameNorm) || nameNorm.includes(leagueNorm)) { leagueId = id; break; }
  }

  // If no league match, try all major leagues
  const leagueIds = leagueId ? [leagueId] : Object.values(PINNACLE_LEAGUES);

  for (const lid of leagueIds) {
    const odds = await getOdds(lid);
    for (const [, entry] of odds) {
      if (nameMatch(homeTeam, entry.homeTeam) && nameMatch(awayTeam, entry.awayTeam)) return entry;
      if (nameMatch(homeTeam, entry.awayTeam) && nameMatch(awayTeam, entry.homeTeam)) return entry;
    }
  }

  return null;
}

/**
 * Batch-fetch Pinnacle odds for multiple matches.
 * Returns a map of eventId -> PinnacleOdds.
 */
export async function batchPinnacleOdds(
  matches: Array<{ homeTeam: string; awayTeam: string; league: string; eventId: string }>,
): Promise<Map<string, PinnacleOdds>> {
  const results = new Map<string, PinnacleOdds>();

  // Collect all needed league IDs
  const neededLeagues = new Set<number>();
  for (const m of matches) {
    const ll = (m.league || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const [name, id] of Object.entries(PINNACLE_LEAGUES)) {
      const nn = name.replace(/[^a-z0-9]/g, '');
      if (ll.includes(nn) || nn.includes(ll)) { neededLeagues.add(id); break; }
    }
  }
  // If no specific leagues found, fetch all
  if (!neededLeagues.size) {
    for (const id of Object.values(PINNACLE_LEAGUES)) neededLeagues.add(id);
  }

  // Fetch all needed leagues in parallel
  const allOdds = await Promise.all(
    [...neededLeagues].map(async lid => ({ lid, odds: await getOdds(lid) })),
  );

  // Build a flat lookup of all Pinnacle matches
  const pinnacleMatches: PinnacleOdds[] = [];
  for (const { odds } of allOdds) {
    for (const [, entry] of odds) pinnacleMatches.push(entry);
  }

  // Match each request to Pinnacle data
  for (const m of matches) {
    for (const p of pinnacleMatches) {
      if (
        (nameMatch(m.homeTeam, p.homeTeam) && nameMatch(m.awayTeam, p.awayTeam)) ||
        (nameMatch(m.homeTeam, p.awayTeam) && nameMatch(m.awayTeam, p.homeTeam))
      ) {
        results.set(m.eventId, p);
        break;
      }
    }
  }

  logger.info({ requested: matches.length, matched: results.size }, 'Pinnacle odds matched');
  return results;
}

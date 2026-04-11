/**
 * Cross-Bookmaker Odds Scanner
 *
 * Pulls ALL upcoming events with odds from both Pinnacle and Sportybet,
 * matches them by team name, compares odds, and detects lag/value.
 * Works independently of booking codes — covers football, basketball, tennis.
 */

import { logger } from '../utils/logger.js';

// =========================================================================
// Types
// =========================================================================

export interface CrossOddsEvent {
  pinnacleId: number;
  sportyEventId: string | null;
  sport: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  /** Pinnacle odds (sharp, de-vigged) */
  pinnacle: { home: number; draw: number; away: number } | null;
  /** Sportybet odds (soft) */
  sportybet: { home: number; draw: number; away: number } | null;
  /** Edge: positive = Sportybet paying more than fair */
  homeEdge: number | null;
  drawEdge: number | null;
  awayEdge: number | null;
  /** Best edge found */
  bestEdge: number;
  bestPick: string;
  matched: boolean;
}

export interface CrossScanResult {
  events: CrossOddsEvent[];
  stats: {
    pinnacleEvents: number;
    sportyEvents: number;
    matched: number;
    withEdge: number;
    scanTime: number;
  };
}

// =========================================================================
// Pinnacle
// =========================================================================

const PINNACLE_BASE = 'https://guest.api.arcadia.pinnacle.com/0.1';

const PINNACLE_LEAGUES: { sport: string; leagueId: number; name: string }[] = [
  // Football
  { sport: 'football', leagueId: 1980, name: 'Premier League' },
  { sport: 'football', leagueId: 1977, name: 'Championship' },
  { sport: 'football', leagueId: 2627, name: 'Champions League' },
  { sport: 'football', leagueId: 2630, name: 'Europa League' },
  { sport: 'football', leagueId: 2635, name: 'Conference League' },
  { sport: 'football', leagueId: 2196, name: 'LaLiga' },
  { sport: 'football', leagueId: 1842, name: 'Bundesliga' },
  { sport: 'football', leagueId: 2436, name: 'Serie A' },
  { sport: 'football', leagueId: 2036, name: 'Ligue 1' },
  { sport: 'football', leagueId: 1817, name: 'Eredivisie' },
  { sport: 'football', leagueId: 2245, name: 'Liga Portugal' },
  { sport: 'football', leagueId: 2197, name: 'Super Lig' },
  { sport: 'football', leagueId: 1928, name: 'Danish Superliga' },
  { sport: 'football', leagueId: 1975, name: 'Norwegian Eliteserien' },
  { sport: 'football', leagueId: 2663, name: 'MLS' },
  // Basketball
  { sport: 'basketball', leagueId: 487, name: 'NBA' },
  { sport: 'basketball', leagueId: 578, name: 'Euroleague' },
  { sport: 'basketball', leagueId: 493, name: 'NCAA' },
];

interface PinnacleMatchup {
  id: number;
  home: string;
  away: string;
  startTime: string;
  leagueName: string;
  sport: string;
  moneyline?: { home: number; draw: number; away: number };
}

function toDecimal(american: number): number {
  if (american > 0) return american / 100 + 1;
  return -100 / american + 1;
}

async function fetchPinnacle(path: string): Promise<any> {
  try {
    const res = await fetch(`${PINNACLE_BASE}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function getPinnacleEvents(): Promise<PinnacleMatchup[]> {
  const allMatchups: PinnacleMatchup[] = [];

  // Fetch in parallel batches of 5
  for (let i = 0; i < PINNACLE_LEAGUES.length; i += 5) {
    const batch = PINNACLE_LEAGUES.slice(i, i + 5);
    const results = await Promise.allSettled(batch.map(async (league) => {
      const [matchups, markets] = await Promise.all([
        fetchPinnacle(`/leagues/${league.leagueId}/matchups`),
        fetchPinnacle(`/leagues/${league.leagueId}/markets/straight`),
      ]);

      if (!matchups || !Array.isArray(matchups)) return [];

      const odds = new Map<number, { home: number; draw: number; away: number }>();
      if (markets && Array.isArray(markets)) {
        for (const mkt of markets) {
          if (mkt.type !== 'moneyline' || mkt.period !== 0 || mkt.isAlternate) continue;
          const home = mkt.prices?.find((p: any) => p.designation === 'home');
          const draw = mkt.prices?.find((p: any) => p.designation === 'draw');
          const away = mkt.prices?.find((p: any) => p.designation === 'away');
          if (home && away) {
            odds.set(mkt.matchupId, {
              home: Math.round(toDecimal(home.price) * 100) / 100,
              draw: draw ? Math.round(toDecimal(draw.price) * 100) / 100 : 0,
              away: Math.round(toDecimal(away.price) * 100) / 100,
            });
          }
        }
      }

      const result: PinnacleMatchup[] = [];
      for (const m of matchups) {
        if (m.type !== 'matchup' || m.special) continue;
        const home = m.participants?.find((p: any) => p.alignment === 'home');
        const away = m.participants?.find((p: any) => p.alignment === 'away');
        if (!home || !away) continue;

        result.push({
          id: m.id,
          home: home.name,
          away: away.name,
          startTime: m.startTime || '',
          leagueName: league.name,
          sport: league.sport,
          moneyline: odds.get(m.id),
        });
      }
      return result;
    }));

    for (const r of results) {
      if (r.status === 'fulfilled') allMatchups.push(...r.value);
    }
  }

  return allMatchups.filter(m => m.moneyline); // only events with odds
}

// =========================================================================
// Sportybet
// =========================================================================

interface SportyEvent {
  eventId: string;
  home: string;
  away: string;
  league: string;
  startTime: number;
  homeOdds: number;
  drawOdds: number;
  awayOdds: number;
}

const SPORTY_COUNTRIES = ['gh', 'ng'];

async function getSportyEvents(): Promise<SportyEvent[]> {
  const allEvents: SportyEvent[] = [];
  const seen = new Set<string>();

  for (const cc of SPORTY_COUNTRIES) {
    // Football + Basketball sport IDs on Sportybet
    for (const sportId of ['sr%3Asport%3A1', 'sr%3Asport%3A2']) {
      for (let page = 1; page <= 5; page++) {
        try {
          const ts = Date.now();
          const url = `https://www.sportybet.com/api/${cc}/factsCenter/pcUpcomingEvents?_t=${ts}&sportId=${sportId}&marketId=1&pageSize=50&pageNum=${page}`;
          const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(8000),
          });

          if (!res.ok) break;
          const data = await res.json() as any;
          if (data.bizCode !== 10000) break;

          const tournaments = data.data?.tournaments || data.data?.events || [];
          if (!Array.isArray(tournaments) || !tournaments.length) break;

          for (const tournament of tournaments) {
            const events = tournament.events || [tournament];
            for (const ev of events) {
              if (seen.has(ev.eventId)) continue;
              seen.add(ev.eventId);

              const home = ev.homeTeamName;
              const away = ev.awayTeamName;
              if (!home || !away) continue;

              // Extract 1X2 odds
              let homeOdds = 0, drawOdds = 0, awayOdds = 0;
              const markets = ev.markets || [];
              for (const mkt of markets) {
                if (mkt.id !== '1' && mkt.desc !== '1X2') continue;
                for (const outcome of mkt.outcomes || []) {
                  const odds = parseFloat(outcome.odds) || 0;
                  if (outcome.desc === 'Home' || outcome.id === '1') homeOdds = odds;
                  else if (outcome.desc === 'Draw' || outcome.id === 'X') drawOdds = odds;
                  else if (outcome.desc === 'Away' || outcome.id === '2') awayOdds = odds;
                }
              }

              if (homeOdds > 1 && awayOdds > 1) {
                allEvents.push({
                  eventId: ev.eventId,
                  home, away,
                  league: tournament.name || ev.tournamentName || '',
                  startTime: ev.estimateStartTime || 0,
                  homeOdds, drawOdds, awayOdds,
                });
              }
            }
          }
        } catch { break; }
      }
    }
  }

  logger.info({ count: allEvents.length }, 'Sportybet events fetched');
  return allEvents;
}

// =========================================================================
// Matching
// =========================================================================

function normName(name: string): string {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/\s*(fc|sc|cf|afc|srl|ac|as|ss|us|rc|fk|sk|bk)\s*$/i, '')
    .replace(/^\s*(fc|sc|cf|afc|ac|as|rc|fk)\s+/i, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function nameMatch(a: string, b: string): boolean {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  // First word match (4+ chars)
  const fa = na.split(/\s+/)[0]!;
  const fb = nb.split(/\s+/)[0]!;
  if (fa.length >= 4 && fa === fb) return true;
  return false;
}

// =========================================================================
// Scan history for lag detection
// =========================================================================

interface OddsPoint {
  pinnHome: number; pinnDraw: number; pinnAway: number;
  sportyHome: number; sportyDraw: number; sportyAway: number;
  time: number;
}

const history = new Map<number, OddsPoint[]>();

function recordOdds(pinnId: number, pinn: { home: number; draw: number; away: number }, sporty: { home: number; draw: number; away: number }) {
  if (!history.has(pinnId)) history.set(pinnId, []);
  const h = history.get(pinnId)!;
  const last = h[h.length - 1];

  // Only record if something changed
  if (last && Math.abs(last.pinnHome - pinn.home) < 0.01 && Math.abs(last.sportyHome - sporty.home) < 0.01) return;

  h.push({
    pinnHome: pinn.home, pinnDraw: pinn.draw, pinnAway: pinn.away,
    sportyHome: sporty.home, sportyDraw: sporty.draw, sportyAway: sporty.away,
    time: Date.now(),
  });
  if (h.length > 20) h.shift();
}

// =========================================================================
// Public API
// =========================================================================

// Odds move fast but a full scan hits 18 Pinnacle leagues + 20 Sportybet
// pages per call, so we cache the aggregated result for 5 min.
let crossCache: CrossScanResult | null = null;
let crossCacheTime = 0;
const CROSS_CACHE_TTL = 5 * 60 * 1000;

export async function scanCrossOdds(): Promise<CrossScanResult> {
  if (crossCache && Date.now() - crossCacheTime < CROSS_CACHE_TTL) {
    return crossCache;
  }

  const start = Date.now();

  // Fetch both in parallel
  const [pinnEvents, sportyEvents] = await Promise.all([
    getPinnacleEvents(),
    getSportyEvents(),
  ]);

  // Match events
  const results: CrossOddsEvent[] = [];
  const sportyUsed = new Set<string>();

  for (const pinn of pinnEvents) {
    if (!pinn.moneyline) continue;

    // Find matching Sportybet event
    let sporty: SportyEvent | null = null;
    for (const s of sportyEvents) {
      if (sportyUsed.has(s.eventId)) continue;
      if (nameMatch(pinn.home, s.home) && nameMatch(pinn.away, s.away)) {
        sporty = s;
        sportyUsed.add(s.eventId);
        break;
      }
      // Try reversed order
      if (nameMatch(pinn.home, s.away) && nameMatch(pinn.away, s.home)) {
        sporty = s;
        sportyUsed.add(s.eventId);
        break;
      }
    }

    const pm = pinn.moneyline;
    const hasThreeWay = pm.draw > 1;
    const pinnSum = hasThreeWay ? 1 / pm.home + 1 / pm.draw + 1 / pm.away : 1 / pm.home + 1 / pm.away;

    // Fair (de-vigged) odds
    const fairHome = Math.round((pinnSum / (1 / pm.home)) * 100) / 100;
    const fairDraw = hasThreeWay ? Math.round((pinnSum / (1 / pm.draw)) * 100) / 100 : 0;
    const fairAway = Math.round((pinnSum / (1 / pm.away)) * 100) / 100;

    let homeEdge: number | null = null;
    let drawEdge: number | null = null;
    let awayEdge: number | null = null;

    if (sporty) {
      // Edge = (sportyOdds / fairOdds - 1) * 100
      homeEdge = sporty.homeOdds > 1 ? Math.round(((sporty.homeOdds / fairHome) - 1) * 1000) / 10 : null;
      drawEdge = sporty.drawOdds > 1 && fairDraw > 0 ? Math.round(((sporty.drawOdds / fairDraw) - 1) * 1000) / 10 : null;
      awayEdge = sporty.awayOdds > 1 ? Math.round(((sporty.awayOdds / fairAway) - 1) * 1000) / 10 : null;

      // Record for lag detection
      recordOdds(pinn.id, pm, { home: sporty.homeOdds, draw: sporty.drawOdds, away: sporty.awayOdds });
    }

    const edges = [
      { edge: homeEdge || 0, pick: 'Home' },
      { edge: drawEdge || 0, pick: 'Draw' },
      { edge: awayEdge || 0, pick: 'Away' },
    ].sort((a, b) => b.edge - a.edge);

    results.push({
      pinnacleId: pinn.id,
      sportyEventId: sporty?.eventId || null,
      sport: pinn.sport,
      league: pinn.leagueName,
      homeTeam: pinn.home,
      awayTeam: pinn.away,
      startTime: pinn.startTime,
      pinnacle: { home: fairHome, draw: fairDraw, away: fairAway },
      sportybet: sporty ? { home: sporty.homeOdds, draw: sporty.drawOdds, away: sporty.awayOdds } : null,
      homeEdge, drawEdge, awayEdge,
      bestEdge: edges[0]!.edge,
      bestPick: edges[0]!.pick,
      matched: !!sporty,
    });
  }

  // Sort: highest edge first, then matched first
  results.sort((a, b) => {
    if (a.matched !== b.matched) return a.matched ? -1 : 1;
    return b.bestEdge - a.bestEdge;
  });

  const withEdge = results.filter(r => r.matched && r.bestEdge > 0);

  logger.info({
    pinnacle: pinnEvents.length,
    sportybet: sportyEvents.length,
    matched: results.filter(r => r.matched).length,
    withEdge: withEdge.length,
    scanTime: Date.now() - start,
  }, 'Cross odds scan complete');

  const result: CrossScanResult = {
    events: results.filter(r => r.matched), // only show matched events
    stats: {
      pinnacleEvents: pinnEvents.length,
      sportyEvents: sportyEvents.length,
      matched: results.filter(r => r.matched).length,
      withEdge: withEdge.length,
      scanTime: Date.now() - start,
    },
  };

  crossCache = result;
  crossCacheTime = Date.now();

  return result;
}

/**
 * Arbitrage Scanner
 *
 * Finds cross-bookmaker arbitrage opportunities by comparing
 * Sportybet odds (from booking codes) against Pinnacle sharp odds.
 *
 * Arb formula: if (1/oddsA + 1/oddsB) < 1 → guaranteed profit.
 * Profit % = (1 - (1/oddsA + 1/oddsB)) * 100
 */

import { logger } from '../utils/logger.js';
import { getAllBookingCodes, type BookingCode, type BookingCodeSelection } from './booking-codes-scraper.js';
import { batchPinnacleOdds, type PinnacleOdds } from './pinnacle-odds.js';

// =========================================================================
// Types
// =========================================================================

export interface ArbOpportunity {
  /** Unique event identifier */
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  matchDate: string | null;
  kickoff: number | null;
  /** Market type (e.g. "1X2", "Over/Under 2.5") */
  market: string;
  /** The two legs of the arb */
  legs: ArbLeg[];
  /** Guaranteed profit % (e.g. 3.2 means 3.2% profit) */
  profitPct: number;
  /** Recommended stakes for $100 total outlay */
  stakes: { leg: string; bookmaker: string; stake: number; odds: number }[];
}

interface ArbLeg {
  bookmaker: string;
  pick: string;
  odds: number;
  impliedProb: number;
  /** Source booking code (for Sportybet legs) */
  sourceCode?: string;
}

// =========================================================================
// Cache
// =========================================================================

let resultCache: ArbitrageScanResult | null = null;
let resultCacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 min — odds are time-sensitive

// Minimum value-bet edge to report. Below this, name-match and stale-odds
// errors dominate real signal and the dashboard fills with noise.
const MIN_VALUE_EDGE_PCT = 2;
// Cap value-bet list to avoid flooding the UI when a scan produces many weak hits.
const MAX_VALUE_BETS = 50;

// =========================================================================
// Helpers
// =========================================================================

function arbProfit(odds1: number, odds2: number): number {
  const impliedSum = 1 / odds1 + 1 / odds2;
  return (1 - impliedSum) * 100;
}

function arbProfit3Way(odds1: number, odds2: number, odds3: number): number {
  const impliedSum = 1 / odds1 + 1 / odds2 + 1 / odds3;
  return (1 - impliedSum) * 100;
}

/** Calculate optimal stakes for a given total outlay and odds */
function calcStakes(totalOutlay: number, legs: ArbLeg[]): ArbOpportunity['stakes'] {
  const impliedSum = legs.reduce((s, l) => s + 1 / l.odds, 0);
  return legs.map(l => ({
    leg: l.pick,
    bookmaker: l.bookmaker,
    stake: Math.round((totalOutlay / (l.odds * impliedSum)) * 100) / 100,
    odds: l.odds,
  }));
}

// Sportybet tournament ID → Pinnacle-matchable league name
const TOURNAMENT_MAP: Record<string, string> = {
  'sr:tournament:7': 'Champions League',
  'sr:tournament:679': 'Europa League',
  'sr:tournament:34480': 'Conference League',
  'sr:tournament:17': 'Premier League',
  'sr:tournament:18': 'Championship',
  'sr:tournament:8': 'LaLiga',
  'sr:tournament:35': 'Bundesliga',
  'sr:tournament:23': 'Serie A',
  'sr:tournament:34': 'Ligue 1',
  'sr:tournament:37': 'Eredivisie',
  'sr:tournament:238': 'Liga Portugal',
  'sr:tournament:52': 'Super Lig',
  'sr:tournament:39': 'Superliga',        // Denmark
  'sr:tournament:20': 'Eliteserien',      // Norway
  'sr:tournament:38': 'Pro League',       // Belgium
  'sr:tournament:36': 'Premiership',      // Scotland
  'sr:tournament:358': 'Premiership',     // South Africa
  'sr:tournament:955': 'Saudi Pro',
  'sr:tournament:242': 'MLS',
  'sr:tournament:384': 'Libertadores',
  'sr:tournament:480': 'Sudamericana',
};

function resolveLeague(league: string): string {
  if (!league) return '';
  return TOURNAMENT_MAP[league] || league;
}

/** Normalize market description for matching */
function normalizeMarket(desc: string): { type: string; specifier: string } {
  if (!desc) return { type: 'unknown', specifier: '' };
  const lower = desc.toLowerCase();

  // Skip combined markets (e.g. "1X2 & GG/NG", "Over/Under & GG/NG")
  // These have inflated odds that can't be compared against single-market lines
  if (/&/.test(lower)) return { type: 'combined', specifier: desc };

  // Skip half-specific, corners, team-specific, and exotic markets
  if (/1st half|2nd half|half\s*time|corners/i.test(lower)) return { type: 'partial', specifier: desc };
  if (/from \d+ to \d+\s*minute/i.test(lower)) return { type: 'partial', specifier: desc };

  // Over/Under (full match only — with or without line number)
  if (/^over\s*\/\s*under/i.test(lower.trim()) || /^total/i.test(lower.trim())) {
    const lineMatch = lower.match(/([\d.]+)/);
    return { type: 'totals', specifier: lineMatch ? lineMatch[1]! : '' };
  }

  // 1X2 (plain, not "1X2 - 1UP", "1X2 - 2UP" etc.)
  if (/^1x2$/i.test(lower.trim()) || /^match result$/i.test(lower.trim()) || /^full time result$/i.test(lower.trim()))
    return { type: '1x2', specifier: '' };

  // GG/NG (Both Teams to Score)
  if (/^gg\s*\/\s*ng$/i.test(lower.trim()) || /^both\s*teams?\s*to\s*score$/i.test(lower.trim()))
    return { type: 'btts', specifier: '' };

  // Double Chance
  if (/^double\s*chance$/i.test(lower.trim()))
    return { type: 'double_chance', specifier: '' };

  return { type: 'unknown', specifier: desc };
}

/** Normalize pick/outcome description */
function normalizePick(pick: string, market: string): string {
  if (!pick) return 'unknown';
  const lower = pick.toLowerCase().trim();
  const mLower = (market || '').toLowerCase();

  // 1X2
  if (/home|1(?!\d)/.test(lower) && /1x2|match result|full time/i.test(mLower)) return 'home';
  if (/draw|x(?!$)/.test(lower) && /1x2|match result|full time/i.test(mLower)) return 'draw';
  if (/away|2(?!\d)/.test(lower) && /1x2|match result|full time/i.test(mLower)) return 'away';

  // Over/Under
  if (/over/i.test(lower)) return 'over';
  if (/under/i.test(lower)) return 'under';

  // BTTS
  if (/yes|gg/i.test(lower)) return 'yes';
  if (/no|ng/i.test(lower)) return 'no';

  return lower;
}

// =========================================================================
// Core Scanner
// =========================================================================

/**
 * Collect unique events + best Sportybet odds from all booking codes.
 * Groups by eventId + market, keeping the best odds per outcome.
 */
function collectSportybetOdds(codes: BookingCode[]): Map<string, {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  matchDate: string | null;
  kickoff: number | null;
  market: string;
  marketNorm: { type: string; specifier: string };
  outcomes: Map<string, { odds: number; sourceCode: string }>;
}> {
  const events = new Map<string, {
    eventId: string;
    homeTeam: string;
    awayTeam: string;
    league: string;
    matchDate: string | null;
    kickoff: number | null;
    market: string;
    marketNorm: { type: string; specifier: string };
    outcomes: Map<string, { odds: number; sourceCode: string }>;
  }>();

  for (const code of codes) {
    if (!code.isValid || !code.selections.length) continue;

    for (const sel of code.selections) {
      // Only pre-match or upcoming
      if (sel.matchStatus === 'Ended' || sel.matchStatus === 'Cancelled') continue;
      if (sel.isWinning !== null) continue; // already settled

      const marketNorm = normalizeMarket(sel.market);
      // For Over/Under, extract the line from the specifier field or pick text
      if (marketNorm.type === 'totals' && !marketNorm.specifier) {
        const lineFromSpec = sel.specifier?.match(/total=([\d.]+)/)?.[1];
        // Be specific: look for "Over X.X" or "Under X.X" pattern, not just any number
        const lineFromPick = (sel.pick || '').match(/(?:over|under)\s+([\d.]+)/i)?.[1];
        if (lineFromSpec) marketNorm.specifier = lineFromSpec;
        else if (lineFromPick) marketNorm.specifier = lineFromPick;
      }
      const key = `${sel.eventId}::${marketNorm.type}::${marketNorm.specifier}`;
      const pickNorm = normalizePick(sel.pick, sel.market);

      if (!events.has(key)) {
        events.set(key, {
          eventId: sel.eventId,
          homeTeam: sel.homeTeam,
          awayTeam: sel.awayTeam,
          league: resolveLeague(sel.league),
          matchDate: sel.matchDate,
          kickoff: sel.estimateStartTime,
          market: sel.market,
          marketNorm,
          outcomes: new Map(),
        });
      }

      const entry = events.get(key)!;
      // Prefer human-readable league names over raw IDs like sr:tournament:7
      if (entry.league.startsWith('sr:') && !sel.league.startsWith('sr:')) {
        entry.league = sel.league;
      }
      const existing = entry.outcomes.get(pickNorm);
      // Keep the best (highest) odds for each outcome
      if (!existing || sel.odds > existing.odds) {
        entry.outcomes.set(pickNorm, { odds: sel.odds, sourceCode: code.code });
      }
    }
  }

  return events;
}

/**
 * Compare Sportybet odds against Pinnacle to find arb opportunities.
 */
function findArbs(
  sportybetEvents: ReturnType<typeof collectSportybetOdds>,
  pinnacleMap: Map<string, PinnacleOdds>,
): ArbOpportunity[] {
  const arbs: ArbOpportunity[] = [];

  for (const [, event] of sportybetEvents) {
    const pinnacle = pinnacleMap.get(event.eventId);
    if (!pinnacle) continue;

    const { marketNorm } = event;

    // ── 1X2 market ──────────────────────────────────────────────
    if (marketNorm.type === '1x2' && pinnacle.moneyline) {
      const sportyHome = event.outcomes.get('home');
      const sportyDraw = event.outcomes.get('draw');
      const sportyAway = event.outcomes.get('away');
      const pinn = pinnacle.moneyline;

      // Check all 3-way combos: best odds for each outcome across both bookmakers
      const bestHome = Math.max(sportyHome?.odds ?? 0, pinn.home);
      const bestDraw = Math.max(sportyDraw?.odds ?? 0, pinn.draw);
      const bestAway = Math.max(sportyAway?.odds ?? 0, pinn.away);

      if (bestHome > 0 && bestDraw > 0 && bestAway > 0) {
        const profit = arbProfit3Way(bestHome, bestDraw, bestAway);
        if (profit > 0) {
          const legs: ArbLeg[] = [
            {
              bookmaker: (sportyHome?.odds ?? 0) >= pinn.home ? 'Sportybet' : 'Pinnacle',
              pick: 'Home',
              odds: bestHome,
              impliedProb: 1 / bestHome,
              sourceCode: (sportyHome?.odds ?? 0) >= pinn.home ? sportyHome?.sourceCode : undefined,
            },
            {
              bookmaker: (sportyDraw?.odds ?? 0) >= pinn.draw ? 'Sportybet' : 'Pinnacle',
              pick: 'Draw',
              odds: bestDraw,
              impliedProb: 1 / bestDraw,
              sourceCode: (sportyDraw?.odds ?? 0) >= pinn.draw ? sportyDraw?.sourceCode : undefined,
            },
            {
              bookmaker: (sportyAway?.odds ?? 0) >= pinn.away ? 'Sportybet' : 'Pinnacle',
              pick: 'Away',
              odds: bestAway,
              impliedProb: 1 / bestAway,
              sourceCode: (sportyAway?.odds ?? 0) >= pinn.away ? sportyAway?.sourceCode : undefined,
            },
          ];

          arbs.push({
            eventId: event.eventId,
            homeTeam: event.homeTeam,
            awayTeam: event.awayTeam,
            league: event.league,
            matchDate: event.matchDate,
            kickoff: event.kickoff,
            market: '1X2',
            legs,
            profitPct: Math.round(profit * 100) / 100,
            stakes: calcStakes(100, legs),
          });
        }
      }

    }

    // ── Over/Under market ───────────────────────────────────────
    if (marketNorm.type === 'totals' && pinnacle.totals?.length) {
      const specLine = parseFloat(marketNorm.specifier);
      const pinnTotal = pinnacle.totals.find(t => t.line === specLine);
      if (!pinnTotal) continue;

      const sportyOver = event.outcomes.get('over');
      const sportyUnder = event.outcomes.get('under');

      // Sportybet Over vs Pinnacle Under
      if (sportyOver) {
        const profit = arbProfit(sportyOver.odds, pinnTotal.under);
        if (profit > 0) {
          const legs: ArbLeg[] = [
            { bookmaker: 'Sportybet', pick: `Over ${specLine}`, odds: sportyOver.odds, impliedProb: 1 / sportyOver.odds, sourceCode: sportyOver.sourceCode },
            { bookmaker: 'Pinnacle', pick: `Under ${specLine}`, odds: pinnTotal.under, impliedProb: 1 / pinnTotal.under },
          ];
          arbs.push({
            eventId: event.eventId,
            homeTeam: event.homeTeam,
            awayTeam: event.awayTeam,
            league: event.league,
            matchDate: event.matchDate,
            kickoff: event.kickoff,
            market: `Over/Under ${specLine}`,
            legs,
            profitPct: Math.round(profit * 100) / 100,
            stakes: calcStakes(100, legs),
          });
        }
      }

      // Sportybet Under vs Pinnacle Over
      if (sportyUnder) {
        const profit = arbProfit(sportyUnder.odds, pinnTotal.over);
        if (profit > 0) {
          const legs: ArbLeg[] = [
            { bookmaker: 'Sportybet', pick: `Under ${specLine}`, odds: sportyUnder.odds, impliedProb: 1 / sportyUnder.odds, sourceCode: sportyUnder.sourceCode },
            { bookmaker: 'Pinnacle', pick: `Over ${specLine}`, odds: pinnTotal.over, impliedProb: 1 / pinnTotal.over },
          ];
          arbs.push({
            eventId: event.eventId,
            homeTeam: event.homeTeam,
            awayTeam: event.awayTeam,
            league: event.league,
            matchDate: event.matchDate,
            kickoff: event.kickoff,
            market: `Over/Under ${specLine}`,
            legs,
            profitPct: Math.round(profit * 100) / 100,
            stakes: calcStakes(100, legs),
          });
        }
      }
    }
  }

  // Sort by profit descending
  arbs.sort((a, b) => b.profitPct - a.profitPct);
  return arbs;
}

// =========================================================================
// Also find "value bets" — not pure arbs but where Sportybet odds
// significantly exceed Pinnacle fair odds (edge > 5%)
// =========================================================================

export interface ValueBet {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  matchDate: string | null;
  kickoff: number | null;
  market: string;
  pick: string;
  sportyOdds: number;
  pinnacleOdds: number;
  /** Fair odds (Pinnacle de-vigged) — what the odds "should" be */
  fairOdds: number;
  /** Fair probability from Pinnacle (no margin) */
  fairProb: number;
  /** Implied probability from Sportybet odds */
  sportyImplied: number;
  /** Expected value % (positive = Sportybet paying more than fair) */
  edgePct: number;
  /** "value" = Sportybet odds above fair, "dropping" = likely to decrease soon */
  signal: 'value' | 'dropping';
  sourceCode: string;
}

function pushValueBet(
  valueBets: ValueBet[],
  event: { eventId: string; homeTeam: string; awayTeam: string; league: string; matchDate: string | null; kickoff: number | null },
  market: string,
  pick: string,
  sportyOdds: number,
  pinnOdds: number,
  fairProb: number,
  srcCode: string,
) {
  const fairOdds = Math.round((1 / fairProb) * 100) / 100;
  const sportyImpl = 1 / sportyOdds;
  const ev = (sportyOdds * fairProb - 1) * 100;

  // sportyOdds > fairOdds → value (Sportybet overpaying, likely to drop)
  // sportyOdds ≈ fairOdds → no edge
  // Require a meaningful edge — sub-2% EV is dominated by name-match and
  // stale-odds noise and floods the UI with false positives.
  if (ev < MIN_VALUE_EDGE_PCT) return;

  // Signal: if sportyOdds is significantly above fair, it's likely to drop
  const signal: 'value' | 'dropping' = sportyOdds > fairOdds * 1.05 ? 'dropping' : 'value';

  valueBets.push({
    eventId: event.eventId,
    homeTeam: event.homeTeam,
    awayTeam: event.awayTeam,
    league: event.league,
    matchDate: event.matchDate,
    kickoff: event.kickoff,
    market,
    pick,
    sportyOdds,
    pinnacleOdds: pinnOdds,
    fairOdds,
    fairProb: Math.round(fairProb * 10000) / 100,
    sportyImplied: Math.round(sportyImpl * 10000) / 100,
    edgePct: Math.round(ev * 100) / 100,
    signal,
    sourceCode: srcCode,
  });
}

function findValueBets(
  sportybetEvents: ReturnType<typeof collectSportybetOdds>,
  pinnacleMap: Map<string, PinnacleOdds>,
): ValueBet[] {
  const valueBets: ValueBet[] = [];

  for (const [, event] of sportybetEvents) {
    const pinnacle = pinnacleMap.get(event.eventId);
    if (!pinnacle) continue;

    // 1X2 value
    if (event.marketNorm.type === '1x2' && pinnacle.moneyline) {
      const pinn = pinnacle.moneyline;
      const pinnSum = 1 / pinn.home + 1 / pinn.draw + 1 / pinn.away;

      const checks: [string, number | undefined, number, string][] = [
        ['Home', event.outcomes.get('home')?.odds, pinn.home, event.outcomes.get('home')?.sourceCode ?? ''],
        ['Draw', event.outcomes.get('draw')?.odds, pinn.draw, event.outcomes.get('draw')?.sourceCode ?? ''],
        ['Away', event.outcomes.get('away')?.odds, pinn.away, event.outcomes.get('away')?.sourceCode ?? ''],
      ];

      for (const [pick, sportyOdds, pinnOdds, srcCode] of checks) {
        if (!sportyOdds) continue;
        const fairProb = (1 / pinnOdds) / pinnSum;
        pushValueBet(valueBets, event, '1X2', pick, sportyOdds, pinnOdds, fairProb, srcCode);
      }
    }

    // Over/Under value
    if (event.marketNorm.type === 'totals' && pinnacle.totals?.length) {
      const specLine = parseFloat(event.marketNorm.specifier);
      const pinnTotal = pinnacle.totals.find(t => t.line === specLine);
      if (!pinnTotal) continue;

      const pinnSum = 1 / pinnTotal.over + 1 / pinnTotal.under;

      const checks: [string, number | undefined, number, string][] = [
        [`Over ${specLine}`, event.outcomes.get('over')?.odds, pinnTotal.over, event.outcomes.get('over')?.sourceCode ?? ''],
        [`Under ${specLine}`, event.outcomes.get('under')?.odds, pinnTotal.under, event.outcomes.get('under')?.sourceCode ?? ''],
      ];

      for (const [pick, sportyOdds, pinnOdds, srcCode] of checks) {
        if (!sportyOdds) continue;
        const fairProb = (1 / pinnOdds) / pinnSum;
        pushValueBet(valueBets, event, `Over/Under ${specLine}`, pick, sportyOdds, pinnOdds, fairProb, srcCode);
      }
    }
  }

  valueBets.sort((a, b) => b.edgePct - a.edgePct);
  return valueBets.slice(0, MAX_VALUE_BETS);
}

// =========================================================================
// PUBLIC API
// =========================================================================

export interface ArbitrageScanResult {
  arbs: ArbOpportunity[];
  valueBets: ValueBet[];
  stats: {
    codesAnalyzed: number;
    eventsScanned: number;
    pinnacleMatched: number;
    arbsFound: number;
    valueBetsFound: number;
    scanTime: number;
  };
}

/**
 * Scan all booking codes for arbitrage and value bet opportunities.
 */
export async function scanArbitrage(): Promise<ArbitrageScanResult> {
  if (resultCache && Date.now() - resultCacheTime < CACHE_TTL) {
    return resultCache;
  }

  const start = Date.now();

  // 1. Get all validated booking codes
  const codes = await getAllBookingCodes();

  // 2. Collect Sportybet odds grouped by event+market
  const sportybetEvents = collectSportybetOdds(codes);

  // 3. Build match list for Pinnacle lookup — include matchDate so the
  // resolver can disambiguate fixtures with overlapping team names across
  // different kickoff days (e.g. Paris FC vs Brest 03/05 vs PSG vs Brest 10/05).
  const seenEvents = new Set<string>();
  const matchList: { homeTeam: string; awayTeam: string; league: string; eventId: string; matchDate?: string | null }[] = [];

  for (const [, event] of sportybetEvents) {
    if (seenEvents.has(event.eventId)) continue;
    seenEvents.add(event.eventId);
    matchList.push({
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      league: event.league,
      eventId: event.eventId,
      matchDate: event.matchDate,
    });
  }

  // 4. Fetch Pinnacle odds for all events
  const pinnacleMap = await batchPinnacleOdds(matchList);

  // 5. Find arbs and value bets
  const arbs = findArbs(sportybetEvents, pinnacleMap);
  const valueBets = findValueBets(sportybetEvents, pinnacleMap);

  const scanTime = Date.now() - start;

  const result: ArbitrageScanResult = {
    arbs,
    valueBets,
    stats: {
      codesAnalyzed: codes.length,
      eventsScanned: matchList.length,
      pinnacleMatched: pinnacleMap.size,
      arbsFound: arbs.length,
      valueBetsFound: valueBets.length,
      scanTime,
    },
  };

  resultCache = result;
  resultCacheTime = Date.now();

  logger.info(result.stats, 'Arbitrage scan complete');

  return result;
}

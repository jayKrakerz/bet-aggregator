/**
 * Odds Lag Detector
 *
 * Monitors Pinnacle sharp line movements and compares against Sportybet odds.
 * When Pinnacle moves but Sportybet hasn't adjusted, that's a value window.
 *
 * How it works:
 * 1. Fetch Pinnacle odds for upcoming matches (sharp line)
 * 2. Compare against Sportybet odds from our booking codes
 * 3. Detect "lag" — where Sportybet odds are stale vs the sharp move
 * 4. Alert: bet the stale Sportybet odds before they correct
 */

import { logger } from '../utils/logger.js';
import { getAllBookingCodes, type BookingCode, type BookingCodeSelection } from './booking-codes-scraper.js';
import { batchPinnacleOdds, type PinnacleOdds } from './pinnacle-odds.js';

// =========================================================================
// Types
// =========================================================================

export interface OddsSnapshot {
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
  fairOdds: number;           // Pinnacle de-vigged
  timestamp: number;
  sourceCode: string;
}

export interface OddsLagAlert {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  kickoff: number | null;
  market: string;
  pick: string;
  /** Current Sportybet odds (stale) */
  sportyOdds: number;
  /** Current Pinnacle fair odds (sharp) */
  fairOdds: number;
  /** Previous Pinnacle fair odds (before the move) */
  prevFairOdds: number;
  /** How much Pinnacle moved (negative = odds dropped = sharp money came in) */
  pinnacleMovePct: number;
  /** Edge: how much Sportybet is overpaying vs the new sharp line */
  edgePct: number;
  /** How long ago Pinnacle moved (ms) */
  lagMs: number;
  /** Action: bet this on Sportybet before odds adjust */
  action: string;
  sourceCode: string;
  severity: 'hot' | 'warm' | 'cool';
}

// =========================================================================
// History tracking
// =========================================================================

// Store snapshots over time to detect movement
const oddsHistory: Map<string, OddsSnapshot[]> = new Map();
const MAX_HISTORY = 10;      // keep last 10 snapshots per pick
const HISTORY_TTL = 4 * 60 * 60 * 1000; // 4 hours

function recordSnapshot(snap: OddsSnapshot) {
  const key = `${snap.eventId}:${snap.market}:${snap.pick}`;
  if (!oddsHistory.has(key)) oddsHistory.set(key, []);
  const history = oddsHistory.get(key)!;

  // Don't record if nothing changed
  const last = history[history.length - 1];
  if (last && Math.abs(last.fairOdds - snap.fairOdds) < 0.01 && Math.abs(last.sportyOdds - snap.sportyOdds) < 0.01) {
    return;
  }

  history.push(snap);
  if (history.length > MAX_HISTORY) history.shift();

  // Prune old entries
  const cutoff = Date.now() - HISTORY_TTL;
  while (history.length > 0 && history[0]!.timestamp < cutoff) history.shift();
}

// =========================================================================
// Detection
// =========================================================================

// Pinnacle must drop by at least this % for us to count it as a sharp move.
// Lower = more alerts (including noise); higher = only big moves.
const LAG_MOVE_THRESHOLD_PCT = -2;

function detectLags(moveThresholdPct = LAG_MOVE_THRESHOLD_PCT): OddsLagAlert[] {
  const alerts: OddsLagAlert[] = [];
  const now = Date.now();

  for (const [, history] of oddsHistory) {
    if (history.length < 2) continue;

    const latest = history[history.length - 1]!;
    const previous = history[history.length - 2]!;

    // Skip if match already started
    if (latest.kickoff && latest.kickoff < now) continue;

    // Calculate Pinnacle movement
    const pinnacleMove = ((latest.fairOdds - previous.fairOdds) / previous.fairOdds) * 100;

    // Pinnacle odds DROPPED (sharp money came in on this outcome)
    // But Sportybet still has the old (higher) odds = value window
    if (pinnacleMove < moveThresholdPct) {
      // Sportybet edge = how much Sportybet overpays vs new fair line
      const edge = ((latest.sportyOdds * (1 / latest.fairOdds)) - 1) * 100;

      if (edge > 0) {
        const lagMs = latest.timestamp - previous.timestamp;
        let severity: 'hot' | 'warm' | 'cool' = 'cool';
        if (edge >= 5 && pinnacleMove <= -5) severity = 'hot';
        else if (edge >= 3 || pinnacleMove <= -3) severity = 'warm';

        alerts.push({
          eventId: latest.eventId,
          homeTeam: latest.homeTeam,
          awayTeam: latest.awayTeam,
          league: latest.league,
          kickoff: latest.kickoff,
          market: latest.market,
          pick: latest.pick,
          sportyOdds: latest.sportyOdds,
          fairOdds: latest.fairOdds,
          prevFairOdds: previous.fairOdds,
          pinnacleMovePct: Math.round(pinnacleMove * 10) / 10,
          edgePct: Math.round(edge * 10) / 10,
          lagMs,
          action: `Bet ${latest.pick} on Sportybet @${latest.sportyOdds} — Pinnacle already moved to @${latest.fairOdds.toFixed(2)}`,
          sourceCode: latest.sourceCode,
          severity,
        });
      }
    }

    // REVERSE: Pinnacle odds ROSE (sharp money on the OTHER side)
    // Sportybet odds on this outcome may be too LOW (avoid betting this)
    // But the OPPOSITE outcome on Sportybet might now be value
    // (We don't track opposite outcomes here — the arb scanner handles that)
  }

  // Sort: hot first, then by edge
  alerts.sort((a, b) => {
    const sevOrder = { hot: 0, warm: 1, cool: 2 };
    const sevDiff = sevOrder[a.severity] - sevOrder[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return b.edgePct - a.edgePct;
  });

  return alerts;
}

// =========================================================================
// Tournament ID resolver (shared with arbitrage scanner)
// =========================================================================

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
  'sr:tournament:39': 'Superliga',
  'sr:tournament:20': 'Eliteserien',
  'sr:tournament:38': 'Pro League',
  'sr:tournament:36': 'Premiership',
  'sr:tournament:358': 'Premiership',
  'sr:tournament:955': 'Saudi Pro',
  'sr:tournament:242': 'MLS',
  'sr:tournament:384': 'Libertadores',
  'sr:tournament:480': 'Sudamericana',
};

function resolveLeague(league: string): string {
  return TOURNAMENT_MAP[league] || league;
}

// =========================================================================
// Public API
// =========================================================================

export interface OddsLagResult {
  alerts: OddsLagAlert[];
  stats: {
    eventsTracked: number;
    pinnacleMatched: number;
    snapshotsStored: number;
    alertsFound: number;
    scanTime: number;
  };
}

/**
 * Scan for odds lag: compare Sportybet vs Pinnacle, record snapshots, detect stale odds.
 * Call this every 5-10 minutes for best results.
 *
 * @param moveThresholdPct Pinnacle drop % required to count as a sharp move.
 *   Default -2. Lower (e.g. -1) = more alerts + noise. Higher = only big moves.
 */
export async function scanOddsLag(moveThresholdPct?: number): Promise<OddsLagResult> {
  const start = Date.now();

  // 1. Get all validated codes
  const codes = await getAllBookingCodes();

  // 2. Collect unique events with Sportybet odds
  const events = new Map<string, {
    eventId: string; homeTeam: string; awayTeam: string; league: string;
    matchDate: string | null; kickoff: number | null;
    picks: Map<string, { market: string; pick: string; odds: number; sourceCode: string }>;
  }>();

  for (const code of codes) {
    if (!code.isValid) continue;
    for (const sel of code.selections) {
      if (!sel.eventId || !sel.homeTeam || !sel.awayTeam || !sel.market || !sel.pick) continue;
      if (sel.isWinning !== null) continue;
      if (sel.matchStatus === 'Ended' || sel.matchStatus === 'Cancelled') continue;

      const mLower = (sel.market || '').toLowerCase();
      // Track 1X2, Over/Under, and Moneyline (basketball) — matchable to Pinnacle
      const is1x2 = mLower === '1x2' || mLower === 'match winner' || mLower === 'moneyline';
      const isOU = (mLower === 'over/under' || mLower === 'total') && !mLower.includes('&');
      if (!is1x2 && !isOU) continue;

      if (!events.has(sel.eventId)) {
        events.set(sel.eventId, {
          eventId: sel.eventId,
          homeTeam: sel.homeTeam,
          awayTeam: sel.awayTeam,
          league: resolveLeague(sel.league),
          matchDate: sel.matchDate,
          kickoff: sel.estimateStartTime,
          picks: new Map(),
        });
      }

      const ev = events.get(sel.eventId)!;
      const pickKey = `${sel.market}:${sel.pick}`;
      const existing = ev.picks.get(pickKey);
      // Keep best (highest) odds
      if (!existing || sel.odds > existing.odds) {
        ev.picks.set(pickKey, { market: sel.market, pick: sel.pick, odds: sel.odds, sourceCode: code.code });
      }
    }
  }

  // 3. Fetch Pinnacle odds
  const matchList = [...events.values()].map(ev => ({
    homeTeam: ev.homeTeam, awayTeam: ev.awayTeam, league: ev.league, eventId: ev.eventId,
  }));
  const pinnacleMap = await batchPinnacleOdds(matchList);

  // 4. Compare and record snapshots
  const now = Date.now();
  let snapshotCount = 0;

  for (const [eventId, ev] of events) {
    const pinnacle = pinnacleMap.get(eventId);
    if (!pinnacle || !pinnacle.moneyline) continue;

    const pinn = pinnacle.moneyline;
    // Handle 2-way (basketball) vs 3-way (soccer) — draw might be 0
    const hasThreeWay = pinn.draw > 1;
    const pinnSum = hasThreeWay
      ? 1 / pinn.home + 1 / pinn.draw + 1 / pinn.away
      : 1 / pinn.home + 1 / pinn.away;

    for (const [, pick] of ev.picks) {
      let pinnOdds: number | null = null;
      const pickLower = pick.pick.toLowerCase();
      const mktLower = pick.market.toLowerCase();

      if (mktLower.includes('1x2') || mktLower === 'match winner' || mktLower === 'moneyline') {
        if (pickLower === 'home' || pickLower === '1' || pickLower.includes(ev.homeTeam.toLowerCase().slice(0, 4))) pinnOdds = pinn.home;
        else if (pickLower === 'draw' || pickLower === 'x') pinnOdds = pinn.draw;
        else if (pickLower === 'away' || pickLower === '2' || pickLower.includes(ev.awayTeam.toLowerCase().slice(0, 4))) pinnOdds = pinn.away;
      }

      if (!pinnOdds) continue;

      const fairProb = (1 / pinnOdds) / pinnSum;
      const fairOdds = Math.round((1 / fairProb) * 100) / 100;

      const snap: OddsSnapshot = {
        eventId, homeTeam: ev.homeTeam, awayTeam: ev.awayTeam,
        league: ev.league, matchDate: ev.matchDate, kickoff: ev.kickoff,
        market: pick.market, pick: pick.pick,
        sportyOdds: pick.odds, pinnacleOdds: pinnOdds, fairOdds,
        timestamp: now, sourceCode: pick.sourceCode,
      };

      recordSnapshot(snap);
      snapshotCount++;
    }
  }

  // 5. Detect lags
  const alerts = detectLags(moveThresholdPct);

  const scanTime = Date.now() - start;
  logger.info({
    eventsTracked: events.size,
    pinnacleMatched: pinnacleMap.size,
    snapshots: snapshotCount,
    alerts: alerts.length,
    scanTime,
  }, 'Odds lag scan complete');

  return {
    alerts,
    stats: {
      eventsTracked: events.size,
      pinnacleMatched: pinnacleMap.size,
      snapshotsStored: snapshotCount,
      alertsFound: alerts.length,
      scanTime,
    },
  };
}

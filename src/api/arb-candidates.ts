/**
 * Multi-minute Arb Candidates Scanner.
 *
 * For each upcoming football match Pinnacle is booking:
 *   1) De-vig the O/U half-line nearest 2.5 → implied P(Over)
 *   2) Solve for total xG λ via Poisson bisection
 *   3) For each candidate hedge minute m in HEDGE_MINUTES:
 *        - P(game still 0-0 at minute m) = e^(-λ × m/90)
 *        - Fair live Over odds at m'0-0 = 1 / P(≥3 goals in remaining (90-m) min)
 *        - Fair-value arb % = 1 - (1/fair_pre_under + 1/fair_live_over_m)
 *        - Real arb % assumes ~7% margin on the live hedge book
 *   4) Find the optimal hedge minute — the strategy is "ride the goalless
 *      stretch as long as possible because Over odds keep inflating".
 *
 * The user's open Under bet stays alive for the full 90 min. They can hedge
 * at any minute — earlier = smaller arb but higher chance of reaching it,
 * later = bigger arb but more goal risk en route. The scanner shows the
 * full curve so the user picks their tradeoff.
 *
 * Filters out non-goals prop markets (corners/bookings/cards) — the Poisson
 * goal model doesn't apply to those arrival rates.
 */

import { logger } from '../utils/logger.js';
import { getAllFootballFixturesWithOdds, type FootballFixture } from './pinnacle-odds.js';

// ── Tunables ─────────────────────────────────────────────

// Hedge windows we evaluate. Strategy assumes the user is watching the match
// live and will execute the hedge at one of these minutes if the game is
// still goalless. After 60' live limits collapse on most soft books and
// suspensions become frequent, so we stop there.
const HEDGE_MINUTES = [5, 10, 15, 20, 25, 30, 35, 40, 50, 60];
const MATCH_LENGTH = 90;
const ASSUMED_LIVE_MARGIN = 0.07;
const CACHE_TTL_MS = 5 * 60 * 1000;
const HORIZON_HOURS = 36;

// ── Types ────────────────────────────────────────────────

export interface HedgeCheckpoint {
  minute: number;
  pNoGoalReached: number;       // probability the game is still 0-0 at this minute
  fairLiveOver: number;         // fair-value Over odds at minute m, score 0-0
  realLiveOver: number;         // assumed real Over odds (live margin baked in)
  fairArbPct: number;           // % using fair pre-Under and fair live-Over
  realArbPct: number;           // % using Pinnacle pre-Under and assumed real live-Over
}

export interface ArbCandidate {
  matchupId: number;
  startTime: string;
  hoursUntilKickoff: number;
  homeTeam: string;
  awayTeam: string;

  // Pinnacle raw — line may not always be 2.5 if the bookmaker's main-line
  // shifted. We adapt to whatever half-line is available.
  pinnacleLine: number;
  pinnacleOver: number;
  pinnacleUnder: number;
  pinnacleMargin: number;

  xgImplied: number;
  fairPreMatchUnder: number;

  // Per-minute hedge math
  timeline: HedgeCheckpoint[];

  // Best window — the minute with the highest realArbPct, capped to the
  // first minute where realArb is positive if any. If none positive, picks
  // the minute with highest fairArbPct (so the user still sees the math).
  bestMinute: number;
  bestPNoGoalReached: number;
  bestFairArbPct: number;
  bestRealArbPct: number;
  bestFairLiveOver: number;
  bestRealLiveOver: number;

  verdict: 'STRONG' | 'MARGINAL' | 'SKIP';
}

export interface ArbCandidatesResult {
  candidates: ArbCandidate[];
  totalScanned: number;
  totalUpcoming: number;
  scrapedAt: string;
}

// ── Math helpers ────────────────────────────────────────

function poissonCdf(k: number, lambda: number): number {
  if (lambda <= 0) return k >= 0 ? 1 : 0;
  let s = 0;
  let term = Math.exp(-lambda);
  s = term;
  for (let i = 1; i <= k; i++) {
    term *= lambda / i;
    s += term;
  }
  return Math.min(1, s);
}

function pOverFromLambda(line: number, lambda: number): number {
  return 1 - poissonCdf(Math.floor(line), lambda);
}

function solveLambda(line: number, targetProb: number): number {
  let lo = 0.05;
  let hi = 8.0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const p = pOverFromLambda(line, mid);
    if (p < targetProb) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── Cache ────────────────────────────────────────────────

let cache: ArbCandidatesResult | null = null;
let cacheTime = 0;

// ── Per-match arb analysis ───────────────────────────────

function analyse(f: FootballFixture, nowMs: number): ArbCandidate | null {
  if (/\((Corners|Bookings|Cards|Free Kicks|Throw[\- ]ins|Offsides|Goal Kicks)\)/i.test(f.homeTeam + f.awayTeam)) return null;

  const halves = (f.totals ?? []).filter(
    (x) => x.over > 1 && x.under > 1 && Math.abs(x.line - Math.floor(x.line) - 0.5) < 1e-6,
  );
  if (!halves.length) return null;
  const t = halves.reduce((best, cur) =>
    Math.abs(cur.line - 2.5) < Math.abs(best.line - 2.5) ? cur : best,
  );

  // De-vig (proportional method)
  const sumImplied = 1 / t.over + 1 / t.under;
  const margin = sumImplied - 1;
  const pOverDevig = 1 / t.over / sumImplied;
  const pUnderDevig = 1 / t.under / sumImplied;

  const lambda = solveLambda(t.line, pOverDevig);
  const fairPreMatchUnder = 1 / pUnderDevig;

  // Build timeline: for each candidate hedge minute, compute the math.
  const timeline: HedgeCheckpoint[] = [];
  for (const m of HEDGE_MINUTES) {
    if (m >= MATCH_LENGTH) break;
    const lambdaRemaining = lambda * (MATCH_LENGTH - m) / MATCH_LENGTH;
    const pOverRem = pOverFromLambda(t.line, lambdaRemaining);
    if (pOverRem <= 0 || pOverRem >= 1) continue;
    const fairLiveOver = 1 / pOverRem;
    const realLiveOver = fairLiveOver * (1 - ASSUMED_LIVE_MARGIN);
    const fairArbPct = (1 - (1 / fairPreMatchUnder + 1 / fairLiveOver)) * 100;
    const realArbPct = (1 - (1 / t.under + 1 / realLiveOver)) * 100;
    const pNoGoalReached = Math.exp((-lambda * m) / MATCH_LENGTH);
    timeline.push({ minute: m, pNoGoalReached, fairLiveOver, realLiveOver, fairArbPct, realArbPct });
  }
  if (!timeline.length) return null;

  // Pick the best hedge minute. Prefer the one with highest realArbPct that
  // still has P(reaching it 0-0) ≥ 0.55. If none have realArb > 0, fall back
  // to the minute with the highest fairArbPct so the user sees the ceiling.
  const tradeable = timeline.filter((c) => c.pNoGoalReached >= 0.55);
  const bestByReal = (tradeable.length ? tradeable : timeline).reduce((best, cur) =>
    cur.realArbPct > best.realArbPct ? cur : best,
  );
  const bestByFair = timeline.reduce((best, cur) => (cur.fairArbPct > best.fairArbPct ? cur : best));
  const best = bestByReal.realArbPct > 0 ? bestByReal : bestByFair;

  // Verdict — based on best window's math.
  //   STRONG   = realArb ≥ 2% at the best minute AND P(reach) ≥ 65%
  //   MARGINAL = fairArb ≥ 3% somewhere in timeline (math works in theory)
  //   SKIP     = neither
  const verdict: ArbCandidate['verdict'] =
    best.realArbPct >= 2 && best.pNoGoalReached >= 0.65 ? 'STRONG'
    : best.fairArbPct >= 3 ? 'MARGINAL'
    : 'SKIP';

  void margin;
  const startMs = f.startTime ? new Date(f.startTime).getTime() : 0;
  const hoursUntilKickoff = startMs > 0 ? (startMs - nowMs) / 3_600_000 : -1;

  return {
    matchupId: f.matchupId,
    startTime: f.startTime,
    hoursUntilKickoff,
    homeTeam: f.homeTeam,
    awayTeam: f.awayTeam,
    pinnacleLine: t.line,
    pinnacleOver: t.over,
    pinnacleUnder: t.under,
    pinnacleMargin: margin,
    xgImplied: lambda,
    fairPreMatchUnder,
    timeline,
    bestMinute: best.minute,
    bestPNoGoalReached: best.pNoGoalReached,
    bestFairArbPct: best.fairArbPct,
    bestRealArbPct: best.realArbPct,
    bestFairLiveOver: best.fairLiveOver,
    bestRealLiveOver: best.realLiveOver,
    verdict,
  };
}

// ── Public API ───────────────────────────────────────────

export async function getArbCandidates(forceRefresh = false): Promise<ArbCandidatesResult> {
  if (!forceRefresh && cache && Date.now() - cacheTime < CACHE_TTL_MS) return cache;

  const fixtures = await getAllFootballFixturesWithOdds();
  const now = Date.now();
  const horizonMs = HORIZON_HOURS * 3_600_000;

  const upcoming = fixtures.filter((f) => {
    if (!f.startTime) return false;
    const ms = new Date(f.startTime).getTime();
    return !isNaN(ms) && ms > now && ms - now < horizonMs;
  });

  const allAnalysed: ArbCandidate[] = [];
  for (const f of upcoming) {
    const a = analyse(f, now);
    if (a) allAnalysed.push(a);
  }

  // Sort by bestRealArbPct desc — the user's actionable order. STRONG first.
  const candidates = allAnalysed.sort((a, b) => {
    if (a.verdict !== b.verdict) {
      const order = { STRONG: 0, MARGINAL: 1, SKIP: 2 };
      return order[a.verdict] - order[b.verdict];
    }
    return b.bestRealArbPct - a.bestRealArbPct;
  });

  const result: ArbCandidatesResult = {
    candidates,
    totalScanned: allAnalysed.length,
    totalUpcoming: upcoming.length,
    scrapedAt: new Date().toISOString(),
  };

  cache = result;
  cacheTime = Date.now();
  logger.info(
    {
      candidates: candidates.length,
      strong: candidates.filter((c) => c.verdict === 'STRONG').length,
      analysed: allAnalysed.length,
      upcoming: upcoming.length,
    },
    'arb-candidates: computed',
  );
  return result;
}

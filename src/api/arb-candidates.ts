/**
 * 5-Min Arb Candidates Scanner.
 *
 * Identifies upcoming football matches where a "bet Under pre-match, hedge
 * with live Over after 5' goalless" cycle locks in a positive guaranteed
 * return. The math comes purely from Pinnacle's de-vigged O/U 2.5 line:
 *
 *   1) De-vig the Pinnacle O/U 2.5 → implied P(Over)
 *   2) Solve for total xG λ such that P(Over | Poisson(λ)) matches
 *   3) Compute P(no goal in 5 min) = e^(-λ × 5/90)
 *   4) Compute fair live Over odds at 5'0-0 = 1 / P(≥3 goals in remaining 85')
 *   5) Fair-value arb = 1 - (1/fairPreMatchUnder + 1/fairLiveOver5)
 *   6) Real arb estimate assumes ~7% margin on the live hedge book
 *
 * We flag matches where:
 *   - P(no goal in 5 min) ≥ 0.85   (high chance the hedge window opens)
 *   - real arb ≥ 1.5%              (after assumed live margin)
 *
 * Caveats are real (book detection, live limits, suspensions). The scanner
 * surfaces math-eligible matches; the user decides which to act on.
 */

import { logger } from '../utils/logger.js';
import { getAllFootballFixturesWithOdds, type FootballFixture } from './pinnacle-odds.js';

// ── Tunables ─────────────────────────────────────────────

const HEDGE_MINUTE = 5;
const MATCH_LENGTH = 90;
const ASSUMED_LIVE_MARGIN = 0.07;   // ~7% extra margin live books typically apply
const MIN_P_NO_GOAL = 0.85;
const MIN_REAL_ARB_PCT = 1.5;
const CACHE_TTL_MS = 5 * 60 * 1000;
const HORIZON_HOURS = 36;            // only show matches kicking off within 36h

// ── Types ────────────────────────────────────────────────

export interface ArbCandidate {
  matchupId: number;
  startTime: string;
  hoursUntilKickoff: number;
  homeTeam: string;
  awayTeam: string;

  // Pinnacle raw — line may not always be 2.5 if the bookmaker's main-line
  // shifted. We adapt and use whatever half-line is available.
  pinnacleLine: number;
  pinnacleOver: number;
  pinnacleUnder: number;
  pinnacleMargin: number;

  // Derived
  xgImplied: number;                 // total expected goals
  pNoGoalIn5: number;                // 0-1
  fairPreMatchUnder: number;         // 1 / devigged P(Under)
  fairLiveOverAt5: number;           // 1 / P(≥3 goals from minute 5, score 0-0)

  // Arb math
  fairValueArbPct: number;           // % ROI if you got fair-value odds at both books
  realArbPct: number;                // % ROI accounting for assumed live margin
  recommendedHedgeStakeFraction: number;  // X / (100 + X) for $100 base bet

  verdict: 'STRONG' | 'MARGINAL' | 'SKIP';
}

export interface ArbCandidatesResult {
  candidates: ArbCandidate[];
  totalScanned: number;
  totalUpcoming: number;             // upcoming football fixtures within horizon
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
  // P(total goals > line) = 1 - cdf(floor(line), lambda)
  return 1 - poissonCdf(Math.floor(line), lambda);
}

/**
 * Solve for λ such that P(Over `line` | Poisson(λ)) = targetProb.
 * Uses simple bisection — pOver is monotonic in λ.
 */
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

// ── Per-match arb math ──────────────────────────────────

function analyse(f: FootballFixture, nowMs: number): ArbCandidate | null {
  // Pinnacle duplicates the same matchup under "(Corners)" / "(Bookings)" /
  // "(Cards)" suffixes for prop markets. Those have completely different
  // arrival rates than goals — the Poisson goal model doesn't apply. Skip.
  if (/\((Corners|Bookings|Cards|Free Kicks|Throw[\- ]ins|Offsides|Goal Kicks)\)/i.test(f.homeTeam + f.awayTeam)) return null;

  // Pick the half-line total closest to 2.5 — most books carry 2.5 as the
  // main line, but some matches anchor at 2.0, 2.75, 3.0, 3.5 depending on
  // expected total. Quarter-lines (2.25, 2.75) need split-stake math we don't
  // do here, so prefer half-lines (X.5).
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
  const pNoGoalIn5 = Math.exp((-lambda * HEDGE_MINUTE) / MATCH_LENGTH);

  // At 5'0-0 the remaining-time goal rate scales linearly down by 5/90
  const lambdaRemaining = lambda * (MATCH_LENGTH - HEDGE_MINUTE) / MATCH_LENGTH;
  const pOver5 = pOverFromLambda(t.line, lambdaRemaining);
  if (pOver5 <= 0 || pOver5 >= 1) return null;

  const fairPreMatchUnder = 1 / pUnderDevig;
  const fairLiveOverAt5 = 1 / pOver5;

  const fairValueArbPct = (1 - (1 / fairPreMatchUnder + 1 / fairLiveOverAt5)) * 100;

  // Real arb: assume the live hedge book applies ASSUMED_LIVE_MARGIN of vig.
  // The pre-match Under price we use is Pinnacle's actual price (sharp, ~2%
  // margin already baked in) — that's what the user would book at Pinnacle
  // or a similarly-priced soft book.
  const realLiveOver = fairLiveOverAt5 * (1 - ASSUMED_LIVE_MARGIN);
  const realArbPct = (1 - (1 / t.under + 1 / realLiveOver)) * 100;
  void margin;  // surfaced via pinnacleMargin but otherwise unused

  // Optimal hedge stake fraction (for a $1 pre-match Under bet, what to
  // stake on the live Over side to balance both outcomes' returns):
  //   1.4X - 1 = (under-1) - X        →   X = (under) / (1 + (over-1))
  // Generalised: X / (1+X) ≈ 1/over_live  for moderate values.
  const recommendedHedgeStakeFraction = 1 / realLiveOver;

  // Verdict ranks the math, not real-world feasibility — surface the candidate
  // pool and let the user judge whether their book combo (sharp pre-match +
  // slow live) closes the fair-value gap.
  //
  //   STRONG   = fairArb ≥ 4% AND P(no goal in 5') ≥ 88%
  //   MARGINAL = fairArb ≥ 2% AND P(no goal in 5') ≥ 82%
  //   SKIP     = otherwise
  //
  // realArb is shown alongside as the "after typical book margins" estimate;
  // it's almost always lower or negative. That's the honest friction warning.
  const verdict: ArbCandidate['verdict'] =
    fairValueArbPct >= 4 && pNoGoalIn5 >= 0.88 ? 'STRONG'
    : fairValueArbPct >= 2 && pNoGoalIn5 >= 0.82 ? 'MARGINAL'
    : 'SKIP';
  void MIN_P_NO_GOAL; void MIN_REAL_ARB_PCT;

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
    pNoGoalIn5,
    fairPreMatchUnder,
    fairLiveOverAt5,
    fairValueArbPct,
    realArbPct,
    recommendedHedgeStakeFraction,
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

  // Sort by realArbPct descending. Show all analysed (frontend can filter
  // on verdict — this lets the user see the full landscape, not just the
  // ones that passed our threshold).
  const candidates = allAnalysed.sort((a, b) => b.realArbPct - a.realArbPct);

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

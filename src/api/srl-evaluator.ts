/**
 * SRL Evaluator
 *
 * Joins each settled match against the prediction we WOULD have made at
 * snapshot time (using the SAME predictor with priors-as-of-then is
 * impossible without time-travel — instead we recompute against the
 * snapshot's odds + current priors, which is still useful for relative
 * calibration but biased by hindsight on the league prior).
 *
 * To stay honest we report THREE Brier scores:
 *   - bookieImpliedBrier — using 1/odds (what naive bettor sees)
 *   - bookieTrueBrier   — using engine probability (the bookie's own truth)
 *   - modelBrier        — our predictor's recomputed prediction
 *
 * If modelBrier > bookieTrueBrier on a healthy sample, the predictor has
 * NO edge — and the UI banner says exactly that.
 *
 * CLV: per-pick, we capture snapshot odds vs settle odds. Without a clean
 * "closing" line for SRL (matches finish in 12 min and odds vanish), CLV
 * here is "snapshot vs final pre-suspension" — directionally useful but
 * not the canonical real-world CLV. Labeled accordingly in the UI.
 */

import { logger } from '../utils/logger.js';
import { getSettledMatches, type SettledMatch } from './srl-history.js';
import { predictFixture } from './srl-predictor.js';
import type { SrlFixture } from './srl-fixtures.js';

export interface CalibrationByLeague {
  realLeague: string;
  n: number;
  bookieImpliedBrier: number | null;
  bookieTrueBrier: number | null;
  modelBrier: number | null;
  modelBeatsBookieTrue: boolean;
  modelBeatsBookieImplied: boolean;
  /** Empirical hit rate for the bookie's pre-game favorite. */
  favoriteHitRate: number | null;
  /** Average bookie margin (1X2) on snapshots in this league. */
  avgMargin1x2: number | null;
  /** Sample-size flag — below 50 we display "thin" warning. */
  isThin: boolean;
}

export interface CalibrationSummary {
  totalSettled: number;
  byLeague: CalibrationByLeague[];
  global: CalibrationByLeague;
  /** Plain-English honesty label for the dashboard banner. */
  verdict: string;
}

// ── Brier helpers ────────────────────────────────────────

function brier3(pH: number, pD: number, pA: number, result: 'H' | 'D' | 'A'): number {
  const oH = result === 'H' ? 1 : 0;
  const oD = result === 'D' ? 1 : 0;
  const oA = result === 'A' ? 1 : 0;
  return (pH - oH) ** 2 + (pD - oD) ** 2 + (pA - oA) ** 2;
}

function normalize3(a: number, b: number, c: number): [number, number, number] {
  const s = a + b + c;
  if (s <= 0) return [1 / 3, 1 / 3, 1 / 3];
  return [a / s, b / s, c / s];
}

// Make a fake SrlFixture out of a settled snapshot so predictFixture can run.
function snapshotToFixture(s: SettledMatch): SrlFixture {
  const oddsH = s.snap.oddsH ?? 0;
  const oddsD = s.snap.oddsD ?? 0;
  const oddsA = s.snap.oddsA ?? 0;
  const oddsOver25 = s.snap.oddsOver25 ?? 0;
  const oddsUnder25 = s.snap.oddsUnder25 ?? 0;

  return {
    eventId: s.eventId,
    sportId: 'sr:sport:1',
    tournamentName: s.league,
    realLeague: s.realLeague,
    homeRaw: s.homeReal,
    awayRaw: s.awayReal,
    homeReal: s.homeReal,
    awayReal: s.awayReal,
    estimateStartTime: s.snap.ts,
    setScore: `${s.settle.homeGoals}:${s.settle.awayGoals}`,
    matchStatus: 'Ended',
    playedSeconds: null,
    isInProgress: false,
    isFinished: true,
    markets: {
      home: oddsH > 0 ? { odds: oddsH, trueProb: s.snap.trueH, impliedProb: 1 / oddsH, active: true, outcomeId: '1' } : null,
      draw: oddsD > 0 ? { odds: oddsD, trueProb: s.snap.trueD, impliedProb: 1 / oddsD, active: true, outcomeId: '2' } : null,
      away: oddsA > 0 ? { odds: oddsA, trueProb: s.snap.trueA, impliedProb: 1 / oddsA, active: true, outcomeId: '3' } : null,
      over25: oddsOver25 > 0 ? { odds: oddsOver25, trueProb: s.snap.trueOver25, impliedProb: 1 / oddsOver25, active: true, outcomeId: '12' } : null,
      under25: oddsUnder25 > 0 ? { odds: oddsUnder25, trueProb: s.snap.trueUnder25, impliedProb: 1 / oddsUnder25, active: true, outcomeId: '13' } : null,
      bttsYes: s.snap.trueBttsYes !== null ? { odds: s.snap.trueBttsYes > 0 ? 1 / s.snap.trueBttsYes : 0, trueProb: s.snap.trueBttsYes, impliedProb: s.snap.trueBttsYes, active: true, outcomeId: 'derived' } : null,
      bttsNo: null,
    },
    engineSum1x2: null,
    marginPct1x2: null,
    marginPctOu25: null,
  };
}

// ── Run calibration ──────────────────────────────────────

export async function computeCalibration(): Promise<CalibrationSummary> {
  const settled = getSettledMatches();
  if (settled.length === 0) {
    const empty: CalibrationByLeague = {
      realLeague: 'all',
      n: 0,
      bookieImpliedBrier: null,
      bookieTrueBrier: null,
      modelBrier: null,
      modelBeatsBookieTrue: false,
      modelBeatsBookieImplied: false,
      favoriteHitRate: null,
      avgMargin1x2: null,
      isThin: true,
    };
    return {
      totalSettled: 0,
      byLeague: [],
      global: empty,
      verdict: 'No settled SRL matches yet — predictor is unmeasured.',
    };
  }

  // Bucket by league.
  const buckets = new Map<string, SettledMatch[]>();
  for (const s of settled) {
    if (!s.realLeague) continue;
    const arr = buckets.get(s.realLeague) || [];
    arr.push(s);
    buckets.set(s.realLeague, arr);
  }

  async function buildLeague(realLeague: string, arr: SettledMatch[]): Promise<CalibrationByLeague> {
    let bookieImpliedSum = 0, bookieImpliedN = 0;
    let bookieTrueSum = 0, bookieTrueN = 0;
    let modelSum = 0, modelN = 0;
    let favoriteHits = 0, favoriteN = 0;
    let marginSum = 0, marginN = 0;

    for (const s of arr) {
      const result = s.settle.result;

      // Bookie implied — needs 3 odds.
      if (s.snap.oddsH && s.snap.oddsD && s.snap.oddsA) {
        const [pH, pD, pA] = normalize3(1 / s.snap.oddsH, 1 / s.snap.oddsD, 1 / s.snap.oddsA);
        bookieImpliedSum += brier3(pH, pD, pA, result);
        bookieImpliedN++;
        // Margin = (sum 1/odds) - 1.
        const m = (1 / s.snap.oddsH) + (1 / s.snap.oddsD) + (1 / s.snap.oddsA) - 1;
        marginSum += m;
        marginN++;
        // Favorite = lowest odds.
        const min = Math.min(s.snap.oddsH, s.snap.oddsD, s.snap.oddsA);
        const favRes: 'H' | 'D' | 'A' = min === s.snap.oddsH ? 'H' : min === s.snap.oddsD ? 'D' : 'A';
        if (favRes === result) favoriteHits++;
        favoriteN++;
      }

      // Bookie true — uses engine probability directly.
      if (s.snap.trueH !== null && s.snap.trueD !== null && s.snap.trueA !== null) {
        const [pH, pD, pA] = normalize3(s.snap.trueH, s.snap.trueD, s.snap.trueA);
        bookieTrueSum += brier3(pH, pD, pA, result);
        bookieTrueN++;
      }

      // Model — recompute.
      try {
        const fakeFixture = snapshotToFixture(s);
        const pred = await predictFixture(fakeFixture);
        const [pH, pD, pA] = normalize3(pred.modelHomePct, pred.modelDrawPct, pred.modelAwayPct);
        modelSum += brier3(pH, pD, pA, result);
        modelN++;
      } catch (err) {
        logger.warn({ err, eventId: s.eventId }, 'SRL eval: model recompute failed');
      }
    }

    const bookieImpliedBrier = bookieImpliedN > 0 ? bookieImpliedSum / bookieImpliedN : null;
    const bookieTrueBrier = bookieTrueN > 0 ? bookieTrueSum / bookieTrueN : null;
    const modelBrier = modelN > 0 ? modelSum / modelN : null;

    return {
      realLeague,
      n: arr.length,
      bookieImpliedBrier,
      bookieTrueBrier,
      modelBrier,
      modelBeatsBookieTrue: modelBrier !== null && bookieTrueBrier !== null && modelBrier < bookieTrueBrier,
      modelBeatsBookieImplied: modelBrier !== null && bookieImpliedBrier !== null && modelBrier < bookieImpliedBrier,
      favoriteHitRate: favoriteN > 0 ? favoriteHits / favoriteN : null,
      avgMargin1x2: marginN > 0 ? (marginSum / marginN) * 100 : null,
      isThin: arr.length < 50,
    };
  }

  const byLeague: CalibrationByLeague[] = [];
  for (const [realLeague, arr] of buckets) {
    byLeague.push(await buildLeague(realLeague, arr));
  }
  byLeague.sort((a, b) => b.n - a.n);

  const global = await buildLeague('all', settled);

  // Verdict — terse, blunt.
  let verdict: string;
  if (global.n < 30) {
    verdict = `Sample too thin (n=${global.n}) — predictor is unmeasured. Don't bet on it yet.`;
  } else if (global.modelBrier === null || global.bookieTrueBrier === null) {
    verdict = `n=${global.n} but missing engine probabilities — partial measurement.`;
  } else if (global.modelBeatsBookieTrue) {
    const lift = ((global.bookieTrueBrier - global.modelBrier) / global.bookieTrueBrier) * 100;
    verdict = `Model beats bookie engine by ${lift.toFixed(1)}% Brier on n=${global.n}. Possible edge — verify with more samples.`;
  } else if (global.modelBeatsBookieImplied) {
    verdict = `Model beats bookie IMPLIED but loses to engine (n=${global.n}). You'd be paying margin — no real edge.`;
  } else {
    verdict = `Model loses to bookie engine on n=${global.n}. Use as reference only — no edge.`;
  }

  return {
    totalSettled: settled.length,
    byLeague,
    global,
    verdict,
  };
}

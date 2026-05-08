/**
 * SRL Predictor
 *
 * Combines two priors into a single per-fixture forecast:
 *   1. Real-world Poisson (stats-predictor) on the real-team mapping. The
 *      engine is trained on real data, so this is the "fundamental" prior.
 *   2. Empirical SRL outcomes (srl-history). After enough samples this
 *      captures the engine's actual behavior — variance, bias, drift.
 *
 * Output is compared against:
 *   - Bookmaker IMPLIED prob (1/odds) — for the user
 *   - Bookmaker TRUE prob (engine `probability` field) — the bookie's
 *     own statement of fair value. Beating the implied while agreeing
 *     with true means you're paying margin and not getting edge.
 *
 * The predictor is honest by design: divergence is reported with
 * sample-size and margin context so the UI can warn when a "value"
 * signal is just noise or vig.
 */

import { logger } from '../utils/logger.js';
import { predictMatch as poissonPredict } from './stats-predictor.js';
import type { SrlFixture, SrlOutcome } from './srl-fixtures.js';
import { computeLeaguePriors, computeTeamForm, type LeaguePrior, type TeamForm } from './srl-history.js';

export interface SrlSignal {
  pick: 'Home' | 'Draw' | 'Away' | 'Over 2.5' | 'Under 2.5' | 'BTTS Yes' | 'BTTS No';
  /** Our model's probability for this outcome. 0-100. */
  modelPct: number;
  /** Bookie's implied (1/odds * 100). 0-100. null when no clean price (BTTS derived). */
  impliedPct: number | null;
  /** Bookie's engine TRUE probability * 100. 0-100. null if engine omitted. */
  bookieTruePct: number | null;
  /** Decimal odds offered. null when derived. */
  odds: number | null;
  /** modelPct - impliedPct. The headline "edge" against the price. */
  edgeVsImpliedPct: number | null;
  /** modelPct - bookieTruePct. The honest divergence vs the engine's truth. */
  edgeVsBookieTruePct: number | null;
}

export interface SrlPrediction {
  eventId: string;
  league: string;
  realLeague: string;
  homeRaw: string;
  awayRaw: string;
  homeReal: string;
  awayReal: string;
  isInProgress: boolean;
  isFinished: boolean;
  matchStatus: string | null;
  setScore: string | null;
  estimateStartTime: number | null;

  // Model output
  modelHomePct: number;
  modelDrawPct: number;
  modelAwayPct: number;
  modelOver25Pct: number;
  modelBttsYesPct: number;

  // Bookie views
  bookieMarginPct1x2: number | null;
  bookieMarginPctOu25: number | null;

  // Per-market signals
  signals: SrlSignal[];

  // Sample-size metadata — how trustworthy is the empirical adjustment.
  leagueSampleN: number;
  homeTeamSampleN: number;
  awayTeamSampleN: number;
  /** Composite sample-size score 0..100. Below ~25 means thin evidence; show n badge. */
  sampleConfidence: number;
  /** True if we couldn't even build a real-world Poisson prior (no league coverage). */
  usedFallback: boolean;
  /** Bookie engine's rolling Brier on this league. Lower is sharper. null until n>10. */
  bookieBrier1x2: number | null;
}

// ── Math helpers ─────────────────────────────────────────

function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let f = 1;
  for (let i = 2; i <= k; i++) f *= i;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / f;
}

function buildGoalDistribution(expHome: number, expAway: number, maxGoals = 8) {
  let home = 0, draw = 0, away = 0, over25 = 0, btts = 0;
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = poissonPmf(h, expHome) * poissonPmf(a, expAway);
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
      if (h + a > 2) over25 += p;
      if (h > 0 && a > 0) btts += p;
    }
  }
  return { home, draw, away, over25, btts };
}

function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }

/** Round to 1 decimal. */
function r1(x: number): number { return Math.round(x * 10) / 10; }

// ── Empirical-shrinkage helpers ──────────────────────────

/**
 * Bayesian shrinkage to a generic football prior. With small n the team
 * indices collapse to 1.0; with large n we trust the empirical signal.
 */
function shrinkIndex(value: number, n: number, k = 12): number {
  if (n <= 0) return 1;
  const w = n / (n + k);
  return w * value + (1 - w) * 1;
}

// Generic football prior (used when real-Poisson coverage is missing).
const GENERIC_AVG_HOME_GOALS = 1.55;
const GENERIC_AVG_AWAY_GOALS = 1.20;

// ── Predict ──────────────────────────────────────────────

const cachedLeaguePriors = { at: 0, map: new Map<string, LeaguePrior>() };
const cachedTeamForm = { at: 0, map: new Map<string, TeamForm>() };
const PRIOR_CACHE_TTL = 60 * 1000;

function getLeaguePrior(realLeague: string): LeaguePrior | null {
  if (Date.now() - cachedLeaguePriors.at > PRIOR_CACHE_TTL) {
    cachedLeaguePriors.map = computeLeaguePriors();
    cachedLeaguePriors.at = Date.now();
  }
  return cachedLeaguePriors.map.get(realLeague) ?? null;
}

function getTeamFormCached(realLeague: string, team: string): TeamForm | null {
  if (Date.now() - cachedTeamForm.at > PRIOR_CACHE_TTL) {
    cachedTeamForm.map = computeTeamForm();
    cachedTeamForm.at = Date.now();
  }
  return cachedTeamForm.map.get(`${realLeague}|${(team || '').toLowerCase()}`) ?? null;
}

function buildSignal(
  pick: SrlSignal['pick'],
  modelProb: number,
  outcome: SrlOutcome | null,
): SrlSignal {
  const modelPct = modelProb * 100;
  const odds = outcome?.odds ?? null;
  const impliedPct = outcome && outcome.impliedProb > 0 && (outcome.outcomeId !== 'derived') ? outcome.impliedProb * 100 : null;
  const bookieTruePct = outcome?.trueProb !== null && outcome?.trueProb !== undefined ? outcome.trueProb * 100 : null;
  return {
    pick,
    modelPct: r1(modelPct),
    impliedPct: impliedPct !== null ? r1(impliedPct) : null,
    bookieTruePct: bookieTruePct !== null ? r1(bookieTruePct) : null,
    odds: odds && odds > 1 ? odds : null,
    edgeVsImpliedPct: impliedPct !== null ? r1(modelPct - impliedPct) : null,
    edgeVsBookieTruePct: bookieTruePct !== null ? r1(modelPct - bookieTruePct) : null,
  };
}

/**
 * Predict a single fixture. Always returns a prediction (falls back to a
 * generic football prior if neither real-world Poisson nor empirical SRL
 * data is available — but flags usedFallback=true).
 */
export async function predictFixture(f: SrlFixture): Promise<SrlPrediction> {
  // Step 1 — real-world Poisson on real-team names.
  let expHome = GENERIC_AVG_HOME_GOALS;
  let expAway = GENERIC_AVG_AWAY_GOALS;
  let usedFallback = true;

  try {
    const real = await poissonPredict(f.homeReal, f.awayReal, f.realLeague);
    if (real) {
      expHome = real.expectedHomeGoals;
      expAway = real.expectedAwayGoals;
      usedFallback = false;
    }
  } catch (err) {
    logger.warn({ err }, 'SRL predictor: real-world Poisson failed');
  }

  // Step 2 — empirical SRL adjustment. Multiply the Poisson lambdas by the
  // shrunken team-form indices, scaled by the empirical league avg-goals
  // ratio (so we capture engine-level scoring drift).
  const leaguePrior = getLeaguePrior(f.realLeague);
  const homeForm = getTeamFormCached(f.realLeague, f.homeReal);
  const awayForm = getTeamFormCached(f.realLeague, f.awayReal);

  if (leaguePrior && leaguePrior.n >= 8) {
    const realLeagueAvg = (GENERIC_AVG_HOME_GOALS + GENERIC_AVG_AWAY_GOALS);
    const srlLeagueAvg = leaguePrior.avgGoals;
    if (realLeagueAvg > 0 && srlLeagueAvg > 0) {
      const scoringScale = srlLeagueAvg / realLeagueAvg;
      // Blend in proportion to leaguePrior.n (capped) — at n>=40 scoring
      // scale is fully trusted.
      const w = Math.min(1, leaguePrior.n / 40);
      const factor = (1 - w) + w * scoringScale;
      expHome *= factor;
      expAway *= factor;
    }
  }

  if (homeForm) {
    const att = shrinkIndex(homeForm.attackIndex, homeForm.played);
    expHome *= att;
  }
  if (awayForm) {
    const def = shrinkIndex(awayForm.defenseIndex, awayForm.played);
    expHome *= def;
  }
  if (awayForm) {
    const att = shrinkIndex(awayForm.attackIndex, awayForm.played);
    expAway *= att;
  }
  if (homeForm) {
    const def = shrinkIndex(homeForm.defenseIndex, homeForm.played);
    expAway *= def;
  }

  expHome = clamp(expHome, 0.15, 5);
  expAway = clamp(expAway, 0.15, 5);

  const dist = buildGoalDistribution(expHome, expAway);

  // Step 3 — light blend with empirical 1X2 league rates if we have a
  // big sample and a fallback Poisson; helps when real-team mapping fails.
  if (usedFallback && leaguePrior && leaguePrior.n >= 30) {
    dist.home = (dist.home + leaguePrior.homeRate) / 2;
    dist.draw = (dist.draw + leaguePrior.drawRate) / 2;
    dist.away = (dist.away + leaguePrior.awayRate) / 2;
    const sum = dist.home + dist.draw + dist.away;
    if (sum > 0) {
      dist.home /= sum;
      dist.draw /= sum;
      dist.away /= sum;
    }
    dist.over25 = (dist.over25 + leaguePrior.over25Rate) / 2;
    dist.btts = (dist.btts + leaguePrior.bttsRate) / 2;
  }

  const signals: SrlSignal[] = [
    buildSignal('Home', dist.home, f.markets.home),
    buildSignal('Draw', dist.draw, f.markets.draw),
    buildSignal('Away', dist.away, f.markets.away),
    buildSignal('Over 2.5', dist.over25, f.markets.over25),
    buildSignal('Under 2.5', 1 - dist.over25, f.markets.under25),
    buildSignal('BTTS Yes', dist.btts, f.markets.bttsYes),
    buildSignal('BTTS No', 1 - dist.btts, f.markets.bttsNo),
  ];

  // Sample-size composite — leagueN dominates, team-form fills the rest.
  const leagueN = leaguePrior?.n ?? 0;
  const teamN = (homeForm?.played ?? 0) + (awayForm?.played ?? 0);
  const sampleConfidence = clamp(
    Math.round(((leagueN / 100) * 70) + ((teamN / 30) * 30)),
    0, 100,
  );

  return {
    eventId: f.eventId,
    league: f.tournamentName,
    realLeague: f.realLeague,
    homeRaw: f.homeRaw,
    awayRaw: f.awayRaw,
    homeReal: f.homeReal,
    awayReal: f.awayReal,
    isInProgress: f.isInProgress,
    isFinished: f.isFinished,
    matchStatus: f.matchStatus,
    setScore: f.setScore,
    estimateStartTime: f.estimateStartTime,
    modelHomePct: r1(dist.home * 100),
    modelDrawPct: r1(dist.draw * 100),
    modelAwayPct: r1(dist.away * 100),
    modelOver25Pct: r1(dist.over25 * 100),
    modelBttsYesPct: r1(dist.btts * 100),
    bookieMarginPct1x2: f.marginPct1x2 !== null ? r1(f.marginPct1x2) : null,
    bookieMarginPctOu25: f.marginPctOu25 !== null ? r1(f.marginPctOu25) : null,
    signals,
    leagueSampleN: leagueN,
    homeTeamSampleN: homeForm?.played ?? 0,
    awayTeamSampleN: awayForm?.played ?? 0,
    sampleConfidence,
    usedFallback,
    bookieBrier1x2: leaguePrior?.bookieBrier1x2 ?? null,
  };
}

export async function predictFixtures(fixtures: SrlFixture[]): Promise<SrlPrediction[]> {
  // Sequential — Poisson predictMatch already handles its own caching.
  const results: SrlPrediction[] = [];
  for (const f of fixtures) {
    results.push(await predictFixture(f));
  }
  return results;
}

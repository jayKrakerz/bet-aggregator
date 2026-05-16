/**
 * Walk-forward λ calibration — port of bot-main FootStats
 * core/lambda_optimizer.py.
 *
 * For each settled prediction we know both the expected goals (the λ we
 * fed Poisson) and the actual goals scored. Over a rolling window:
 *
 *   factor_home = mean(actual_home_goals) / mean(predicted_home_λ)
 *   factor_away = mean(actual_away_goals) / mean(predicted_away_λ)
 *
 * These two scalars correct systematic goal-volume bias in our pipeline
 * (e.g. when our home λ is consistently 10% too low because we're
 * undercounting set-piece goals). Applied multiplicatively to the base
 * lambdas before any contextual modifiers fire.
 *
 * Safety rail: factors clamped to [0.85, 1.15]. Anything outside that
 * range is more likely a sample-size artefact than a real bias.
 *
 * Cached for 5 minutes — calibration is slow-changing and predict-tracker
 * settles asynchronously anyway.
 */

import { logger } from '../utils/logger.js';
import { getSettledHistory, type PredictionLog } from './predict-tracker.js';

const CAL_MIN = 0.85;
const CAL_MAX = 1.15;
const MIN_MATCHES = 30;
const WINDOW = 200;
const CACHE_MS = 5 * 60_000;

export interface CalibrationFactors {
  factorHome: number;
  factorAway: number;
  nMatches: number;
  rawHome: number;
  rawAway: number;
  clampedHome: boolean;
  clampedAway: boolean;
  /** True when sample < MIN_MATCHES — factors fall back to 1.0. */
  underSampled: boolean;
  computedAtIso: string;
}

const NEUTRAL: CalibrationFactors = {
  factorHome: 1,
  factorAway: 1,
  nMatches: 0,
  rawHome: 1,
  rawAway: 1,
  clampedHome: false,
  clampedAway: false,
  underSampled: true,
  computedAtIso: new Date().toISOString(),
};

let cache: CalibrationFactors | null = null;
let cachedAt = 0;

function clamp(x: number): number {
  return Math.max(CAL_MIN, Math.min(CAL_MAX, x));
}

function computeFactors(history: PredictionLog[]): CalibrationFactors {
  if (history.length < MIN_MATCHES) {
    return { ...NEUTRAL, nMatches: history.length, computedAtIso: new Date().toISOString() };
  }

  let sumPredH = 0, sumPredA = 0, sumActH = 0, sumActA = 0;
  let n = 0;
  for (const e of history) {
    if (!e.actualScore) continue;
    if (!Number.isFinite(e.expected.home) || !Number.isFinite(e.expected.away)) continue;
    if (e.expected.home <= 0 || e.expected.away <= 0) continue;
    sumPredH += e.expected.home;
    sumPredA += e.expected.away;
    sumActH += e.actualScore.home;
    sumActA += e.actualScore.away;
    n++;
  }
  if (n < MIN_MATCHES || sumPredH <= 0 || sumPredA <= 0) {
    return { ...NEUTRAL, nMatches: n, computedAtIso: new Date().toISOString() };
  }

  const rawHome = sumActH / sumPredH;
  const rawAway = sumActA / sumPredA;
  const factorHome = clamp(rawHome);
  const factorAway = clamp(rawAway);

  return {
    factorHome: round4(factorHome),
    factorAway: round4(factorAway),
    nMatches: n,
    rawHome: round4(rawHome),
    rawAway: round4(rawAway),
    clampedHome: factorHome !== round4(rawHome),
    clampedAway: factorAway !== round4(rawAway),
    underSampled: false,
    computedAtIso: new Date().toISOString(),
  };
}

function round4(x: number): number { return Math.round(x * 10000) / 10000; }

export async function getLambdaCalibration(): Promise<CalibrationFactors> {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
  try {
    const history = await getSettledHistory(WINDOW);
    cache = computeFactors(history);
    cachedAt = Date.now();
  } catch (err) {
    logger.warn({ err }, 'lambda-calibration: compute failed, returning neutral');
    cache = { ...NEUTRAL, computedAtIso: new Date().toISOString() };
    cachedAt = Date.now();
  }
  return cache;
}

/** Force-refresh — used after a manual settle pass or for tests. */
export function invalidateLambdaCalibrationCache(): void {
  cache = null;
  cachedAt = 0;
}

/**
 * Match Predictor — full-stack two-team forecast.
 *
 * Wraps lookupOU (Poisson + form + H2H + league averages + SRL prior) and
 * adds:
 *   - Top-10 most likely scorelines from the goal matrix.
 *   - Asian handicap probabilities at standard lines.
 *   - HT/FT 3x3 outcome matrix (Poisson per half).
 *   - Clean-sheet % per team.
 *   - Lineup adjustment from injury feeds (FotMob / API-Football).
 *   - Elo + Poisson blended 1X2 with a confidence score.
 *
 * The base lambdas come from lookupOU. Injuries are applied as a small
 * multiplicative penalty per "key" player out: a missing attacker drops
 * that side's lambda, a missing defender bumps the opponent's lambda.
 * Adjustment is capped both ways so it can't dominate the base model.
 */

import { logger } from '../utils/logger.js';
import { lookupOU, type OuLookupResult } from './ou-lookup.js';
import { predictElo, type EloPrediction } from './elo-predictor.js';
import { getInjuryReport, hasInjurySource, type TeamInjuryReport } from './injury-fetcher.js';
import { logPrediction, getCachedConfidenceMult } from './predict-tracker.js';
import { analyzeFatigue, type FatigueReport } from './fatigue.js';
import { analyzeH2HPatterns, type H2HPatterns } from './h2h-patterns.js';
import { getLambdaCalibration, type CalibrationFactors } from './lambda-calibration.js';
import { analyzeImportancePair, type ImportanceReport } from './importance-index.js';
import { analyzeReferee, type RefereeAnalysis } from './referee-bias.js';
import { analyzeKnockout, type KnockoutCorrection } from './knockout-correction.js';

// ── Tunables ────────────────────────────────────────────

const TOP_SCORES_N = 10;
const MAX_GOALS = 8;
const AH_LINES = [-2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5];

// Lineup adjustment caps so injuries can never dominate the base λ.
const PER_KEY_PLAYER_DROP = 0.045;     // each key player out → -4.5% own λ
const PER_KEY_PLAYER_GIFT = 0.020;     // each opp key out (assumed defender) → +2% your λ
const MAX_OWN_DROP = 0.22;
const MAX_OPP_GIFT = 0.10;

// Home Fortress (port of bot-main FootStats v3.3 / fortress.py).
// When the home side is unbeaten at home for ≥ FORTRESS_THRESHOLD games,
// reduce their conceding λ — i.e. multiply the AWAY side's expected goals.
const FORTRESS_THRESHOLD = 5;
const FORTRESS_AWAY_MULT = 0.90;

// Form Momentum (lean Importance Index v2). Without league standings we
// can't do bot-main's late-season position logic, so we approximate
// motivation via consecutive same-result streaks instead.
const MOMENTUM_THRESHOLD = 3;          // 3+ same result triggers
const MOMENTUM_HOT_ATTACK = 1.08;      // 3+ Ws → +8% own λ
const MOMENTUM_COLD_ATTACK = 0.92;     // 3+ Ls → -8% own λ

// Elo blend weights: when CSV-Poisson matched, trust the model more.
const POISSON_WEIGHT_MATCHED = 0.7;
const POISSON_WEIGHT_FALLBACK = 0.5;

// ── Public types ────────────────────────────────────────

export interface Scoreline {
  home: number;
  away: number;
  prob: number;        // 0–100
}

export interface AhLine {
  line: number;
  homePct: number;     // home covers
  awayPct: number;     // away covers
  pushPct: number;     // exact-handicap push (zero unless integer line)
}

export interface HtFtCell {
  ht: 'H' | 'D' | 'A';
  ft: 'H' | 'D' | 'A';
  pct: number;
}

export interface LineupImpact {
  homeOut: number;
  awayOut: number;
  homeLambdaMult: number;   // multiplier applied to home λ (0.78–1.10)
  awayLambdaMult: number;   // multiplier applied to away λ
}

/** Contextual modifiers beyond injuries — fortress + momentum + fatigue + H2H + importance + referee + knockout. */
export interface ContextImpact {
  fortress: { active: boolean; homeUnbeatenStreak: number; awayLambdaMult: number };
  homeMomentum: { streak: number; type: 'hot' | 'cold' | 'neutral'; lambdaMult: number };
  awayMomentum: { streak: number; type: 'hot' | 'cold' | 'neutral'; lambdaMult: number };
  fatigue: FatigueReport;
  h2hPatterns: H2HPatterns;
  importance: ImportanceReport;
  referee: RefereeAnalysis;
  knockout: KnockoutCorrection;
}

export interface BlendedVerdict {
  pick: 'Home' | 'Draw' | 'Away';
  homePct: number;
  drawPct: number;
  awayPct: number;
  /** 0–100. Higher when Poisson and Elo agree on the same outcome. */
  confidence: number;
  /** 0–100, after calibration haircut from recent prediction hit-rate. */
  calibratedConfidence: number;
  /** Multiplier applied to confidence from prediction tracker (0.7–1.2). */
  calibrationMult: number;
  poissonWeight: number;
  eloWeight: number;
}

export interface MatchPrediction {
  // Carry-through from OU lookup so the UI doesn't need two requests.
  base: OuLookupResult;

  /** Walk-forward λ calibration factors applied before context modifiers. */
  calibration: CalibrationFactors;

  // Adjusted lambdas (post-injury).
  adjusted: {
    home: number;
    away: number;
    total: number;
  };

  // Adjusted 1X2 + BTTS (after injury adjustment).
  adjusted1x2: { homePct: number; drawPct: number; awayPct: number };
  adjustedBtts: { yesPct: number; noPct: number };

  // New markets.
  topScores: Scoreline[];
  asianHandicap: AhLine[];
  htft: HtFtCell[];
  cleanSheet: { homePct: number; awayPct: number };

  // Lineup status.
  lineups: {
    available: boolean;
    home: TeamInjuryReport | null;
    away: TeamInjuryReport | null;
    impact: LineupImpact;
  };

  // Contextual modifiers (Fortress + Momentum).
  context: ContextImpact;

  // Elo + blended verdict.
  elo: EloPrediction | null;
  verdict: BlendedVerdict;
}

// ── Poisson math (no deps; runs in <1ms for the whole pipeline) ──

function pmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let f = 1;
  for (let i = 2; i <= k; i++) f *= i;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / f;
}

function buildMatrix(lambdaH: number, lambdaA: number): number[][] {
  const m: number[][] = [];
  for (let h = 0; h <= MAX_GOALS; h++) {
    const row: number[] = [];
    for (let a = 0; a <= MAX_GOALS; a++) {
      row.push(pmf(h, lambdaH) * pmf(a, lambdaA));
    }
    m.push(row);
  }
  return m;
}

function cell(m: number[][], h: number, a: number): number {
  return m[h]?.[a] ?? 0;
}

function topScores(m: number[][], n: number): Scoreline[] {
  const all: Scoreline[] = [];
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      all.push({ home: h, away: a, prob: cell(m, h, a) * 100 });
    }
  }
  all.sort((x, y) => y.prob - x.prob);
  return all.slice(0, n).map(s => ({ home: s.home, away: s.away, prob: r1(s.prob) }));
}

function asianHandicaps(m: number[][]): AhLine[] {
  return AH_LINES.map(line => {
    let home = 0, away = 0, push = 0;
    for (let h = 0; h <= MAX_GOALS; h++) {
      for (let a = 0; a <= MAX_GOALS; a++) {
        const p = cell(m, h, a);
        const diff = h - a + line; // positive → home covers
        if (Math.abs(diff) < 1e-9) push += p;
        else if (diff > 0) home += p;
        else away += p;
      }
    }
    return { line, homePct: r1(home * 100), awayPct: r1(away * 100), pushPct: r1(push * 100) };
  });
}

function htftMatrix(lambdaH: number, lambdaA: number): HtFtCell[] {
  // Assume goals are uniformly split across halves — standard Poisson-per-half.
  const lh1 = lambdaH / 2, la1 = lambdaA / 2;
  const lh2 = lambdaH / 2, la2 = lambdaA / 2;

  const cells: HtFtCell[] = [];
  const outcomes: Array<'H' | 'D' | 'A'> = ['H', 'D', 'A'];
  for (const ht of outcomes) {
    for (const ft of outcomes) cells.push({ ht, ft, pct: 0 });
  }

  // Enumerate (h1, a1, h2, a2) within reasonable bounds — total <16 covers ~99.99%.
  for (let h1 = 0; h1 <= 6; h1++) {
    for (let a1 = 0; a1 <= 6; a1++) {
      const p1 = pmf(h1, lh1) * pmf(a1, la1);
      if (p1 < 1e-7) continue;
      for (let h2 = 0; h2 <= 6; h2++) {
        for (let a2 = 0; a2 <= 6; a2++) {
          const p2 = pmf(h2, lh2) * pmf(a2, la2);
          if (p2 < 1e-7) continue;
          const ht = h1 > a1 ? 'H' : h1 === a1 ? 'D' : 'A';
          const hF = h1 + h2, aF = a1 + a2;
          const ft = hF > aF ? 'H' : hF === aF ? 'D' : 'A';
          const out = cells.find(c => c.ht === ht && c.ft === ft);
          if (out) out.pct += p1 * p2;
        }
      }
    }
  }
  for (const c of cells) c.pct = r1(c.pct * 100);
  return cells;
}

function cleanSheets(m: number[][]): { homePct: number; awayPct: number } {
  // Home clean sheet = away scored 0 → marginalise over all home goal counts.
  let homeCS = 0, awayCS = 0;
  for (let h = 0; h <= MAX_GOALS; h++) homeCS += cell(m, h, 0);
  for (let a = 0; a <= MAX_GOALS; a++) awayCS += cell(m, 0, a);
  return { homePct: r1(homeCS * 100), awayPct: r1(awayCS * 100) };
}

function bttsFromMatrix(m: number[][]): { yesPct: number; noPct: number } {
  let yes = 0;
  for (let h = 1; h <= MAX_GOALS; h++) {
    for (let a = 1; a <= MAX_GOALS; a++) yes += cell(m, h, a);
  }
  return { yesPct: r1(yes * 100), noPct: r1((1 - yes) * 100) };
}

function oneXtwoFromMatrix(m: number[][]): { homePct: number; drawPct: number; awayPct: number } {
  let pH = 0, pD = 0, pA = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = cell(m, h, a);
      if (h > a) pH += p;
      else if (h === a) pD += p;
      else pA += p;
    }
  }
  return { homePct: r1(pH * 100), drawPct: r1(pD * 100), awayPct: r1(pA * 100) };
}

// ── Lineup adjustment ──────────────────────────────────

function applyLineupImpact(
  baseH: number,
  baseA: number,
  homeReport: TeamInjuryReport | null,
  awayReport: TeamInjuryReport | null,
): { adjustedH: number; adjustedA: number; impact: LineupImpact } {
  const homeOut = homeReport?.keyOut ?? 0;
  const awayOut = awayReport?.keyOut ?? 0;

  // Each key player out → reduce that side's λ; also gift the opponent.
  const homeDrop = Math.min(homeOut * PER_KEY_PLAYER_DROP, MAX_OWN_DROP);
  const awayDrop = Math.min(awayOut * PER_KEY_PLAYER_DROP, MAX_OWN_DROP);
  const homeGift = Math.min(awayOut * PER_KEY_PLAYER_GIFT, MAX_OPP_GIFT);
  const awayGift = Math.min(homeOut * PER_KEY_PLAYER_GIFT, MAX_OPP_GIFT);

  const homeLambdaMult = (1 - homeDrop) * (1 + homeGift);
  const awayLambdaMult = (1 - awayDrop) * (1 + awayGift);

  return {
    adjustedH: baseH * homeLambdaMult,
    adjustedA: baseA * awayLambdaMult,
    impact: { homeOut, awayOut, homeLambdaMult: r3(homeLambdaMult), awayLambdaMult: r3(awayLambdaMult) },
  };
}

// ── Blended verdict ───────────────────────────────────

function blend(
  poisson: { homePct: number; drawPct: number; awayPct: number },
  elo: EloPrediction | null,
  matched: boolean,
  calibrationMult: number,
): BlendedVerdict {
  // Discount unconfident Elo (e.g. teams the rating system has seen <N times)
  // so an empty rating doesn't pull the blended verdict toward 33/33/33.
  const useElo = !!(elo && elo.confident);
  const wP = matched ? POISSON_WEIGHT_MATCHED : POISSON_WEIGHT_FALLBACK;
  const wE = useElo ? 1 - wP : 0;
  const effWp = useElo ? wP : 1;

  const eH = useElo && elo ? elo.homeWinPct : 0;
  const eD = useElo && elo ? elo.drawPct : 0;
  const eA = useElo && elo ? elo.awayWinPct : 0;

  const h = poisson.homePct * effWp + eH * wE;
  const d = poisson.drawPct * effWp + eD * wE;
  const a = poisson.awayPct * effWp + eA * wE;

  const norm = h + d + a;
  const homePct = norm > 0 ? (h / norm) * 100 : poisson.homePct;
  const drawPct = norm > 0 ? (d / norm) * 100 : poisson.drawPct;
  const awayPct = norm > 0 ? (a / norm) * 100 : poisson.awayPct;

  const pick: 'Home' | 'Draw' | 'Away' = homePct >= drawPct && homePct >= awayPct
    ? 'Home'
    : awayPct >= drawPct
      ? 'Away'
      : 'Draw';

  // Confidence: agreement between Poisson and Elo on the same pick, plus
  // margin of the winning probability over second place.
  let agreement = 1;
  if (useElo) {
    const poissonPick: 'Home' | 'Draw' | 'Away' = poisson.homePct >= poisson.drawPct && poisson.homePct >= poisson.awayPct
      ? 'Home'
      : poisson.awayPct >= poisson.drawPct
        ? 'Away'
        : 'Draw';
    const eloPick: 'Home' | 'Draw' | 'Away' = eH >= eD && eH >= eA ? 'Home' : eA >= eD ? 'Away' : 'Draw';
    agreement = poissonPick === eloPick ? 1 : 0.55;
  }
  const sorted = [homePct, drawPct, awayPct].sort((x, y) => y - x);
  const margin = ((sorted[0] ?? 0) - (sorted[1] ?? 0)) / 100; // 0–1
  const confidence = Math.min(100, Math.round(agreement * 60 + margin * 80));
  const calibratedConfidence = Math.min(100, Math.max(0, Math.round(confidence * calibrationMult)));

  return {
    pick,
    homePct: r1(homePct),
    drawPct: r1(drawPct),
    awayPct: r1(awayPct),
    confidence,
    calibratedConfidence,
    calibrationMult: r2(calibrationMult),
    poissonWeight: r2(effWp),
    eloWeight: r2(wE),
  };
}

// ── Rounding helpers ──────────────────────────────────

function r1(x: number): number { return Math.round(x * 10) / 10; }
function r2(x: number): number { return Math.round(x * 100) / 100; }
function r3(x: number): number { return Math.round(x * 1000) / 1000; }

// ── Public entry point ────────────────────────────────

export interface PredictMatchFullOptions {
  league?: string;
  referee?: string;
  /** First-leg score from the *current home's* perspective — when set,
   *  triggers the knockout correction. */
  firstLegHome?: number;
  firstLegAway?: number;
  /** Optional decimal odds for the predictor's pick — when set, gets
   *  logged with the prediction so ROI can be computed at settlement. */
  odds?: number;
}

export async function predictMatchFull(
  home: string,
  away: string,
  optsOrLeague?: string | PredictMatchFullOptions,
  refereeArg?: string,
): Promise<MatchPrediction> {
  // Back-compat: previously this fn took (home, away, league?, referee?).
  // Now it takes either a string league OR an options object so we can
  // pass first-leg scores + odds without ballooning the arg list.
  const opts: PredictMatchFullOptions = typeof optsOrLeague === 'string' || optsOrLeague === undefined
    ? { league: optsOrLeague, referee: refereeArg }
    : optsOrLeague;
  const leagueHint = opts.league;
  const referee = opts.referee;
  const firstLegHome = opts.firstLegHome;
  const firstLegAway = opts.firstLegAway;
  const odds = opts.odds;
  // Base lookup + injuries + Elo + fatigue + calibration + importance + referee
  // in parallel — none depend on each other. H2H patterns are computed off
  // base.factors.h2h after the base resolves (no extra network call).
  const [base, homeInj, awayInj, eloRes, fatigue, calibration, importance, refereeAnalysis] = await Promise.all([
    lookupOU(home, away, leagueHint),
    hasInjurySource() ? getInjuryReport(home).catch(err => {
      logger.warn({ err, team: home }, 'home injury fetch failed');
      return null;
    }) : Promise.resolve(null),
    hasInjurySource() ? getInjuryReport(away).catch(err => {
      logger.warn({ err, team: away }, 'away injury fetch failed');
      return null;
    }) : Promise.resolve(null),
    Promise.resolve(safeElo(home, away)),
    analyzeFatigue(home, away).catch(err => {
      logger.warn({ err, home, away }, 'fatigue analysis failed');
      return null;
    }),
    getLambdaCalibration(),
    analyzeImportancePair(home, away).catch(err => {
      logger.warn({ err, home, away }, 'importance analysis failed');
      return null;
    }),
    analyzeReferee(referee).catch(err => {
      logger.warn({ err, referee }, 'referee analysis failed');
      return null;
    }),
  ]);

  const h2hPatterns = analyzeH2HPatterns(base.factors.h2h, base.homeNormalized, base.awayNormalized);
  const knockout = analyzeKnockout(firstLegHome, firstLegAway);
  // Walk-forward λ correction applied before any contextual modifier fires.
  const baseH = base.expected.home * calibration.factorHome;
  const baseA = base.expected.away * calibration.factorAway;

  const { adjustedH: linH, adjustedA: linA, impact } = applyLineupImpact(baseH, baseA, homeInj, awayInj);
  const { adjustedH, adjustedA, context } = applyContextImpact(
    linH, linA, base, fatigue, h2hPatterns, importance, refereeAnalysis, knockout,
  );
  const matrix = buildMatrix(adjustedH, adjustedA);

  const adjusted1x2 = oneXtwoFromMatrix(matrix);
  const adjustedBtts = bttsFromMatrix(matrix);
  const scores = topScores(matrix, TOP_SCORES_N);
  const ah = asianHandicaps(matrix);
  const ht = htftMatrix(adjustedH, adjustedA);
  const cs = cleanSheets(matrix);
  const calibrationMult = await getCachedConfidenceMult();
  const verdict = blend(adjusted1x2, eloRes, base.matched, calibrationMult);

  // Pick probability — needed for Brier + log-loss when the prediction
  // settles. Verdict pct fields are 0–100, normalise to 0..1.
  const pickPct = verdict.pick === 'Home' ? verdict.homePct
    : verdict.pick === 'Away' ? verdict.awayPct
    : verdict.drawPct;
  const pickProb = pickPct / 100;

  // Fire-and-forget: log this prediction so the tracker can later settle and
  // refine the calibration multiplier. Errors swallowed — never block the
  // user-facing response on the tracker.
  void logPrediction({
    home: base.homeNormalized,
    away: base.awayNormalized,
    pick: verdict.pick,
    confidence: verdict.confidence,
    expHome: adjustedH,
    expAway: adjustedA,
    pickProb,
    odds,
  }).catch(err => logger.warn({ err }, 'predict-tracker: logPrediction failed'));

  return {
    base,
    calibration,
    adjusted: {
      home: r2(adjustedH),
      away: r2(adjustedA),
      total: r2(adjustedH + adjustedA),
    },
    adjusted1x2,
    adjustedBtts,
    topScores: scores,
    asianHandicap: ah,
    htft: ht,
    cleanSheet: cs,
    lineups: {
      available: !!(homeInj || awayInj),
      home: homeInj,
      away: awayInj,
      impact,
    },
    context,
    elo: eloRes,
    verdict,
  };
}

// ── Contextual modifiers: Fortress + Form Momentum ────

/** Read homeUnbeatenStreak and momentumStreak from whichever form source
 *  populated the lookup. Returns 0 when no form source surfaced. */
function readContextSignals(base: OuLookupResult): {
  homeUnbeaten: number;
  homeMomentum: number;
  awayMomentum: number;
} {
  const f = base.factors;
  const fsH = f.flashscoreHomeForm;
  const fsA = f.flashscoreAwayForm;
  const espnH = f.espnHomeForm;
  const espnA = f.espnAwayForm;
  return {
    homeUnbeaten: fsH?.homeUnbeatenStreak ?? espnH?.homeUnbeatenStreak ?? 0,
    homeMomentum: fsH?.momentumStreak ?? espnH?.momentumStreak ?? 0,
    awayMomentum: fsA?.momentumStreak ?? espnA?.momentumStreak ?? 0,
  };
}

const NEUTRAL_IMPORTANCE: ImportanceReport = {
  home: { status: 'NORMAL', label: 'Normal', attackMult: 1, reason: 'No importance data', standing: null },
  away: { status: 'NORMAL', label: 'Normal', attackMult: 1, reason: 'No importance data', standing: null },
};

const NEUTRAL_REFEREE: RefereeAnalysis = {
  signal: 'unknown',
  lambdaMult: 1,
  reason: 'No referee analysis',
  stats: null,
};

function applyContextImpact(
  baseH: number,
  baseA: number,
  base: OuLookupResult,
  fatigueRes: FatigueReport | null,
  h2h: H2HPatterns,
  importanceRes: ImportanceReport | null,
  refereeRes: RefereeAnalysis | null,
  knockout: KnockoutCorrection,
): { adjustedH: number; adjustedA: number; context: ContextImpact } {
  const sig = readContextSignals(base);

  // Fortress: ≥5 home-unbeaten games → away λ × 0.90
  const fortressActive = sig.homeUnbeaten >= FORTRESS_THRESHOLD;
  const fortressMult = fortressActive ? FORTRESS_AWAY_MULT : 1;

  // Momentum: ≥3 same-result streak shifts that team's λ
  const momentumMult = (streak: number): { mult: number; type: 'hot' | 'cold' | 'neutral' } => {
    if (streak >= MOMENTUM_THRESHOLD) return { mult: MOMENTUM_HOT_ATTACK, type: 'hot' };
    if (streak <= -MOMENTUM_THRESHOLD) return { mult: MOMENTUM_COLD_ATTACK, type: 'cold' };
    return { mult: 1, type: 'neutral' };
  };
  const homeM = momentumMult(sig.homeMomentum);
  const awayM = momentumMult(sig.awayMomentum);

  // Fatigue: own attack drops with rotation, opponent's λ rises when our
  // defense is tired (divide own λ by opp.defenseMult — same algebra as
  // bot-main's `/heurystyka_a["mnoznik_obr"]`).
  const fatigue: FatigueReport = fatigueRes ?? {
    home: { tired: false, rotation: false, hoursSinceLast: null, gamesInWindow: 0, attackMult: 1, defenseMult: 1, reason: 'No fatigue data' },
    away: { tired: false, rotation: false, hoursSinceLast: null, gamesInWindow: 0, attackMult: 1, defenseMult: 1, reason: 'No fatigue data' },
    noData: true,
  };
  const homeAttackFatigue = fatigue.home.attackMult / fatigue.away.defenseMult;
  const awayAttackFatigue = fatigue.away.attackMult / fatigue.home.defenseMult;

  // H2H Patent shifts the goal expectation slightly in the dominant side's
  // favour. Revenge boosts the losing-side's attack. Both are applied as
  // straight multiplicative factors on the attacking λ.
  const homeH2H = h2h.homeAttackMult * h2h.homeOddsMult;
  const awayH2H = h2h.awayAttackMult * h2h.awayOddsMult;

  // Importance Index: late-season motivation per side. Pure attack
  // multiplier — defense stays untouched (the original FootStats model
  // assumes title/relegation chases are about scoring, not defending).
  const importance = importanceRes ?? NEUTRAL_IMPORTANCE;
  const homeImp = importance.home.attackMult;
  const awayImp = importance.away.attackMult;

  // Referee bias: symmetric on both sides — cards-heavy refs suppress
  // total goals, goals-heavy refs inflate them.
  const referee = refereeRes ?? NEUTRAL_REFEREE;
  const refMult = referee.lambdaMult;

  // Knockout: applied per side as attack × multiplier ÷ opponent defense
  // multiplier, mirroring the bot-main algebra. When not in a knockout
  // tie, all multipliers are 1 so this is a no-op.
  const homeKnockoutAttack = knockout.homeAttackMult / knockout.awayDefenseMult;
  const awayKnockoutAttack = knockout.awayAttackMult / knockout.homeDefenseMult;

  const adjustedH = baseH * homeM.mult * homeAttackFatigue * homeH2H * homeImp * refMult * homeKnockoutAttack;
  const adjustedA = baseA * fortressMult * awayM.mult * awayAttackFatigue * awayH2H * awayImp * refMult * awayKnockoutAttack;

  return {
    adjustedH,
    adjustedA,
    context: {
      fortress: {
        active: fortressActive,
        homeUnbeatenStreak: sig.homeUnbeaten,
        awayLambdaMult: r3(fortressMult),
      },
      homeMomentum: { streak: sig.homeMomentum, type: homeM.type, lambdaMult: r3(homeM.mult) },
      awayMomentum: { streak: sig.awayMomentum, type: awayM.type, lambdaMult: r3(awayM.mult) },
      fatigue,
      h2hPatterns: h2h,
      importance,
      referee,
      knockout,
    },
  };
}

function safeElo(home: string, away: string): EloPrediction | null {
  try {
    return predictElo(home, away);
  } catch {
    return null;
  }
}

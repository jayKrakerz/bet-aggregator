/**
 * Decision Score — port of bot-main FootStats core/decision_score.py.
 *
 * 0–100 composite quality score for a bet candidate. Each criterion adds
 * points; thresholds tag the candidate as "skip" / "draft" / "final".
 *
 *   EV > 0                              +15  (only when odds supplied)
 *   Calibrated confidence ≥ 70%         +20
 *   No fatigue / rotation on either side +15
 *   Home Fortress OR H2H Patent active  +10
 *   Hit-rate ≥ 65% (from predict-tracker) +10
 *   Poisson↔Elo gap < 20 pp              +10
 *   Lineups complete (≤1 key player out) +10
 *
 * Max with odds: 90. Max without odds (EV component skipped): 75.
 *
 * The bot-main version reserves the lineup criterion for the "final"
 * phase only; here we just always include it since we have the lineup
 * fetcher available and there's no reason to hide a signal.
 */

import type { MatchPrediction } from './match-predictor.js';

export const THRESHOLD_DRAFT = 40;
export const THRESHOLD_FINAL = 60;

export interface DecisionScoreInput {
  prediction: MatchPrediction;
  /** Optional bookmaker odds for the prediction's pick — needed for EV. */
  odds?: number;
  /** Optional historical hit-rate from predict-tracker (0–1). */
  hitRate?: number;
  /** Optional Elo verdict probabilities for the picked outcome (0–100),
   *  for the Poisson↔Elo divergence check. Falls back to the value already
   *  baked into prediction.verdict when omitted. */
  eloPickPct?: number;
}

export interface DecisionScoreResult {
  score: number;
  maxScore: number;
  tier: 'skip' | 'draft' | 'final';
  reasons: string[];
  components: {
    ev: { applied: boolean; value: number | null; awarded: number };
    confidence: { value: number; awarded: number };
    fatigueClean: { applied: boolean; awarded: number };
    patentOrFortress: { applied: boolean; awarded: number };
    hitRate: { value: number | null; awarded: number };
    modelAgreement: { divergencePp: number | null; awarded: number };
    lineupsClean: { applied: boolean; awarded: number };
  };
}

function pickPctFromVerdict(p: MatchPrediction): number {
  switch (p.verdict.pick) {
    case 'Home': return p.verdict.homePct;
    case 'Draw': return p.verdict.drawPct;
    case 'Away': return p.verdict.awayPct;
  }
}

function eloPctFor(p: MatchPrediction): number | null {
  if (!p.elo) return null;
  switch (p.verdict.pick) {
    case 'Home': return p.elo.homeWinPct;
    case 'Draw': return p.elo.drawPct;
    case 'Away': return p.elo.awayWinPct;
  }
}

export function scoreCandidate(input: DecisionScoreInput): DecisionScoreResult {
  const { prediction, odds, hitRate, eloPickPct } = input;
  const reasons: string[] = [];

  const pickPct = pickPctFromVerdict(prediction);
  const pickProb = pickPct / 100;
  const conf = prediction.verdict.calibratedConfidence;
  const fatigue = prediction.context.fatigue;
  const h2h = prediction.context.h2hPatterns;
  const fortress = prediction.context.fortress;
  const lineups = prediction.lineups;

  // ── 1. EV > 0 (+15) — only if odds supplied ────────────────────
  let evValue: number | null = null;
  let evAwarded = 0;
  if (typeof odds === 'number' && odds > 1.01 && pickProb > 0 && pickProb < 1) {
    evValue = pickProb * odds - 1;
    if (evValue > 0) {
      evAwarded = 15;
      reasons.push(`EV=${(evValue * 100).toFixed(1)}% > 0 (+15)`);
    } else {
      reasons.push(`EV=${(evValue * 100).toFixed(1)}% ≤ 0 (0)`);
    }
  }

  // ── 2. Calibrated confidence ≥ 70% (+20) ───────────────────────
  let confAwarded = 0;
  if (conf >= 70) {
    confAwarded = 20;
    reasons.push(`Confidence ${conf}% ≥ 70% (+20)`);
  } else {
    reasons.push(`Confidence ${conf}% < 70% (0)`);
  }

  // ── 3. No fatigue / rotation on either side (+15) ──────────────
  const anyTiredOrRotated =
    fatigue.home.tired || fatigue.home.rotation ||
    fatigue.away.tired || fatigue.away.rotation;
  const fatigueAwarded = anyTiredOrRotated ? 0 : 15;
  if (fatigueAwarded > 0) reasons.push('No fatigue/rotation flags (+15)');
  else reasons.push('Fatigue or rotation present (0)');

  // ── 4. Patent OR Fortress (+10) ────────────────────────────────
  const patentSideAligned =
    (prediction.verdict.pick === 'Home' && h2h.homePatent) ||
    (prediction.verdict.pick === 'Away' && h2h.awayPatent);
  const fortressAligned = fortress.active && prediction.verdict.pick === 'Home';
  const patentOrFortress = patentSideAligned || fortressAligned;
  const patentAwarded = patentOrFortress ? 10 : 0;
  if (patentOrFortress) {
    const tag = patentSideAligned ? 'Patent' : 'Home Fortress';
    reasons.push(`${tag} backs the pick (+10)`);
  }

  // ── 5. Historical hit-rate ≥ 65% (+10) ─────────────────────────
  let hitRateAwarded = 0;
  if (typeof hitRate === 'number' && hitRate >= 0.65) {
    hitRateAwarded = 10;
    reasons.push(`Hit-rate ${(hitRate * 100).toFixed(0)}% ≥ 65% (+10)`);
  } else if (typeof hitRate === 'number') {
    reasons.push(`Hit-rate ${(hitRate * 100).toFixed(0)}% < 65% (0)`);
  }

  // ── 6. Poisson↔Elo divergence < 20 pp (+10) ───────────────────
  // Compare the pick's Poisson% against its Elo% (or skip when Elo isn't
  // available — treat as agreement so we don't penalise small leagues).
  const eloPct = eloPickPct ?? eloPctFor(prediction);
  let divergencePp: number | null = null;
  let agreementAwarded = 0;
  if (eloPct === null) {
    agreementAwarded = 10;
    reasons.push('No Elo signal — divergence assumed clean (+10)');
  } else {
    divergencePp = Math.abs(pickPct - eloPct);
    if (divergencePp < 20) {
      agreementAwarded = 10;
      reasons.push(`Poisson↔Elo gap ${divergencePp.toFixed(0)}pp < 20 (+10)`);
    } else {
      reasons.push(`Poisson↔Elo gap ${divergencePp.toFixed(0)}pp ≥ 20 (0)`);
    }
  }

  // ── 7. Lineups clean (≤1 key player out per side) (+10) ────────
  let lineupAwarded = 0;
  let lineupApplied = false;
  if (lineups.available) {
    lineupApplied = true;
    const clean = lineups.impact.homeOut <= 1 && lineups.impact.awayOut <= 1;
    if (clean) {
      lineupAwarded = 10;
      reasons.push('Lineups clean (+10)');
    } else {
      reasons.push(`Lineups: ${lineups.impact.homeOut}H/${lineups.impact.awayOut}A key out (0)`);
    }
  }

  const evApplied = typeof odds === 'number' && odds > 1.01;
  const maxScore = (evApplied ? 15 : 0) + 20 + 15 + 10 + (typeof hitRate === 'number' ? 10 : 0) + 10 + (lineupApplied ? 10 : 0);

  const score = evAwarded + confAwarded + fatigueAwarded + patentAwarded + hitRateAwarded + agreementAwarded + lineupAwarded;
  const tier: 'skip' | 'draft' | 'final' =
    score >= THRESHOLD_FINAL ? 'final' : score >= THRESHOLD_DRAFT ? 'draft' : 'skip';

  return {
    score,
    maxScore,
    tier,
    reasons,
    components: {
      ev: { applied: evApplied, value: evValue, awarded: evAwarded },
      confidence: { value: conf, awarded: confAwarded },
      fatigueClean: { applied: true, awarded: fatigueAwarded },
      patentOrFortress: { applied: true, awarded: patentAwarded },
      hitRate: { value: hitRate ?? null, awarded: hitRateAwarded },
      modelAgreement: { divergencePp, awarded: agreementAwarded },
      lineupsClean: { applied: lineupApplied, awarded: lineupAwarded },
    },
  };
}

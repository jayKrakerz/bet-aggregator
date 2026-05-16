/**
 * Knockout / two-leg correction — port of bot-main FootStats
 * core/classifier.py `_korekta_rewanz_v26`.
 *
 * In knockout cup ties, the *aggregate* lead going into the return leg
 * dictates tactics far more than form. Teams comfortably ahead "park the
 * bus"; teams chasing the tie go va-bank. Apply λ multipliers based on
 * the aggregate margin from the leg already played.
 *
 *   aggDiff = aggHome − aggAway  (current home's lead in the tie)
 *
 *   aggDiff ≥ +2   home parks the bus   (atk ×0.75, def ×1.20)
 *                  away goes va-bank   (atk ×1.30)
 *   aggDiff ≤ −2   home goes va-bank   (atk ×1.30)
 *                  away parks the bus  (atk ×0.75, def ×1.20)
 *   aggDiff == ±1  both must attack    (atk ×1.05 each)
 *   draw 0:0       both must attack    (atk ×1.10 each)
 *
 * Defense bumps on the parking side are applied by *dividing* the
 * opponent's attack — same algebra as the rest of the predictor's
 * defensive modifiers. Pure function, no I/O.
 */

const VABANK_MULT = 1.30;         // attack +30% — chase the tie
const PARKING_MULT = 0.75;        // attack −25% — kill the clock
const PARKING_DEFENSE_MULT = 1.20; // defense +20% — wall up the back
const NARROW_MULT = 1.05;         // ±1 goal: both push for a goal
const STALEMATE_MULT = 1.10;      // 0:0 / equal: both must attack

export type KnockoutScenario =
  | 'NONE'
  | 'HOME_LEAD_COMFORT'
  | 'AWAY_LEAD_COMFORT'
  | 'NARROW_LEAD'
  | 'STALEMATE';

export interface KnockoutCorrection {
  scenario: KnockoutScenario;
  applied: boolean;
  aggHome: number;
  aggAway: number;
  aggDiff: number;
  homeAttackMult: number;
  awayAttackMult: number;
  homeDefenseMult: number;
  awayDefenseMult: number;
  reason: string;
}

const NEUTRAL: KnockoutCorrection = {
  scenario: 'NONE',
  applied: false,
  aggHome: 0,
  aggAway: 0,
  aggDiff: 0,
  homeAttackMult: 1,
  awayAttackMult: 1,
  homeDefenseMult: 1,
  awayDefenseMult: 1,
  reason: 'No first-leg score supplied — knockout correction skipped.',
};

/**
 * Compute the knockout correction for the *current* leg, where the
 * supplied aggregate is the score going into this leg (i.e. the first
 * leg's result projected onto the current home/away pairing).
 *
 * Returns NEUTRAL when either aggregate is null/undefined/NaN.
 */
export function analyzeKnockout(
  aggHome: number | null | undefined,
  aggAway: number | null | undefined,
): KnockoutCorrection {
  if (aggHome == null || aggAway == null) return { ...NEUTRAL };
  if (!Number.isFinite(aggHome) || !Number.isFinite(aggAway)) return { ...NEUTRAL };

  const aggDiff = aggHome - aggAway;

  if (aggDiff >= 2) {
    return {
      scenario: 'HOME_LEAD_COMFORT',
      applied: true,
      aggHome, aggAway, aggDiff,
      homeAttackMult: PARKING_MULT,
      awayAttackMult: VABANK_MULT,
      homeDefenseMult: PARKING_DEFENSE_MULT,
      awayDefenseMult: 1,
      reason: `[KNOCKOUT] Home leads aggregate +${aggDiff} → home parks the bus (atk ×${PARKING_MULT}, def ×${PARKING_DEFENSE_MULT}); away va-banks (atk ×${VABANK_MULT}).`,
    };
  }

  if (aggDiff <= -2) {
    return {
      scenario: 'AWAY_LEAD_COMFORT',
      applied: true,
      aggHome, aggAway, aggDiff,
      homeAttackMult: VABANK_MULT,
      awayAttackMult: PARKING_MULT,
      homeDefenseMult: 1,
      awayDefenseMult: PARKING_DEFENSE_MULT,
      reason: `[KNOCKOUT] Away leads aggregate ${aggDiff} → home va-banks (atk ×${VABANK_MULT}); away parks the bus (atk ×${PARKING_MULT}, def ×${PARKING_DEFENSE_MULT}).`,
    };
  }

  if (aggDiff === 0 && aggHome === 0) {
    return {
      scenario: 'STALEMATE',
      applied: true,
      aggHome, aggAway, aggDiff,
      homeAttackMult: STALEMATE_MULT,
      awayAttackMult: STALEMATE_MULT,
      homeDefenseMult: 1,
      awayDefenseMult: 1,
      reason: `[KNOCKOUT] First leg 0:0 → both sides must attack (atk ×${STALEMATE_MULT} each).`,
    };
  }

  // ±1 or a draw with goals (e.g. 1:1, 2:2) — narrow margin, both push.
  return {
    scenario: 'NARROW_LEAD',
    applied: true,
    aggHome, aggAway, aggDiff,
    homeAttackMult: NARROW_MULT,
    awayAttackMult: NARROW_MULT,
    homeDefenseMult: 1,
    awayDefenseMult: 1,
    reason: `[KNOCKOUT] Aggregate ${aggHome}:${aggAway} (Δ${aggDiff >= 0 ? '+' : ''}${aggDiff}) — tight tie, both attack (atk ×${NARROW_MULT}).`,
  };
}

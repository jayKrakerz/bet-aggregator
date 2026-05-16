/**
 * H2H Patent + Revenge — port of bot-main FootStats core/h2h.py.
 *
 * Two psychological-edge patterns applied on top of the H2H record from
 * stats-predictor's getH2HDetail (recent CSV seasons only, so the
 * original 730-day window is already implicit):
 *
 *   🏅 Patent — one side has won EVERY recent meeting (≥ MIN_MEETINGS,
 *      0 draws). Shifts the odds in their favour by PATENT_BONUS.
 *
 *   ⚔️ Revenge — last meeting was a ≥ REVENGE_MIN_DIFF goal loss for
 *      one side. The losing side gets a REVENGE_BONUS attack multiplier
 *      ("motivation").
 *
 * Confidence meter scales with the number of recent meetings (0 → 20%,
 * 5+ → 100%), copied from the bot-main scale.
 */

import type { H2HDetail } from './stats-predictor.js';

const MIN_MEETINGS = 2;
const PATENT_BONUS = 1.10;       // odds-shift multiplier for the dominant side
const REVENGE_MIN_DIFF = 3;
const REVENGE_BONUS = 1.15;      // attack-λ bonus for the side seeking revenge

const CONFIDENCE_SCALE: Record<number, number> = {
  0: 20, 1: 40, 2: 60, 3: 75, 4: 87,
};
const CONFIDENCE_MAX = 100;

export interface H2HPatterns {
  /** True when home side has won every recent meeting. */
  homePatent: boolean;
  /** True when away side has won every recent meeting. */
  awayPatent: boolean;
  /** True when home side lost the last meeting by ≥ REVENGE_MIN_DIFF. */
  homeRevenge: boolean;
  /** True when away side lost the last meeting by ≥ REVENGE_MIN_DIFF. */
  awayRevenge: boolean;
  /** Attack-λ multipliers. */
  homeAttackMult: number;
  awayAttackMult: number;
  /** Odds-shift multipliers (Patent only — psychological). */
  homeOddsMult: number;
  awayOddsMult: number;
  /** 0–100 — increases with sample size. */
  confidence: number;
  meetings: number;
  reason: string;
}

const NEUTRAL: H2HPatterns = {
  homePatent: false,
  awayPatent: false,
  homeRevenge: false,
  awayRevenge: false,
  homeAttackMult: 1,
  awayAttackMult: 1,
  homeOddsMult: 1,
  awayOddsMult: 1,
  confidence: 20,
  meetings: 0,
  reason: 'No H2H data',
};

function nameMatches(a: string, b: string): boolean {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

export function analyzeH2HPatterns(
  h2h: H2HDetail | null,
  currentHome: string,
  currentAway: string,
): H2HPatterns {
  if (!h2h || h2h.played === 0) return { ...NEUTRAL };

  const meetings = h2h.played;
  const confidence = meetings >= 5 ? CONFIDENCE_MAX : (CONFIDENCE_SCALE[meetings] ?? CONFIDENCE_MAX);

  const out: H2HPatterns = {
    ...NEUTRAL,
    meetings,
    confidence,
    reason: '',
  };

  // ── Patent: all meetings won by one side (no draws) ──────────────
  // H2HDetail.homeWins / awayWins are already keyed to currentHome / currentAway.
  if (meetings >= MIN_MEETINGS && h2h.draws === 0) {
    if (h2h.homeWins === meetings) {
      out.homePatent = true;
      out.homeOddsMult = PATENT_BONUS;
      out.reason += `🏅 Patent: ${currentHome} won all ${meetings} recent H2H (+${Math.round((PATENT_BONUS - 1) * 100)}% odds shift). `;
    } else if (h2h.awayWins === meetings) {
      out.awayPatent = true;
      out.awayOddsMult = PATENT_BONUS;
      out.reason += `🏅 Patent: ${currentAway} won all ${meetings} recent H2H (+${Math.round((PATENT_BONUS - 1) * 100)}% odds shift). `;
    }
  }

  // ── Revenge: last meeting was a blowout for the losing side ──────
  const last = h2h.recent[0];
  if (last) {
    const diff = last.homeGoals - last.awayGoals;
    if (Math.abs(diff) >= REVENGE_MIN_DIFF) {
      // Map current home/away onto the historical meeting's home/away.
      // CSV names are canonical and should align with base.homeNormalized.
      let currentHomePlayedAtHome: boolean | null = null;
      if (nameMatches(last.home, currentHome)) currentHomePlayedAtHome = true;
      else if (nameMatches(last.away, currentHome)) currentHomePlayedAtHome = false;

      if (currentHomePlayedAtHome !== null) {
        const currentHomeWon = currentHomePlayedAtHome ? diff > 0 : diff < 0;
        if (currentHomeWon) {
          // Current away is the one seeking revenge.
          out.awayRevenge = true;
          out.awayAttackMult = REVENGE_BONUS;
          out.reason += `⚔️ Revenge: ${currentAway} lost the last H2H ${Math.abs(diff)}-goal blowout (+${Math.round((REVENGE_BONUS - 1) * 100)}% attack). `;
        } else {
          out.homeRevenge = true;
          out.homeAttackMult = REVENGE_BONUS;
          out.reason += `⚔️ Revenge: ${currentHome} lost the last H2H ${Math.abs(diff)}-goal blowout (+${Math.round((REVENGE_BONUS - 1) * 100)}% attack). `;
        }
      }
    }
  }

  if (!out.reason) out.reason = `H2H ${meetings} meetings, no dominant pattern.`;
  return out;
}

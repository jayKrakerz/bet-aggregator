/**
 * Importance Index — port of bot-main FootStats core/importance.py.
 *
 * Late-season motivation drives attack λ. Two modes:
 *
 *   NORMAL (> 5 weeks left)
 *     • Top 4 + < 10 weeks left      → HIGH_STAKES_TOP    × 1.20
 *     • Bottom 3 + < 10 weeks left   → HIGH_STAKES_BOTTOM × 1.20
 *     • Relegation playoff zone (bottom 4–6) + < 10 weeks → 1.10
 *     • Mid-table comfort + ≥ 10 left → COMFORT           × 0.90
 *     • Otherwise → NORMAL × 1.00
 *
 *   FINAL (≤ 5 weeks left)
 *     • Top 3                        → FINAL_TOP          × 1.20
 *     • Bottom 3                     → FINAL_RELEGATION   × 1.20
 *     • Everyone else ("vacation")   → VACATION           × 0.90
 *
 * Defaults to NORMAL when no standing is available — never penalises
 * teams in leagues ESPN doesn't cover.
 */

import { logger } from '../utils/logger.js';
import { getTeamStanding, type TeamStanding } from './league-standings.js';

const FINAL_PHASE_THRESHOLD = 5;          // ≤ N weeks remaining = final
const BONUS_FINAL = 1.20;
const VACATION_PENALTY = 0.90;
const HIGH_STAKES_BONUS = 1.20;
const PLAYOFF_BONUS = 1.10;
const COMFORT_PENALTY = 0.90;
const HIGH_STAKES_WEEKS = 10;

export type ImportanceStatus =
  | 'NORMAL'
  | 'COMFORT'
  | 'HIGH_STAKES_TOP'
  | 'HIGH_STAKES_BOTTOM'
  | 'HIGH_STAKES_PLAYOFF'
  | 'FINAL_TOP'
  | 'FINAL_RELEGATION'
  | 'VACATION';

export interface Importance {
  status: ImportanceStatus;
  label: string;
  attackMult: number;
  reason: string;
  standing: TeamStanding | null;
}

const DEFAULT_NORMAL: Importance = {
  status: 'NORMAL',
  label: 'Normal',
  attackMult: 1,
  reason: 'No standings data — defaulting to neutral.',
  standing: null,
};

export function computeImportance(standing: TeamStanding | null): Importance {
  if (!standing || standing.totalTeams === 0) return { ...DEFAULT_NORMAL };

  const { rank, totalTeams, matchesRemaining } = standing;
  if (rank <= 0) return { ...DEFAULT_NORMAL, standing };

  const isFinal = matchesRemaining <= FINAL_PHASE_THRESHOLD;

  // ── FINAL phase ────────────────────────────────────────
  if (isFinal) {
    if (rank <= 3) {
      return {
        status: 'FINAL_TOP',
        label: `Final-Top${rank}`,
        attackMult: BONUS_FINAL,
        reason: `${standing.teamName} on rank ${rank}, ${matchesRemaining} weeks left — title/CL chase, attack +20%.`,
        standing,
      };
    }
    if (rank >= totalTeams - 2) {
      return {
        status: 'FINAL_RELEGATION',
        label: 'Final-Relegation',
        attackMult: BONUS_FINAL,
        reason: `${standing.teamName} relegation threat (rank ${rank}/${totalTeams}), ${matchesRemaining} weeks left — desperation, attack +20%.`,
        standing,
      };
    }
    return {
      status: 'VACATION',
      label: 'Vacation-Mid',
      attackMult: VACATION_PENALTY,
      reason: `${standing.teamName} safe (rank ${rank}), ${matchesRemaining} weeks left — vacation effect, attack −10%.`,
      standing,
    };
  }

  // ── NORMAL phase: only fires when run-in is in sight ───
  if (matchesRemaining < HIGH_STAKES_WEEKS) {
    if (rank <= 4) {
      return {
        status: 'HIGH_STAKES_TOP',
        label: `High-Top${rank}`,
        attackMult: HIGH_STAKES_BONUS,
        reason: `${standing.teamName} chasing Top-${rank} (rank ${rank}/${totalTeams}), ~${matchesRemaining} weeks left — attack +20%.`,
        standing,
      };
    }
    if (rank >= totalTeams - 2) {
      return {
        status: 'HIGH_STAKES_BOTTOM',
        label: 'High-Drop',
        attackMult: HIGH_STAKES_BONUS,
        reason: `${standing.teamName} relegation danger (rank ${rank}/${totalTeams}), ${matchesRemaining} weeks left — attack +20%.`,
        standing,
      };
    }
    if (rank >= totalTeams - 5) {
      return {
        status: 'HIGH_STAKES_PLAYOFF',
        label: 'High-Playoff',
        attackMult: PLAYOFF_BONUS,
        reason: `${standing.teamName} playoff zone (rank ${rank}), ~${matchesRemaining} weeks left — attack +10%.`,
        standing,
      };
    }
  }

  // ── Mid-table comfort: lots of weeks left and nothing to play for ──
  const midLow = 5;
  const midHigh = Math.max(6, totalTeams - 6);
  if (rank >= midLow && rank <= midHigh && matchesRemaining >= HIGH_STAKES_WEEKS) {
    return {
      status: 'COMFORT',
      label: 'Neutral-Mid',
      attackMult: COMFORT_PENALTY,
      reason: `${standing.teamName} mid-table (rank ${rank}), ${matchesRemaining} weeks left — motivation −10%.`,
      standing,
    };
  }

  return {
    status: 'NORMAL',
    label: 'Normal',
    attackMult: 1,
    reason: `${standing.teamName} (rank ${rank}/${totalTeams}) — no special factors.`,
    standing,
  };
}

export async function analyzeImportance(team: string): Promise<Importance> {
  try {
    const standing = await getTeamStanding(team);
    return computeImportance(standing);
  } catch (err) {
    logger.warn({ err, team }, 'importance: lookup failed');
    return { ...DEFAULT_NORMAL };
  }
}

export interface ImportanceReport {
  home: Importance;
  away: Importance;
}

export async function analyzeImportancePair(home: string, away: string): Promise<ImportanceReport> {
  const [h, a] = await Promise.all([analyzeImportance(home), analyzeImportance(away)]);
  return { home: h, away: a };
}

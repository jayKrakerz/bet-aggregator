/**
 * Fatigue + Rotation heuristic — port of bot-main FootStats core/fatigue.py.
 *
 *   😫 Fatigue: prev match was < TIRED_HOURS hours ago.
 *      Effect: defense λ × TIRED_DEFENSE_MULT (mathematically inflates the
 *      opponent's expected goals — same way bot-main models it).
 *
 *   🔄 Rotation: ≥ ROTATION_GAMES finished matches in the last
 *      ROTATION_WINDOW_DAYS days hints at a congested midweek-cup schedule
 *      where the manager rotates the XI.
 *      Effect: attack λ × ROTATION_ATTACK_MULT.
 *
 * Differences from the Python original:
 *   - bot-main's rotation check requires a 'competition' column tagging
 *     CL games. Our scrapers don't carry comp tags, so we proxy with a
 *     density check ("2+ games in 7 days" = congested schedule). Same
 *     observable, lighter data requirement.
 *   - The 730-day H2H window isn't relevant here; our recent-match feed
 *     is the rolling-30-day flashscore index + current/prev ESPN season.
 */

import { logger } from '../utils/logger.js';
import { getFlashscoreRecentMatches } from './flashscore-form.js';
import { getEspnRecentMatches } from './espn-form.js';

const TIRED_HOURS = 72;
const TIRED_DEFENSE_MULT = 0.85;     // defense −15%

const ROTATION_WINDOW_DAYS = 7;
const ROTATION_GAMES = 2;            // 2+ finished games in 7 days
const ROTATION_ATTACK_MULT = 0.92;   // attack −8% (lighter than bot-main's
                                     // −20% since we're inferring from density,
                                     // not a confirmed cup match)

export interface SideFatigue {
  tired: boolean;
  rotation: boolean;
  /** Hours since the most recent finished match (null if no data). */
  hoursSinceLast: number | null;
  /** Matches counted within the rotation window. */
  gamesInWindow: number;
  attackMult: number;
  defenseMult: number;
  reason: string;
}

export interface FatigueReport {
  home: SideFatigue;
  away: SideFatigue;
  /** True when neither scraper returned dated matches for either side. */
  noData: boolean;
}

const NEUTRAL: SideFatigue = {
  tired: false,
  rotation: false,
  hoursSinceLast: null,
  gamesInWindow: 0,
  attackMult: 1,
  defenseMult: 1,
  reason: 'No recent-match data',
};

interface DatedMatch {
  date: string;
}

async function gatherRecentMatches(team: string): Promise<DatedMatch[] | null> {
  // Flashscore is in-memory (free) so try first; ESPN may fetch HTTP.
  const fs = getFlashscoreRecentMatches(team, 10);
  if (fs && fs.length > 0) return fs;
  try {
    const espn = await getEspnRecentMatches(team, 10);
    if (espn && espn.length > 0) return espn;
  } catch (err) {
    logger.warn({ err, team }, 'fatigue: ESPN recent-matches fetch failed');
  }
  return null;
}

function analyzeSide(team: string, matches: DatedMatch[] | null, matchDate: Date): SideFatigue {
  if (!matches || matches.length === 0) return { ...NEUTRAL };

  const matchMs = matchDate.getTime();
  const windowMs = ROTATION_WINDOW_DAYS * 86_400_000;

  // Most recent finished match strictly before the upcoming fixture.
  let hoursSinceLast: number | null = null;
  let gamesInWindow = 0;

  for (const m of matches) {
    const t = Date.parse(m.date);
    if (!Number.isFinite(t)) continue;
    if (t >= matchMs) continue; // ignore same-day/future
    const ageMs = matchMs - t;
    if (hoursSinceLast === null || ageMs / 3_600_000 < hoursSinceLast) {
      hoursSinceLast = ageMs / 3_600_000;
    }
    if (ageMs <= windowMs) gamesInWindow++;
  }

  const out: SideFatigue = {
    ...NEUTRAL,
    hoursSinceLast: hoursSinceLast === null ? null : Math.round(hoursSinceLast * 10) / 10,
    gamesInWindow,
    attackMult: 1,
    defenseMult: 1,
    reason: '',
  };

  if (hoursSinceLast !== null && hoursSinceLast < TIRED_HOURS) {
    out.tired = true;
    out.defenseMult = TIRED_DEFENSE_MULT;
    out.reason += `😫 ${team} played ${Math.round(hoursSinceLast)}h ago (def −${Math.round((1 - TIRED_DEFENSE_MULT) * 100)}%). `;
  }

  if (gamesInWindow >= ROTATION_GAMES) {
    out.rotation = true;
    out.attackMult = ROTATION_ATTACK_MULT;
    out.reason += `🔄 ${team} ${gamesInWindow} games in ${ROTATION_WINDOW_DAYS}d → rotation risk (att −${Math.round((1 - ROTATION_ATTACK_MULT) * 100)}%). `;
  }

  if (!out.reason) out.reason = `${team}: fresh, no congestion.`;
  return out;
}

export async function analyzeFatigue(
  homeTeam: string,
  awayTeam: string,
  matchDate: Date = new Date(),
): Promise<FatigueReport> {
  const [homeMatches, awayMatches] = await Promise.all([
    gatherRecentMatches(homeTeam),
    gatherRecentMatches(awayTeam),
  ]);

  const home = analyzeSide(homeTeam, homeMatches, matchDate);
  const away = analyzeSide(awayTeam, awayMatches, matchDate);

  return {
    home,
    away,
    noData: !homeMatches && !awayMatches,
  };
}

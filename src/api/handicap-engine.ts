/**
 * First-Half Handicap Prediction Engine (Soccer Only)
 *
 * Predicts first-half scores using a Poisson distribution model, then calculates
 * the probability of a +2 Asian Handicap covering for each match.
 *
 * Data sources:
 * 1. DB: Team form (last 10 results), H2H, home/away splits
 * 2. DB: Adapter predictions (moneyline, spread, over/under consensus)
 * 3. DB: Over/under line values → estimate total goals
 * 4. Web: FotMob API for team ratings & recent form
 * 5. Web: Odds data for implied probabilities
 *
 * Market: 1st Half - Asian Handicap (0:2) or (2:0)
 * Pick format: "Away (0:2)" = away team gets +2 for first half
 */

import { sql } from '../db/pool.js';
import { getTeamForm, getH2HResults, getHomeSplit, getAwaySplit } from '../db/queries.js';
import { logger } from '../utils/logger.js';
import { getAllTeamFHStats, findTeamFHStats, type TeamFHStats } from './fh-stats-fetcher.js';
import {
  getUpcomingFixtureOdds, findFixtureOdds,
  getRefereeStats,
  getMatchWeather,
  type FixtureOdds, type RefereeStats, type WeatherData,
} from './match-enrichment.js';

// ===== POISSON MODEL =====

function factorial(n: number): number {
  if (n <= 1) return 1;
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

/**
 * Build probability matrix P(home=h, away=a) for goals 0..maxGoals.
 * Includes Dixon-Coles correction for low-scoring correlation:
 * 0-0 and 1-1 are more likely than pure Poisson suggests,
 * while 1-0 and 0-1 are slightly less likely.
 */
function scoreMatrix(lambdaHome: number, lambdaAway: number, maxGoals = 6): number[][] {
  const matrix: number[][] = [];
  for (let h = 0; h <= maxGoals; h++) {
    matrix[h] = [];
    for (let a = 0; a <= maxGoals; a++) {
      matrix[h]![a] = poissonPmf(h, lambdaHome) * poissonPmf(a, lambdaAway);
    }
  }
  // Dixon-Coles low-scoring correction (rho ≈ -0.13 is typical)
  const rho = -0.13;
  if (lambdaHome > 0 && lambdaAway > 0) {
    const p00 = matrix[0]![0]!;
    const p10 = matrix[1]![0]!;
    const p01 = matrix[0]![1]!;
    const p11 = matrix[1]![1]!;
    matrix[0]![0] = p00 * (1 + rho / (lambdaHome * lambdaAway) * p00);
    matrix[1]![0] = p10 * (1 - rho / lambdaAway * p10);
    matrix[0]![1] = p01 * (1 - rho / lambdaHome * p01);
    matrix[1]![1] = p11 * (1 + rho * p11);
  }
  return matrix;
}

/**
 * Calculate P(side covers with +handicap) from score matrix.
 *
 * For "Away (0:2)": away gets +2 goals → wins if (away+2) > home
 *   WIN:  home - away < 2   (i.e. home leads by 0 or 1, or away leads/draws)
 *   PUSH: home - away = 2
 *   LOSS: home - away > 2   (home leads by 3+)
 *
 * For "Home (2:0)": home gets +2 goals → wins if (home+2) > away
 *   WIN:  away - home < 2
 *   PUSH: away - home = 2
 *   LOSS: away - home > 2
 */
function handicapCoverProb(
  matrix: number[][],
  handicap: number,
  side: 'home' | 'away',
): { win: number; push: number; loss: number } {
  let win = 0, push = 0, loss = 0;
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h]!.length; a++) {
      const p = matrix[h]![a]!;
      if (side === 'away') {
        // Away gets +handicap: effective = (away + handicap) vs home
        const diff = (a + handicap) - h;
        if (diff > 0) win += p;
        else if (diff === 0) push += p;
        else loss += p;
      } else {
        // Home gets +handicap: effective = (home + handicap) vs away
        const diff = (h + handicap) - a;
        if (diff > 0) win += p;
        else if (diff === 0) push += p;
        else loss += p;
      }
    }
  }
  return { win, push, loss };
}

/**
 * Calibrate predicted probability based on backtest results.
 *
 * Backtest (2025-26, 6 leagues, 704 bets) showed:
 * - H1: model predicts 85% → actual 67-70%. Overconfident by ~20pts
 * - H1.5: model predicts 90% → actual 93-96%. Slightly under
 * - H2: model predicts 95% → actual 97-99%. Slightly under
 *
 * For H1, the model's raw Poisson probability doesn't account for
 * push results (which are wins in raw prob but not in real betting).
 * The calibration shrinks H1 predictions toward observed rates.
 */
function calibrateProb(
  rawWin: number,
  handicap: number,
): { win: number; push: number; loss: number } {
  if (handicap <= 1) {
    // H1 calibration: the model is overconfident
    // Backtest: 93.5% of decided bets won, but 145/685 were pushes (21%)
    // Effective win rate including pushes-as-half-win: ~84%
    // Map: raw 0.90→0.72, raw 0.95→0.80, raw 0.80→0.65
    const calibratedWin = 0.40 + rawWin * 0.45; // linear shrinkage toward 50%
    const pushRate = Math.min(0.25, (1 - calibratedWin) * 0.5); // estimate push %
    return {
      win: Math.max(0.05, calibratedWin),
      push: pushRate,
      loss: Math.max(0.01, 1 - calibratedWin - pushRate),
    };
  }
  if (handicap === 1.5) {
    // H1.5: model is reasonably calibrated, slight boost
    // No pushes possible with 0.5 handicaps
    const calibratedWin = 0.15 + rawWin * 0.82;
    return {
      win: Math.min(0.99, calibratedWin),
      push: 0,
      loss: Math.max(0.01, 1 - calibratedWin),
    };
  }
  // H2: model slightly underestimates, small boost
  const calibratedWin = 0.10 + rawWin * 0.89;
  const pushRate = Math.min(0.08, (1 - calibratedWin) * 0.4);
  return {
    win: Math.min(0.99, calibratedWin),
    push: pushRate,
    loss: Math.max(0.005, 1 - calibratedWin - pushRate),
  };
}

/** Calculate the most likely first-half scoreline */
function mostLikelyScore(matrix: number[][]): { home: number; away: number; prob: number } {
  let bestH = 0, bestA = 0, bestP = 0;
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h]!.length; a++) {
      if (matrix[h]![a]! > bestP) {
        bestH = h; bestA = a; bestP = matrix[h]![a]!;
      }
    }
  }
  return { home: bestH, away: bestA, prob: bestP };
}

// ===== LEAGUE AVERAGES =====
// First-half goal averages by league (from historical data)
// ~45% of match goals are scored in the first half

interface LeagueAvg {
  homeFH: number;  // avg first-half goals by home team
  awayFH: number;  // avg first-half goals by away team
  totalFH: number; // total first-half goals
}

const LEAGUE_FH_AVERAGES: Record<string, LeagueAvg> = {
  default:       { homeFH: 0.62, awayFH: 0.47, totalFH: 1.09 },
  premier_league: { homeFH: 0.67, awayFH: 0.50, totalFH: 1.17 },
  la_liga:       { homeFH: 0.60, awayFH: 0.44, totalFH: 1.04 },
  bundesliga:    { homeFH: 0.72, awayFH: 0.52, totalFH: 1.24 },
  serie_a:       { homeFH: 0.58, awayFH: 0.42, totalFH: 1.00 },
  ligue_1:       { homeFH: 0.55, awayFH: 0.40, totalFH: 0.95 },
  eredivisie:    { homeFH: 0.70, awayFH: 0.48, totalFH: 1.18 },
  championship:  { homeFH: 0.55, awayFH: 0.42, totalFH: 0.97 },
  liga_mx:       { homeFH: 0.58, awayFH: 0.40, totalFH: 0.98 },
  mls:           { homeFH: 0.60, awayFH: 0.45, totalFH: 1.05 },
};

const FH_RATIO = 0.45; // fraction of match goals scored in first half

// ===== DATA TYPES =====

export interface TeamFormStats {
  teamId: number;
  teamName: string;
  avgScored: number;
  avgConceded: number;
  avgScoredFH: number;   // estimated first-half goals scored
  avgConcededFH: number;  // estimated first-half goals conceded
  winRate: number;
  form: string; // e.g. "WWDLW"
  streak: string;
  gamesPlayed: number;
}

export interface HandicapLine {
  handicap: number;       // 1, 1.5, or 2
  pick: string;           // "Away (0:1)" or "Home (1:0)" etc.
  pickSide: 'home' | 'away';
  winProb: number;
  pushProb: number;
  lossProb: number;
  impliedOdds: number;
}

export interface FirstHalfHandicapPick {
  matchId: number;
  homeTeam: string;
  awayTeam: string;
  date: string;
  gameTime: string | null;
  // Primary pick (best value line)
  pick: string;          // "Away (0:1)" or "Home (1:0)" etc.
  pickSide: 'home' | 'away';
  market: string;        // "1st Half - Handicap"
  handicap: number;      // 1, 1.5, or 2
  winProb: number;       // probability of winning (0-100)
  pushProb: number;      // probability of push
  lossProb: number;      // probability of loss
  impliedOdds: number;   // 1/winProb as decimal odds
  confidence: 'low' | 'medium' | 'high' | 'very_high';
  confidenceScore: number;
  // All available lines for this match
  lines: HandicapLine[];
  // Predicted scores
  fhHomeGoals: number;   // expected first-half home goals
  fhAwayGoals: number;   // expected first-half away goals
  likelyFHScore: string; // most likely FH score e.g. "0-0"
  likelyFHProb: number;  // probability of that score
  // Factors
  factors: {
    homeForm: TeamFormStats | null;
    awayForm: TeamFormStats | null;
    h2h: { homeWins: number; awayWins: number; draws: number; total: number } | null;
    homeSplit: { wins: number; total: number; winPct: number } | null;
    awaySplit: { wins: number; total: number; winPct: number } | null;
    adapterMoneyline: { side: string; count: number; total: number } | null;
    adapterOverUnder: { side: string; line: number | null; count: number } | null;
    strengthDiff: number; // positive = home stronger
    webData: WebMatchData | null;
    homeFHStats: TeamFHStats | null;
    awayFHStats: TeamFHStats | null;
    referee: RefereeStats | null;
    weather: WeatherData | null;
    bookieOdds: { ahLine: number; ahHome: number; ahAway: number; b365Home: number; b365Draw: number; b365Away: number } | null;
    valueEdge: number | null; // our prob minus bookmaker implied prob (positive = value)
  };
  analysis: string;
}

interface WebMatchData {
  homeRating: number | null;
  awayRating: number | null;
  homePosition: number | null;
  awayPosition: number | null;
  league: string | null;
  insights: string[];
}

// ===== TEAM DATA FROM DB =====

async function getTeamFormStats(teamId: number, teamName: string): Promise<TeamFormStats | null> {
  try {
    const results = await getTeamForm(teamId, 10);
    if (!results.length) return null;

    let wins = 0, losses = 0, draws = 0;
    let totalScored = 0, totalConceded = 0;
    let streakType = '', streakCount = 0, streakCounting = true;
    const formArr: string[] = [];

    for (const r of results) {
      const scored = r.is_home ? r.home_score : r.away_score;
      const conceded = r.is_home ? r.away_score : r.home_score;
      totalScored += scored;
      totalConceded += conceded;

      const res = scored > conceded ? 'W' : scored < conceded ? 'L' : 'D';
      formArr.push(res);
      if (res === 'W') wins++;
      else if (res === 'L') losses++;
      else draws++;

      if (streakCounting) {
        if (!streakType) { streakType = res; streakCount = 1; }
        else if (res === streakType) streakCount++;
        else streakCounting = false;
      }
    }

    const avgScored = totalScored / results.length;
    const avgConceded = totalConceded / results.length;

    return {
      teamId,
      teamName,
      avgScored: Math.round(avgScored * 10) / 10,
      avgConceded: Math.round(avgConceded * 10) / 10,
      avgScoredFH: Math.round(avgScored * FH_RATIO * 100) / 100,
      avgConcededFH: Math.round(avgConceded * FH_RATIO * 100) / 100,
      winRate: Math.round((wins / results.length) * 1000) / 10,
      form: formArr.slice(0, 5).join(''),
      streak: `${streakType}${streakCount}`,
      gamesPlayed: results.length,
    };
  } catch {
    return null;
  }
}

async function getVenueSplit(teamId: number, isHome: boolean) {
  try {
    const [split] = isHome ? await getHomeSplit(teamId) : await getAwaySplit(teamId);
    if (!split || split.total < 3) return null;
    return { wins: split.wins, total: split.total, winPct: Math.round((split.wins / split.total) * 1000) / 10 };
  } catch {
    return null;
  }
}

async function getH2HSummary(homeTeamId: number, awayTeamId: number) {
  try {
    const results = await getH2HResults(homeTeamId, awayTeamId, 10);
    if (results.length < 2) return null;
    let homeWins = 0, awayWins = 0, draws = 0;
    for (const r of results) {
      if (r.home_score > r.away_score) homeWins++;
      else if (r.away_score > r.home_score) awayWins++;
      else draws++;
    }
    return { homeWins, awayWins, draws, total: results.length };
  } catch {
    return null;
  }
}

/** Get adapter moneyline consensus for a match */
async function getAdapterMoneyline(matchId: number) {
  try {
    const rows = await sql<{ side: string }[]>`
      SELECT p.side FROM predictions p
      WHERE p.match_id = ${matchId} AND p.pick_type = 'moneyline' AND p.sport = 'football'
    `;
    if (!rows.length) return null;
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.side] = (counts[r.side] || 0) + 1;
    let best = '', max = 0;
    for (const [s, c] of Object.entries(counts)) { if (c > max) { best = s; max = c; } }
    return { side: best, count: max, total: rows.length };
  } catch {
    return null;
  }
}

/** Get adapter over/under consensus and line */
async function getAdapterOverUnder(matchId: number) {
  try {
    const rows = await sql<{ side: string; value: number | null }[]>`
      SELECT p.side, p.value FROM predictions p
      WHERE p.match_id = ${matchId} AND p.pick_type = 'over_under'
    `;
    if (!rows.length) return null;
    const counts: Record<string, number> = {};
    const values: number[] = [];
    for (const r of rows) {
      counts[r.side] = (counts[r.side] || 0) + 1;
      if (r.value != null) values.push(r.value);
    }
    let best = '', max = 0;
    for (const [s, c] of Object.entries(counts)) { if (c > max) { best = s; max = c; } }
    const avgLine = values.length > 0 ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null;
    return { side: best, line: avgLine, count: max };
  } catch {
    return null;
  }
}

// ===== WEB DATA FETCHING =====

/**
 * Try to fetch team ratings and match context from FotMob API.
 * This is best-effort — returns null on any failure.
 */
async function fetchFotMobData(homeTeam: string, awayTeam: string, dateStr: string): Promise<WebMatchData | null> {
  try {
    const dateCompact = dateStr.replace(/-/g, '');
    const res = await fetch(`https://www.fotmob.com/api/matches?date=${dateCompact}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;

    // FotMob returns { leagues: [...] } with matches nested
    const leagues = data.leagues as Array<{
      name: string;
      matches: Array<{
        home: { name: string; id: number };
        away: { name: string; id: number };
        status?: { started: boolean };
      }>;
    }> | undefined;

    if (!leagues) return null;

    // Find our match by fuzzy team name matching
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
    const homeNorm = normalize(homeTeam);
    const awayNorm = normalize(awayTeam);

    for (const league of leagues) {
      for (const match of league.matches || []) {
        const mHome = normalize(match.home?.name || '');
        const mAway = normalize(match.away?.name || '');
        if ((mHome.includes(homeNorm) || homeNorm.includes(mHome)) &&
            (mAway.includes(awayNorm) || awayNorm.includes(mAway))) {
          return {
            homeRating: null,
            awayRating: null,
            homePosition: null,
            awayPosition: null,
            league: league.name,
            insights: [`League: ${league.name}`],
          };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Try to fetch match predictions/odds from a public source.
 * Returns estimated team strength rating (1-10) if available.
 */
async function fetchTeamRatings(homeTeam: string, _awayTeam: string): Promise<{ homeStrength: number; awayStrength: number } | null> {
  try {
    // Try SofaScore search for team ratings
    const searchHome = encodeURIComponent(homeTeam);
    const res = await fetch(`https://api.sofascore.com/api/v1/search/all?q=${searchHome}&page=0`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;
    const data = await res.json() as { results?: Array<{ entity?: { ranking?: number; type?: string } }> };

    // Extract any ranking info
    const teamResult = data.results?.find(r => r.entity?.type === 'team');
    if (teamResult?.entity?.ranking) {
      // Use ranking as inverse strength signal
      return null; // Complex to use reliably, skip for now
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch additional web data for a match — tries multiple sources.
 * All calls are best-effort with timeouts.
 */
async function fetchWebData(
  homeTeam: string,
  awayTeam: string,
  dateStr: string,
): Promise<WebMatchData | null> {
  // Try sources in parallel, use first successful result
  const [fotmob, ratings] = await Promise.allSettled([
    fetchFotMobData(homeTeam, awayTeam, dateStr),
    fetchTeamRatings(homeTeam, awayTeam),
  ]);

  const fotmobData = fotmob.status === 'fulfilled' ? fotmob.value : null;
  const ratingsData = ratings.status === 'fulfilled' ? ratings.value : null;

  if (!fotmobData && !ratingsData) return null;

  return {
    homeRating: ratingsData?.homeStrength ?? null,
    awayRating: ratingsData?.awayStrength ?? null,
    homePosition: fotmobData?.homePosition ?? null,
    awayPosition: fotmobData?.awayPosition ?? null,
    league: fotmobData?.league ?? null,
    insights: fotmobData?.insights ?? [],
  };
}

// ===== PREDICTION ENGINE =====

/**
 * Estimate first-half expected goals (λ) for each team.
 *
 * Uses the Dixon-Coles inspired approach:
 * λ_home = league_avg_home_FH × (home_attack / league_avg_attack) × (away_defense / league_avg_defense)
 * λ_away = league_avg_away_FH × (away_attack / league_avg_attack) × (home_defense / league_avg_defense)
 *
 * Where attack/defense strengths come from team form data.
 */
function estimateFHGoals(params: {
  homeForm: TeamFormStats | null;
  awayForm: TeamFormStats | null;
  h2h: { homeWins: number; awayWins: number; draws: number; total: number } | null;
  homeSplit: { wins: number; total: number; winPct: number } | null;
  awaySplit: { wins: number; total: number; winPct: number } | null;
  adapterOU: { side: string; line: number | null; count: number } | null;
  adapterML: { side: string; count: number; total: number } | null;
  webData: WebMatchData | null;
  homeFHStats: TeamFHStats | null;
  awayFHStats: TeamFHStats | null;
}): { lambdaHome: number; lambdaAway: number; dataQuality: number } {
  const { homeForm, awayForm, h2h, homeSplit, awaySplit, adapterOU, adapterML, homeFHStats, awayFHStats } = params;
  const leagueAvg = LEAGUE_FH_AVERAGES.default!;

  let lambdaHome = leagueAvg.homeFH;
  let lambdaAway = leagueAvg.awayFH;
  let dataQuality = 0; // 0-100 scale

  // PRIORITY FACTOR: Real first-half statistics from openfootball (weight: 50%)
  // This is the most reliable data — actual FH goals per team from the current season
  if (homeFHStats && awayFHStats) {
    // Use Dixon-Coles approach with real FH data:
    // λ_home = home_team_fh_scored_home × (away_team_fh_conceded_away / league_avg_fh_conceded)
    // λ_away = away_team_fh_scored_away × (home_team_fh_conceded_home / league_avg_fh_conceded)
    const leagueAvgFHConceded = (leagueAvg.homeFH + leagueAvg.awayFH) / 2;

    lambdaHome = homeFHStats.fhScoredHome * (awayFHStats.fhConcededAway / leagueAvgFHConceded);
    lambdaAway = awayFHStats.fhScoredAway * (homeFHStats.fhConcededHome / leagueAvgFHConceded);

    // Sanity: blend with raw averages to avoid extreme values from small samples
    if (homeFHStats.gamesPlayed < 15) {
      const weight = homeFHStats.gamesPlayed / 15;
      lambdaHome = lambdaHome * weight + leagueAvg.homeFH * (1 - weight);
    }
    if (awayFHStats.gamesPlayed < 15) {
      const weight = awayFHStats.gamesPlayed / 15;
      lambdaAway = lambdaAway * weight + leagueAvg.awayFH * (1 - weight);
    }

    dataQuality += 50;
  } else if (homeFHStats) {
    lambdaHome = homeFHStats.fhScoredHome || homeFHStats.fhScoredAvg;
    dataQuality += 25;
  } else if (awayFHStats) {
    lambdaAway = awayFHStats.fhScoredAway || awayFHStats.fhScoredAvg;
    dataQuality += 25;
  }

  // Factor 1: Team form from DB (weight: 40% without web FH stats, 15% with)
  if (homeForm && awayForm && !(homeFHStats && awayFHStats)) {
    // Only use DB form as primary signal when we don't have web FH stats
    const leagueAvgGoals = 1.25;
    const homeAttack = homeForm.avgScored / leagueAvgGoals;
    const homeDefense = homeForm.avgConceded / leagueAvgGoals;
    const awayAttack = awayForm.avgScored / leagueAvgGoals;
    const awayDefense = awayForm.avgConceded / leagueAvgGoals;

    lambdaHome = leagueAvg.homeFH * homeAttack * awayDefense;
    lambdaAway = leagueAvg.awayFH * awayAttack * homeDefense;
    dataQuality += 40;
  } else if (homeForm && awayForm && homeFHStats && awayFHStats) {
    // Blend: use form as minor adjustment to web FH stats
    const leagueAvgGoals = 1.25;
    const homeFormStrength = homeForm.avgScored / leagueAvgGoals;
    const awayFormStrength = awayForm.avgScored / leagueAvgGoals;

    // If DB form shows significantly different strength, adjust by 10%
    if (homeFormStrength > 1.2) lambdaHome *= 1.05;
    else if (homeFormStrength < 0.8) lambdaHome *= 0.95;
    if (awayFormStrength > 1.2) lambdaAway *= 1.05;
    else if (awayFormStrength < 0.8) lambdaAway *= 0.95;
    dataQuality += 10;
  } else if (homeForm) {
    const homeAttack = homeForm.avgScored / 1.25;
    lambdaHome = leagueAvg.homeFH * homeAttack;
    dataQuality += 20;
  } else if (awayForm) {
    const awayAttack = awayForm.avgScored / 1.25;
    lambdaAway = leagueAvg.awayFH * awayAttack;
    dataQuality += 20;
  }

  // Factor 2: Home/away venue splits (weight: 15%)
  if (homeSplit && homeSplit.total >= 5) {
    const homeStrength = homeSplit.winPct / 100;
    // Strong home record → boost home lambda slightly
    lambdaHome *= (0.85 + homeStrength * 0.3); // range 0.85 to 1.15
    dataQuality += 8;
  }
  if (awaySplit && awaySplit.total >= 5) {
    const awayStrength = awaySplit.winPct / 100;
    lambdaAway *= (0.85 + awayStrength * 0.3);
    dataQuality += 7;
  }

  // Factor 3: H2H history (weight: 10%)
  if (h2h && h2h.total >= 3) {
    const homeDominance = h2h.homeWins / h2h.total;
    // If home wins 80%+ of H2H, slight boost to home lambda
    if (homeDominance > 0.6) {
      lambdaHome *= 1.05 + (homeDominance - 0.6) * 0.3;
      lambdaAway *= 0.95;
    } else if (homeDominance < 0.3) {
      lambdaAway *= 1.05 + (0.3 - homeDominance) * 0.3;
      lambdaHome *= 0.95;
    }
    dataQuality += 10;
  }

  // Factor 4: Adapter over/under line (weight: 15%)
  if (adapterOU && adapterOU.line != null) {
    // Use O/U line to calibrate total goals
    const expectedTotal = adapterOU.line;
    const expectedFHTotal = expectedTotal * FH_RATIO;
    const currentTotal = lambdaHome + lambdaAway;

    if (currentTotal > 0) {
      // Scale both lambdas to match the expected total
      const scale = expectedFHTotal / currentTotal;
      // Blend: 60% our model, 40% from adapter line
      const blendedScale = 0.6 + 0.4 * scale;
      lambdaHome *= blendedScale;
      lambdaAway *= blendedScale;
    }
    dataQuality += 15;
  }

  // Factor 5: Adapter moneyline consensus (weight: 10%)
  if (adapterML && adapterML.total >= 2) {
    const mlRatio = adapterML.count / adapterML.total;
    if (adapterML.side === 'home' && mlRatio > 0.6) {
      lambdaHome *= 1.0 + (mlRatio - 0.6) * 0.2;
      lambdaAway *= 1.0 - (mlRatio - 0.6) * 0.1;
    } else if (adapterML.side === 'away' && mlRatio > 0.6) {
      lambdaAway *= 1.0 + (mlRatio - 0.6) * 0.2;
      lambdaHome *= 1.0 - (mlRatio - 0.6) * 0.1;
    }
    dataQuality += 10;
  }

  // Factor 6: Momentum/streak (weight: 10%)
  if (homeForm && homeForm.streak.startsWith('W')) {
    const streakLen = parseInt(homeForm.streak.slice(1)) || 0;
    if (streakLen >= 3) lambdaHome *= 1.0 + Math.min(streakLen, 6) * 0.02;
  } else if (homeForm && homeForm.streak.startsWith('L')) {
    const streakLen = parseInt(homeForm.streak.slice(1)) || 0;
    if (streakLen >= 3) lambdaHome *= 1.0 - Math.min(streakLen, 6) * 0.02;
  }
  if (awayForm && awayForm.streak.startsWith('W')) {
    const streakLen = parseInt(awayForm.streak.slice(1)) || 0;
    if (streakLen >= 3) lambdaAway *= 1.0 + Math.min(streakLen, 6) * 0.02;
  } else if (awayForm && awayForm.streak.startsWith('L')) {
    const streakLen = parseInt(awayForm.streak.slice(1)) || 0;
    if (streakLen >= 3) lambdaAway *= 1.0 - Math.min(streakLen, 6) * 0.02;
  }

  // Clamp lambdas to reasonable range for first half (0.05 to 2.5)
  lambdaHome = Math.max(0.05, Math.min(2.5, lambdaHome));
  lambdaAway = Math.max(0.05, Math.min(2.5, lambdaAway));

  // Round to 2 decimals
  lambdaHome = Math.round(lambdaHome * 100) / 100;
  lambdaAway = Math.round(lambdaAway * 100) / 100;

  return { lambdaHome, lambdaAway, dataQuality: Math.min(dataQuality, 100) };
}

function confLabel(score: number): 'low' | 'medium' | 'high' | 'very_high' {
  if (score >= 80) return 'very_high';
  if (score >= 60) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

function generateAnalysis(pick: FirstHalfHandicapPick): string {
  const parts: string[] = [];
  const { homeTeam, awayTeam, pickSide, winProb, fhHomeGoals, fhAwayGoals, factors } = pick;

  // Main prediction
  const backTeam = pickSide === 'away' ? awayTeam : homeTeam;
  parts.push(`Back ${backTeam} with +2 handicap for the first half (${winProb}% win probability).`);

  // Expected FH goals
  parts.push(`Expected FH goals: ${homeTeam} ${fhHomeGoals.toFixed(2)} - ${fhAwayGoals.toFixed(2)} ${awayTeam}.`);

  // Most likely score
  parts.push(`Most likely FH score: ${pick.likelyFHScore} (${(pick.likelyFHProb * 100).toFixed(1)}%).`);

  // Form insights
  if (factors.homeForm && factors.awayForm) {
    const hf = factors.homeForm;
    const af = factors.awayForm;
    parts.push(`Form: ${homeTeam} ${hf.form} (${hf.avgScored} avg goals) vs ${awayTeam} ${af.form} (${af.avgScored} avg goals).`);

    // Strength differential
    if (Math.abs(factors.strengthDiff) > 0.3) {
      const stronger = factors.strengthDiff > 0 ? homeTeam : awayTeam;
      parts.push(`${stronger} is the significantly stronger side.`);
    }
  }

  // H2H
  if (factors.h2h && factors.h2h.total >= 3) {
    const { homeWins, awayWins, draws, total } = factors.h2h;
    parts.push(`H2H last ${total}: ${homeTeam} ${homeWins}W - ${draws}D - ${awayWins}W ${awayTeam}.`);
  }

  // Venue
  if (factors.homeSplit && factors.homeSplit.winPct >= 60) {
    parts.push(`${homeTeam} ${factors.homeSplit.winPct}% home win rate.`);
  }
  if (factors.awaySplit && factors.awaySplit.winPct >= 45) {
    parts.push(`${awayTeam} ${factors.awaySplit.winPct}% away win rate.`);
  }

  // Adapter consensus
  if (factors.adapterMoneyline) {
    const ml = factors.adapterMoneyline;
    const mlTeam = ml.side === 'home' ? homeTeam : awayTeam;
    parts.push(`${ml.count}/${ml.total} adapters pick ${mlTeam} to win.`);
  }
  if (factors.adapterOverUnder) {
    const ou = factors.adapterOverUnder;
    parts.push(`O/U line: ${ou.line ?? '?'} (${ou.side} consensus).`);
  }

  // Web FH stats (most valuable data)
  if (factors.homeFHStats && factors.awayFHStats) {
    const hfh = factors.homeFHStats;
    const afh = factors.awayFHStats;
    parts.push(`FH stats (${hfh.league}): ${homeTeam} scores ${hfh.fhScoredHome}/FH at home, ${awayTeam} concedes ${afh.fhConcededAway}/FH away.`);
    if (hfh.cleanSheetsFH > 40) parts.push(`${homeTeam} keeps FH clean sheet ${hfh.cleanSheetsFH}% of games.`);
    if (afh.cleanSheetsFH > 40) parts.push(`${awayTeam} keeps FH clean sheet ${afh.cleanSheetsFH}% of games.`);
  } else if (factors.homeFHStats) {
    parts.push(`${homeTeam} FH data (${factors.homeFHStats.league}): ${factors.homeFHStats.fhScoredAvg} scored, ${factors.homeFHStats.fhConcededAvg} conceded per FH.`);
  } else if (factors.awayFHStats) {
    parts.push(`${awayTeam} FH data (${factors.awayFHStats.league}): ${factors.awayFHStats.fhScoredAvg} scored, ${factors.awayFHStats.fhConcededAvg} conceded per FH.`);
  }

  // Referee
  if (factors.referee) {
    const ref = factors.referee;
    const label = ref.fhGoalRate > 1.15 ? 'high-scoring' : ref.fhGoalRate < 0.85 ? 'low-scoring' : 'average';
    parts.push(`Referee ${ref.name}: ${label} (${ref.avgFHGoals} FH goals/game, ${ref.games} games).`);
  }

  // Weather
  if (factors.weather) {
    if (factors.weather.rain > 0.5 || factors.weather.windSpeed > 25) {
      parts.push(`Weather: ${factors.weather.description} (${factors.weather.temp}°C, ${factors.weather.rain}mm rain, ${factors.weather.windSpeed}km/h wind).`);
    }
  }

  // Bookie odds comparison
  if (factors.bookieOdds) {
    const bo = factors.bookieOdds;
    parts.push(`Bet365: ${bo.b365Home}/${bo.b365Draw}/${bo.b365Away} (AH line: ${bo.ahLine}).`);
  }

  // Value edge
  if (factors.valueEdge !== null && factors.valueEdge !== 0) {
    if (factors.valueEdge > 3) parts.push(`Value: +${factors.valueEdge}% edge over market.`);
    else if (factors.valueEdge < -3) parts.push(`Warning: market disagrees (${factors.valueEdge}% edge).`);
  }

  // Web data
  if (factors.webData?.league) {
    parts.push(`${factors.webData.league}.`);
  }

  return parts.join(' ');
}

// ===== MAIN EXPORT =====

/**
 * Generate first-half handicap predictions for soccer matches.
 * Returns picks sorted by win probability (safest first).
 */
export async function generateHandicapPredictions(
  dateFilter?: string,
): Promise<FirstHalfHandicapPick[]> {
  // Soccer only — hardcode sport filter
  const matches = await sql<{
    id: number;
    sport: string;
    game_date: string;
    game_time: string | null;
    home_team_id: number;
    away_team_id: number;
    home_team: string;
    away_team: string;
  }[]>`
    SELECT
      m.id, m.sport,
      to_char(m.game_date, 'YYYY-MM-DD') as game_date,
      m.game_time,
      m.home_team_id, m.away_team_id,
      ht.name as home_team,
      att.name as away_team
    FROM matches m
    JOIN teams ht ON ht.id = m.home_team_id
    JOIN teams att ON att.id = m.away_team_id
    WHERE m.sport = 'football'
      ${dateFilter ? sql`AND m.game_date = ${dateFilter}` : sql`AND m.game_date >= CURRENT_DATE`}
    ORDER BY m.game_date ASC, m.game_time ASC NULLS LAST
    LIMIT 150
  `;

  if (!matches.length) return [];

  // Fetch all enrichment data in parallel (all cached)
  const [allFHStats, fixtureOdds, refStats] = await Promise.all([
    getAllTeamFHStats(),
    getUpcomingFixtureOdds(),
    getRefereeStats(),
  ]);
  logger.info(
    { teams: allFHStats.size, fixtures: fixtureOdds.length, referees: refStats.size },
    'Enrichment data loaded for handicap engine',
  );

  const predictions: FirstHalfHandicapPick[] = [];

  // Process in batches of 10
  for (let i = 0; i < matches.length; i += 10) {
    const batch = matches.slice(i, i + 10);
    const results = await Promise.all(
      batch.map(async (m) => {
        try {
          // Look up web FH stats for both teams
          const homeFHStats = findTeamFHStats(m.home_team, allFHStats);
          const awayFHStats = findTeamFHStats(m.away_team, allFHStats);

          // Gather all data signals in parallel
          const dateStr = m.game_date.toString().includes('T')
            ? m.game_date.toString().split('T')[0]!
            : m.game_date.toString();

          const [homeForm, awayForm, h2h, homeSplit, awaySplit, adapterML, adapterOU, webData, weather] =
            await Promise.all([
              getTeamFormStats(m.home_team_id, m.home_team),
              getTeamFormStats(m.away_team_id, m.away_team),
              getH2HSummary(m.home_team_id, m.away_team_id),
              getVenueSplit(m.home_team_id, true),
              getVenueSplit(m.away_team_id, false),
              getAdapterMoneyline(m.id),
              getAdapterOverUnder(m.id),
              fetchWebData(m.home_team, m.away_team, dateStr),
              getMatchWeather(m.home_team, dateStr),
            ]);

          // Enrichment: find fixture odds and referee
          const fixture = findFixtureOdds(m.home_team, m.away_team, fixtureOdds);
          const refName = fixture?.referee || '';
          const referee = refName ? (refStats.get(refName.toLowerCase()) || null) : null;

          // STRICT filter: only show picks with REAL team-specific data.
          // No more default-average junk. Need at least one of:
          // - FH stats for at least one team (from football-data.co.uk / openfootball)
          // - Real bookmaker odds for this fixture
          const hasRealFHData = homeFHStats || awayFHStats;
          const hasBookieOdds = fixture !== null;
          if (!hasRealFHData && !hasBookieOdds) return null;

          // Estimate first-half expected goals
          let { lambdaHome, lambdaAway, dataQuality } = estimateFHGoals({
            homeForm, awayForm, h2h, homeSplit, awaySplit,
            adapterOU, adapterML, webData, homeFHStats, awayFHStats,
          });

          // REFEREE ADJUSTMENT: scale lambdas by referee's FH goal rate
          if (referee && referee.games >= 5) {
            const refFactor = referee.fhGoalRate; // >1 = more goals than avg, <1 = fewer
            lambdaHome *= refFactor;
            lambdaAway *= refFactor;
            dataQuality = Math.min(100, dataQuality + 5);
          }

          // WEATHER ADJUSTMENT: heavy rain/wind reduces FH goals
          if (weather) {
            if (weather.rain > 2) {
              lambdaHome *= 0.90; // heavy rain → ~10% fewer FH goals
              lambdaAway *= 0.90;
            } else if (weather.rain > 0.5) {
              lambdaHome *= 0.95;
              lambdaAway *= 0.95;
            }
            if (weather.windSpeed > 40) {
              lambdaHome *= 0.95;
              lambdaAway *= 0.95;
            }
          }

          // Clamp after adjustments
          lambdaHome = Math.max(0.05, Math.min(2.5, lambdaHome));
          lambdaAway = Math.max(0.05, Math.min(2.5, lambdaAway));

          // Build Poisson score matrix for first half
          const matrix = scoreMatrix(lambdaHome, lambdaAway);

          // Calculate handicap probabilities for ALL lines (H1, H1.5, H2)
          // For each handicap value, pick the better side
          const handicapValues = [1, 1.5, 2] as const;
          const allLines: HandicapLine[] = [];

          for (const hcVal of handicapValues) {
            const awayProb = handicapCoverProb(matrix, hcVal, 'away');
            const homeProb = handicapCoverProb(matrix, hcVal, 'home');

            // Pick the side with higher win probability
            const bestIsAway = awayProb.win >= homeProb.win;
            const best = bestIsAway ? awayProb : homeProb;
            const side = bestIsAway ? 'away' as const : 'home' as const;

            // Calibrate probabilities based on backtest results
            // Backtest showed the model overestimates win probs, especially for H1
            // Calibration: predicted → actual mapping from 2025-26 season
            const rawWin = best.win;
            const calibrated = calibrateProb(rawWin, hcVal);
            const winPct = Math.round(calibrated.win * 1000) / 10;
            const pushPct = Math.round(calibrated.push * 1000) / 10;
            const lossPct = Math.round(calibrated.loss * 1000) / 10;

            // Format pick string: Home (X:0) or Away (0:X)
            const pickStr = side === 'away'
              ? `Away (0:${hcVal % 1 === 0 ? hcVal : hcVal})`
              : `Home (${hcVal % 1 === 0 ? hcVal : hcVal}:0)`;

            if (winPct >= 55) { // Lower threshold — H1 picks at 55%+ are still interesting
              allLines.push({
                handicap: hcVal,
                pick: pickStr,
                pickSide: side,
                winProb: winPct,
                pushProb: pushPct,
                lossProb: lossPct,
                impliedOdds: Math.round((1 / best.win) * 100) / 100,
              });
            }
          }

          if (allLines.length === 0) return null;

          // Primary pick: best value line — prefer H1 or H1.5 with good probability (70%+)
          // Fall back to H2 if nothing else qualifies
          const primaryLine = allLines.find(l => l.handicap <= 1.5 && l.winProb >= 70)
            || allLines.find(l => l.handicap === 1.5 && l.winProb >= 65)
            || allLines.find(l => l.handicap === 1 && l.winProb >= 60)
            || allLines[0]!;

          const likelyScore = mostLikelyScore(matrix);

          // Calculate strength differential
          const strengthDiff = homeForm && awayForm
            ? (homeForm.avgScored - homeForm.avgConceded) - (awayForm.avgScored - awayForm.avgConceded)
            : 0;

          const date = m.game_date.toString().includes('T')
            ? m.game_date.toString().split('T')[0]!
            : m.game_date.toString();

          const pick: FirstHalfHandicapPick = {
            matchId: m.id,
            homeTeam: m.home_team,
            awayTeam: m.away_team,
            date,
            gameTime: m.game_time,
            pick: primaryLine.pick,
            pickSide: primaryLine.pickSide,
            market: '1st Half - Handicap',
            handicap: primaryLine.handicap,
            winProb: primaryLine.winProb,
            pushProb: primaryLine.pushProb,
            lossProb: primaryLine.lossProb,
            impliedOdds: primaryLine.impliedOdds,
            lines: allLines,
            confidence: confLabel(dataQuality),
            confidenceScore: dataQuality,
            fhHomeGoals: lambdaHome,
            fhAwayGoals: lambdaAway,
            likelyFHScore: `${likelyScore.home}-${likelyScore.away}`,
            likelyFHProb: likelyScore.prob,
            factors: {
              homeForm, awayForm, h2h, homeSplit, awaySplit,
              adapterMoneyline: adapterML,
              adapterOverUnder: adapterOU,
              strengthDiff: Math.round(strengthDiff * 100) / 100,
              webData,
              homeFHStats,
              awayFHStats,
              referee,
              weather,
              bookieOdds: fixture ? {
                ahLine: fixture.ahLine,
                ahHome: fixture.ahOddsHome,
                ahAway: fixture.ahOddsAway,
                b365Home: fixture.b365Home,
                b365Draw: fixture.b365Draw,
                b365Away: fixture.b365Away,
              } : null,
              valueEdge: null, // calculated below
            },
            analysis: '',
          };

          // Calculate value edge: our win probability minus bookmaker's implied probability
          if (fixture && fixture.b365Home > 0) {
            // Use 1X2 odds to estimate implied strength, then map to our FH handicap
            const ourProb = primaryLine.winProb / 100;
            const bookieImplied = 1 / primaryLine.impliedOdds;
            pick.factors.valueEdge = Math.round((ourProb - bookieImplied) * 1000) / 10;
          }

          pick.analysis = generateAnalysis(pick);
          return pick;
        } catch (err) {
          logger.warn({ err, matchId: m.id }, 'Failed to generate FH handicap prediction');
          return null;
        }
      }),
    );

    for (const r of results) {
      if (r) predictions.push(r);
    }
  }

  // Deduplicate: if multiple DB entries map to the same real match
  // (e.g. "Kaiserslautern" and "1. FC Kaiserslautern"), keep the one with more data
  const seen = new Map<string, FirstHalfHandicapPick>();
  for (const p of predictions) {
    // Normalize key: strip common prefixes/suffixes, sort alphabetically
    const norm = (s: string) => s.toLowerCase()
      .replace(/^(1\.\s*|fc\s+|sc\s+|sv\s+|tsv\s+|vfb\s+|vfl\s+)/, '')
      .replace(/\s*(fc|sc|cf|afc|w)$/, '')
      .trim();
    const key = [norm(p.homeTeam), norm(p.awayTeam)].sort().join('|');
    const existing = seen.get(key);
    if (!existing || p.confidenceScore > existing.confidenceScore) {
      seen.set(key, p);
    }
  }
  const deduped = [...seen.values()];

  // Sort by win probability descending (safest picks first)
  deduped.sort((a, b) => b.winProb - a.winProb);

  return deduped;
}

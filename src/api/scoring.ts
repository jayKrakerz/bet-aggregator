/**
 * Shared scoring engine for ranking match predictions.
 *
 * Weights: confidence 30, margin 25, source agreement 20, value/EV 20,
 *          source accuracy 15, alignment 10, form 10, h2h 5, home advantage 5
 * Raw max: 140, normalized to 0-100
 */

import { getTeamForm, getH2HResults, getHomeSplit, getAwaySplit, getSourceAccuracy } from '../db/queries.js';
import { logger } from '../utils/logger.js';

export interface MatchPick {
  match_id: number;
  game_date: string;
  game_time: string | null;
  sport: string;
  home_team: string;
  away_team: string;
  home_team_id: number | null;
  away_team_id: number | null;
  pick_type: string;
  side: string;
  value: number | null;
  source_name: string;
  picker_name: string;
  confidence: string | null;
  reasoning: string | null;
}

export interface ScoredMatch {
  matchId: number;
  date: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  gameTime: string | null;
  recommendation: string;
  pickType: string;
  score: number;
  sourceAgreement: number;
  confidenceScore: number;
  marginScore: number;
  valueScore: number;
  sourceAccuracy: number;
  alignmentScore: number;
  formScore: number;
  h2hScore: number;
  homeAdvantage: number;
  analysis: string;
  sources: { name: string; side: string; confidence: string | null; detail: string; winRate: number | null }[];
  bestOdds: number | null;
  impliedProb: number | null;
  estimatedProb: number;
  expectedValue: number | null;
  edge: number | null;
}

const RAW_MAX = 140;

interface SourceAgreementResult {
  score: number;
  bestSide: string;
  sideCount: number;
  totalSources: number;
  disagreement: boolean;
}

export function scoreSourceAgreement(matchPicks: MatchPick[]): SourceAgreementResult {
  const mlPicks = matchPicks.filter((p) => p.pick_type === 'moneyline');
  const sideSources: Record<string, Set<string>> = {};
  for (const p of mlPicks) {
    if (!sideSources[p.side]) sideSources[p.side] = new Set();
    sideSources[p.side]!.add(p.source_name);
  }

  let bestSide = '';
  let maxCount = 0;
  for (const [side, sources] of Object.entries(sideSources)) {
    if (sources.size > maxCount) {
      maxCount = sources.size;
      bestSide = side;
    }
  }

  const totalSources = new Set(mlPicks.map((p) => p.source_name)).size;
  const distinctSides = Object.keys(sideSources).length;
  const disagreement = distinctSides > 1;

  let score: number;
  if (disagreement) {
    const minority = totalSources - maxCount;
    score = Math.max(0, maxCount * 5 - minority * 8);
  } else if (maxCount >= 4) score = 20;
  else if (maxCount >= 3) score = 18;
  else if (maxCount >= 2) score = 14;
  else if (maxCount >= 1) score = 5;
  else score = 0;

  return { score, bestSide, sideCount: maxCount, totalSources, disagreement };
}

export function scoreConfidence(matchPicks: MatchPick[], favSide: string): number {
  const confValues: Record<string, number> = { best_bet: 30, high: 22, medium: 12, low: 4 };
  const sidePicks = matchPicks.filter((p) => p.side === favSide && p.confidence);
  if (!sidePicks.length) return 3;

  const scores = sidePicks.map((p) => confValues[p.confidence!] ?? 3);
  const highest = Math.max(...scores);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  return Math.round(highest * 0.7 + avg * 0.3);
}

export function extractAvgGoals(matchPicks: MatchPick[]): number | null {
  for (const p of matchPicks) {
    if (!p.reasoning) continue;
    const m = p.reasoning.match(/Avg goals:\s*([\d.]+)/i);
    if (m) return parseFloat(m[1]!);
  }
  return null;
}

export function extractPredictedMargin(
  matchPicks: MatchPick[],
  sport: string,
): { margin: number | null; details: string[]; predictedDraw: boolean } {
  const details: string[] = [];
  let totalMargin = 0;
  let count = 0;
  let predictedDraw = false;
  const seen = new Set<string>();

  for (const p of matchPicks) {
    if (!p.reasoning) continue;
    const predMatch = p.reasoning.match(/Predicted:\s*(\d{1,3})\s*-\s*(\d{1,3})/i);
    if (!predMatch) continue;

    const home = parseInt(predMatch[1]!, 10);
    const away = parseInt(predMatch[2]!, 10);
    const key = `${p.source_name}:${home}-${away}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (sport === 'football' && (home > 20 || away > 20)) continue;
    if (sport === 'nba' && (home < 50 || away < 50)) continue;

    const margin = Math.abs(home - away);
    if (margin === 0) predictedDraw = true;
    totalMargin += margin;
    count++;
    details.push(`${p.source_name}: ${home}-${away}`);
  }

  if (!count) return { margin: null, details, predictedDraw };
  return { margin: totalMargin / count, details, predictedDraw };
}

export function scoreMargin(margin: number | null, sport: string, predictedDraw: boolean): number {
  if (margin === null) return 5;
  if (predictedDraw) return 2;
  if (sport === 'football') {
    if (margin >= 3) return 25;
    if (margin >= 2) return 20;
    if (margin >= 1) return 12;
    return 3;
  }
  // nba
  if (margin >= 12) return 25;
  if (margin >= 8) return 20;
  if (margin >= 5) return 15;
  return 8;
}

function toDecimalOdds(value: number | null, sport: string): number | null {
  if (value == null) return null;
  if (sport === 'football') return value;
  if (value < 0) return 1 + 100 / Math.abs(value);
  return 1 + value / 100;
}

/**
 * Extract the best available decimal odds for the favored side.
 * Only uses moneyline picks to avoid confusing spread values with odds.
 */
export function extractBestOdds(
  matchPicks: MatchPick[],
  favSide: string,
  sport: string,
): { bestOdds: number | null; impliedProb: number | null } {
  const mlPicks = matchPicks.filter(
    (p) => p.pick_type === 'moneyline' && p.side === favSide && p.value != null,
  );
  if (!mlPicks.length) return { bestOdds: null, impliedProb: null };

  const decOddsList = mlPicks
    .map((p) => toDecimalOdds(p.value, sport))
    .filter((d): d is number => d !== null && d > 1.01 && d < 50);

  if (!decOddsList.length) return { bestOdds: null, impliedProb: null };

  // Best odds = highest payout available
  const bestOdds = Math.max(...decOddsList);
  const impliedProb = Math.round((1 / bestOdds) * 1000) / 10;

  return {
    bestOdds: Math.round(bestOdds * 100) / 100,
    impliedProb,
  };
}

/**
 * Estimate the win probability for a pick based on source consensus and accuracy.
 *
 * Model: blend source accuracy (quality) with agreement ratio (quantity).
 * When sources strongly agree AND have good track records → high probability.
 * When sources are split or unproven → regress toward 50%.
 */
export function estimateWinProbability(params: {
  backingCount: number;
  totalCount: number;
  avgAccuracy: number | null; // 0-100 scale, null if no data
  bestConfidence: string | null;
}): number {
  const { backingCount, totalCount, avgAccuracy, bestConfidence } = params;

  if (backingCount === 0 || totalCount === 0) return 50;

  // Source accuracy as base signal (default 52% if no grading data yet)
  const baseProb = avgAccuracy !== null ? avgAccuracy : 52;

  // Agreement weight: how much to trust the source accuracy vs regress to 50%
  // Full agreement → weight 1.0, split → weight approaches 0
  const agreementRatio = backingCount / totalCount;
  const agreementWeight = Math.min(1, agreementRatio * 1.2);

  // Blend: trust accuracy proportional to agreement strength
  let prob = (baseProb / 100) * agreementWeight + 0.5 * (1 - agreementWeight);

  // Multi-source confirmation boost (diminishing returns)
  // Independent signals agreeing is stronger than one source alone
  if (backingCount >= 5) prob += 0.05;
  else if (backingCount >= 4) prob += 0.04;
  else if (backingCount >= 3) prob += 0.03;
  else if (backingCount >= 2) prob += 0.02;

  // Confidence boost from source-assigned ratings
  const confBoost: Record<string, number> = { best_bet: 0.04, high: 0.02, medium: 0.01 };
  prob += confBoost[bestConfidence ?? ''] ?? 0;

  // Clamp to reasonable bounds
  return Math.round(Math.min(92, Math.max(15, prob * 100)) * 10) / 10;
}

/**
 * Score based on expected value (0-20 pts).
 * Replaces the old odds "sweet spot" scoring with actual EV calculation.
 *
 * EV% = (estimatedProb × decimalOdds) - 1
 * Positive EV = the bet is profitable long-term.
 */
export function scoreValue(
  estimatedProb: number, // 0-100 scale
  bestOdds: number | null,
): { score: number; ev: number | null; edge: number | null } {
  if (bestOdds === null) {
    // No odds data — can't calculate EV. Give a neutral score.
    return { score: 7, ev: null, edge: null };
  }

  const prob = estimatedProb / 100;
  const marketProb = 1 / bestOdds;
  const ev = (prob * bestOdds - 1) * 100; // EV as percentage
  const edge = (prob - marketProb) * 100;  // Edge in percentage points

  let score: number;
  if (ev >= 20) score = 20;       // exceptional value
  else if (ev >= 12) score = 17;  // strong value
  else if (ev >= 6) score = 14;   // good value
  else if (ev >= 2) score = 10;   // marginal value
  else if (ev >= 0) score = 6;    // fair value
  else if (ev >= -5) score = 3;   // slight negative
  else score = 0;                 // clear negative — avoid

  return {
    score,
    ev: Math.round(ev * 10) / 10,
    edge: Math.round(edge * 10) / 10,
  };
}

export function scoreAlignment(
  matchPicks: MatchPick[],
  favSide: string,
  avgGoals: number | null,
): number {
  let score = 0;

  const mlPicks = matchPicks.filter((p) => p.pick_type === 'moneyline' && p.side === favSide);
  const spreadPicks = matchPicks.filter((p) => p.pick_type === 'spread' && p.side === favSide);
  if (mlPicks.length > 0 && spreadPicks.length > 0) score += 3;

  const bttsPicks = matchPicks.filter((p) => p.pick_type === 'prop');
  const ouPicks = matchPicks.filter((p) => p.pick_type === 'over_under');
  const bttsYes = bttsPicks.some((p) => p.side === 'yes');
  const bttsNo = bttsPicks.some((p) => p.side === 'no');
  const ouOver = ouPicks.some((p) => p.side === 'over');
  const ouUnder = ouPicks.some((p) => p.side === 'under');

  if (bttsYes && ouOver) score += 3;
  else if (bttsNo && ouUnder) score += 3;
  else if ((bttsYes && ouUnder) || (bttsNo && ouOver)) score += 0;
  else if (ouPicks.length > 0 || bttsPicks.length > 0) score += 1;

  if (avgGoals !== null) {
    if (ouOver && avgGoals >= 2.5) score += 2;
    else if (ouUnder && avgGoals < 2.0) score += 2;
    else if (avgGoals >= 2.0 && avgGoals < 2.5) score += 1;
  }

  return Math.min(score, 10);
}

// ===== New async scoring factors =====

/**
 * Score based on recent form of the favored team (0-10 pts).
 * Looks at last 10 results, awards points for wins + streak bonus.
 */
export async function scoreForm(teamId: number | null, favSide: string): Promise<number> {
  if (!teamId) return 0;
  try {
    const results = await getTeamForm(teamId, 10);
    if (!results.length) return 0;

    let wins = 0;
    let streak = 0;
    let streakCounting = true;

    for (const r of results) {
      const isHome = r.is_home;
      const won = isHome ? r.home_score > r.away_score : r.away_score > r.home_score;
      if (won) {
        wins++;
        if (streakCounting) streak++;
      } else {
        streakCounting = false;
      }
    }

    const winRate = wins / results.length;
    let score = Math.round(winRate * 7); // 0-7 base points
    if (streak >= 5) score += 3;
    else if (streak >= 3) score += 2;
    else if (streak >= 2) score += 1;

    return Math.min(score, 10);
  } catch {
    return 0;
  }
}

/**
 * Score based on head-to-head record (0-5 pts).
 * Favors consistent historical dominance.
 */
export async function scoreH2H(
  homeTeamId: number | null,
  awayTeamId: number | null,
  favSide: string,
): Promise<number> {
  if (!homeTeamId || !awayTeamId) return 0;
  try {
    const results = await getH2HResults(homeTeamId, awayTeamId, 10);
    if (results.length < 2) return 0;

    let favWins = 0;
    for (const r of results) {
      if (favSide === 'home' && r.home_score > r.away_score) favWins++;
      else if (favSide === 'away' && r.away_score > r.home_score) favWins++;
    }

    const dominance = favWins / results.length;
    if (dominance >= 0.8) return 5;
    if (dominance >= 0.6) return 3;
    if (dominance >= 0.5) return 1;
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Score home/away advantage (0-5 pts).
 * Awards points based on the favored team's record in that venue role.
 */
export async function scoreHomeAdvantage(
  teamId: number | null,
  favSide: string,
): Promise<number> {
  if (!teamId) return 0;
  try {
    const [split] = favSide === 'home'
      ? await getHomeSplit(teamId)
      : await getAwaySplit(teamId);

    if (!split || split.total < 5) return 0;

    const winPct = split.wins / split.total;
    if (winPct >= 0.75) return 5;
    if (winPct >= 0.6) return 3;
    if (winPct >= 0.5) return 1;
    return 0;
  } catch {
    return 0;
  }
}

// ===== Source accuracy scoring =====

interface SourceStats {
  slug: string;
  name: string;
  winRate: number;
  decided: number;
}

// In-memory cache: "sourceName:sport" -> stats
let accuracyCache: Map<string, SourceStats> | null = null;
let accuracyCacheTime = 0;
const ACCURACY_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Load source accuracy from DB with in-memory caching.
 * Key: "sourceName:sport", falls back to "sourceName:*" for cross-sport average.
 */
async function getSourceAccuracyMap(): Promise<Map<string, SourceStats>> {
  if (accuracyCache && Date.now() - accuracyCacheTime < ACCURACY_CACHE_TTL) {
    return accuracyCache;
  }

  try {
    const rows = await getSourceAccuracy();
    const map = new Map<string, SourceStats>();

    // Per-sport accuracy
    for (const r of rows) {
      const winRate = r.decided > 0 ? Math.round((r.wins / r.decided) * 1000) / 10 : 0;
      map.set(`${r.name}:${r.sport}`, { slug: r.slug, name: r.name, winRate, decided: r.decided });
    }

    // Cross-sport aggregates (for sources without sport-specific data)
    const bySource = new Map<string, { wins: number; decided: number; slug: string; name: string }>();
    for (const r of rows) {
      const existing = bySource.get(r.name) ?? { wins: 0, decided: 0, slug: r.slug, name: r.name };
      existing.wins += r.wins;
      existing.decided += r.decided;
      bySource.set(r.name, existing);
    }
    for (const [name, agg] of bySource) {
      if (!map.has(`${name}:*`)) {
        const winRate = agg.decided > 0 ? Math.round((agg.wins / agg.decided) * 1000) / 10 : 0;
        map.set(`${name}:*`, { slug: agg.slug, name: agg.name, winRate, decided: agg.decided });
      }
    }

    accuracyCache = map;
    accuracyCacheTime = Date.now();
    logger.debug({ entries: map.size }, 'Source accuracy cache refreshed');
    return map;
  } catch (err) {
    logger.warn({ err }, 'Failed to load source accuracy');
    return accuracyCache ?? new Map();
  }
}

/**
 * Look up a source's win rate for a given sport.
 * Falls back to cross-sport average if sport-specific data is insufficient.
 */
function getSourceWinRate(
  accuracyMap: Map<string, SourceStats>,
  sourceName: string,
  sport: string,
): number | null {
  const sportKey = `${sourceName}:${sport}`;
  const sportStats = accuracyMap.get(sportKey);
  if (sportStats && sportStats.decided >= 10) return sportStats.winRate;

  const globalKey = `${sourceName}:*`;
  const globalStats = accuracyMap.get(globalKey);
  if (globalStats && globalStats.decided >= 10) return globalStats.winRate;

  return null;
}

/**
 * Score based on the proven accuracy of sources backing this pick (0-15 pts).
 * Rewards picks backed by historically accurate sources.
 */
export async function scoreSourceAccuracyFactor(
  matchPicks: MatchPick[],
  favSide: string,
  sport: string,
): Promise<{ score: number; accuracyMap: Map<string, SourceStats> }> {
  const accuracyMap = await getSourceAccuracyMap();

  // Find unique sources backing the favored side
  const backingSources = [
    ...new Set(matchPicks.filter((p) => p.side === favSide).map((p) => p.source_name)),
  ];

  if (!backingSources.length) return { score: 3, accuracyMap };

  let totalWinRate = 0;
  let count = 0;

  for (const source of backingSources) {
    const winRate = getSourceWinRate(accuracyMap, source, sport);
    if (winRate !== null) {
      totalWinRate += winRate;
      count++;
    }
  }

  // No accuracy data yet — neutral score
  if (count === 0) return { score: 5, accuracyMap };

  const avgWinRate = totalWinRate / count;

  let score: number;
  if (avgWinRate >= 65) score = 15;
  else if (avgWinRate >= 58) score = 12;
  else if (avgWinRate >= 52) score = 9;
  else if (avgWinRate >= 48) score = 6;
  else score = 3;

  return { score, accuracyMap };
}

export function generateAnalysis(
  info: MatchPick,
  favSide: string,
  srcAgreement: { sideCount: number; totalSources: number; disagreement: boolean },
  marginDetails: string[],
  matchPicks: MatchPick[],
  compositeScore: number,
  avgGoals: number | null,
  accuracyInfo?: { avgWinRate: number; trackedCount: number },
  valueInfo?: { ev: number | null; edge: number | null; bestOdds: number | null },
): string {
  const parts: string[] = [];
  const teamName = favSide === 'home' ? info.home_team : favSide === 'away' ? info.away_team : 'Draw';

  if (srcAgreement.disagreement) {
    parts.push(
      `${srcAgreement.sideCount} of ${srcAgreement.totalSources} predictions back ${teamName} (split).`,
    );
  } else if (srcAgreement.sideCount >= 2) {
    parts.push(
      `${srcAgreement.sideCount} of ${srcAgreement.totalSources} predictions back ${teamName}.`,
    );
  } else if (srcAgreement.totalSources > 0) {
    parts.push(`Backed by 1 prediction.`);
  }

  // Source accuracy insight
  if (accuracyInfo && accuracyInfo.trackedCount > 0) {
    const label = accuracyInfo.avgWinRate >= 58 ? 'strong'
      : accuracyInfo.avgWinRate >= 52 ? 'solid'
      : accuracyInfo.avgWinRate >= 48 ? 'mixed'
      : 'weak';
    parts.push(`Sources have ${label} track record (${accuracyInfo.avgWinRate}% avg win rate).`);
  }

  // Expected value insight
  if (valueInfo?.ev !== null && valueInfo?.ev !== undefined && valueInfo.bestOdds) {
    if (valueInfo.ev >= 10) {
      parts.push(`Strong value: +${valueInfo.ev}% EV at ${valueInfo.bestOdds} odds.`);
    } else if (valueInfo.ev >= 2) {
      parts.push(`Value bet: +${valueInfo.ev}% EV at ${valueInfo.bestOdds} odds.`);
    } else if (valueInfo.ev < -5) {
      parts.push(`Negative value: ${valueInfo.ev}% EV at ${valueInfo.bestOdds} odds — overpriced.`);
    }
  }

  // Strip source names from margin details, just show scores
  if (marginDetails.length > 0) {
    const scores = marginDetails.map((d) => d.replace(/^[^:]+:\s*/, ''));
    parts.push(`Predicted: ${scores.join(', ')}.`);
  }

  const bestConfPick = matchPicks
    .filter((p) => p.side === favSide && p.confidence)
    .sort((a, b) => {
      const order: Record<string, number> = { best_bet: 4, high: 3, medium: 2, low: 1 };
      return (order[b.confidence!] ?? 0) - (order[a.confidence!] ?? 0);
    })[0];

  if (bestConfPick) {
    const confLabel = bestConfPick.confidence!.replace('_', ' ');
    parts.push(`Rated '${confLabel}'.`);
  }

  if (avgGoals !== null && info.sport === 'football') {
    parts.push(`Avg goals: ${avgGoals.toFixed(1)}/game.`);
  }

  const bttsYes = matchPicks.some((p) => p.pick_type === 'prop' && p.side === 'yes');
  const ouOver = matchPicks.some((p) => p.pick_type === 'over_under' && p.side === 'over');
  const bttsNo = matchPicks.some((p) => p.pick_type === 'prop' && p.side === 'no');
  const ouUnder = matchPicks.some((p) => p.pick_type === 'over_under' && p.side === 'under');
  if (bttsYes && ouOver) parts.push('BTTS and over agree — expect goals.');
  else if (bttsNo && ouUnder) parts.push('BTTS=no and under agree — tight game expected.');

  if (!parts.length) {
    parts.push(`Score ${compositeScore}/100 based on available signals.`);
  }

  return parts.join(' ');
}

/** Build the deduped sources list for a scored match, with per-source win rates */
export function buildSourcesList(
  matchPicks: MatchPick[],
  favSide: string,
  sport: string,
  accuracyMap?: Map<string, SourceStats>,
): ScoredMatch['sources'] {
  return matchPicks
    .filter((p) => p.side === favSide || p.pick_type === 'over_under')
    .reduce<ScoredMatch['sources']>((acc, p) => {
      if (acc.some((s) => s.name === p.source_name && s.side === p.side)) return acc;
      let detail = '';
      if (p.pick_type === 'moneyline' && p.value != null) {
        detail = `ML: ${p.value}`;
      } else if (p.pick_type === 'spread' && p.value != null) {
        detail = `Spread: ${p.value > 0 ? '+' : ''}${p.value}`;
      } else if (p.pick_type === 'over_under' && p.value != null) {
        detail = `${p.side} ${p.value}`;
      }
      if (p.reasoning) {
        const predMatch = p.reasoning.match(/Predicted:\s*[\d]+-[\d]+/i);
        if (predMatch) detail += detail ? ` | ${predMatch[0]}` : predMatch[0];
      }

      const winRate = accuracyMap
        ? getSourceWinRate(accuracyMap, p.source_name, sport)
        : null;

      acc.push({
        name: p.source_name,
        side: p.side,
        confidence: p.confidence,
        detail,
        winRate,
      });
      return acc;
    }, []);
}

/** Score a single match — async for form/H2H/home advantage/source accuracy lookups */
export async function scoreMatch(
  matchId: number,
  info: MatchPick,
  matchPicks: MatchPick[],
): Promise<ScoredMatch | null> {
  const srcResult = scoreSourceAgreement(matchPicks);
  if (!srcResult.bestSide) return null;

  const favSide = srcResult.bestSide;
  const confScore = scoreConfidence(matchPicks, favSide);
  const avgGoals = extractAvgGoals(matchPicks);
  const { margin, details: marginDetails, predictedDraw } = extractPredictedMargin(matchPicks, info.sport);
  const mrgScore = scoreMargin(margin, info.sport, predictedDraw);
  const alignScore = scoreAlignment(matchPicks, favSide, avgGoals);

  // Async factors — resolve favored team ID + source accuracy
  const favTeamId = favSide === 'home' ? info.home_team_id : info.away_team_id;
  const [formPts, h2hPts, homePts, srcAccResult] = await Promise.all([
    scoreForm(favTeamId, favSide),
    scoreH2H(info.home_team_id, info.away_team_id, favSide),
    scoreHomeAdvantage(favTeamId, favSide),
    scoreSourceAccuracyFactor(matchPicks, favSide, info.sport),
  ]);

  // Compute average win rate of backing sources
  const backingSources = [...new Set(matchPicks.filter((p) => p.side === favSide).map((p) => p.source_name))];
  let accWinRateSum = 0;
  let accTracked = 0;
  for (const src of backingSources) {
    const wr = getSourceWinRate(srcAccResult.accuracyMap, src, info.sport);
    if (wr !== null) { accWinRateSum += wr; accTracked++; }
  }
  const avgAccuracy = accTracked > 0 ? Math.round(accWinRateSum / accTracked * 10) / 10 : null;

  // Best confidence among backing picks
  const confOrder: Record<string, number> = { best_bet: 4, high: 3, medium: 2, low: 1 };
  const bestConf = matchPicks
    .filter((p) => p.side === favSide && p.confidence)
    .sort((a, b) => (confOrder[b.confidence!] ?? 0) - (confOrder[a.confidence!] ?? 0))[0]?.confidence ?? null;

  // Estimate win probability from our signals
  const estimatedProb = estimateWinProbability({
    backingCount: srcResult.sideCount,
    totalCount: srcResult.totalSources,
    avgAccuracy,
    bestConfidence: bestConf,
  });

  // Extract best odds and compute expected value
  const { bestOdds, impliedProb } = extractBestOdds(matchPicks, favSide, info.sport);
  const valResult = scoreValue(estimatedProb, bestOdds);

  const rawScore = srcResult.score + confScore + mrgScore + valResult.score
    + srcAccResult.score + alignScore + formPts + h2hPts + homePts;
  const composite = Math.round((rawScore / RAW_MAX) * 100);

  const hasMl = matchPicks.some((p) => p.pick_type === 'moneyline' && p.side === favSide);
  const pickType = hasMl ? 'moneyline' : 'spread';

  const accuracyInfo = accTracked > 0
    ? { avgWinRate: avgAccuracy!, trackedCount: accTracked }
    : undefined;

  const valueInfo = { ev: valResult.ev, edge: valResult.edge, bestOdds };

  const analysis = generateAnalysis(
    info, favSide, srcResult, marginDetails, matchPicks, composite, avgGoals, accuracyInfo, valueInfo,
  );
  const sources = buildSourcesList(matchPicks, favSide, info.sport, srcAccResult.accuracyMap);

  const dateStr = info.game_date.toString();
  const date = dateStr.includes('T') ? dateStr.split('T')[0]! : dateStr;

  return {
    matchId,
    date,
    sport: info.sport,
    homeTeam: info.home_team,
    awayTeam: info.away_team,
    gameTime: info.game_time,
    recommendation: favSide,
    pickType,
    score: composite,
    sourceAgreement: srcResult.score,
    confidenceScore: confScore,
    marginScore: mrgScore,
    valueScore: valResult.score,
    sourceAccuracy: srcAccResult.score,
    alignmentScore: alignScore,
    formScore: formPts,
    h2hScore: h2hPts,
    homeAdvantage: homePts,
    analysis,
    sources,
    bestOdds,
    impliedProb,
    estimatedProb,
    expectedValue: valResult.ev,
    edge: valResult.edge,
  };
}

/** Group picks by match ID */
export function groupByMatch(picks: MatchPick[]): Map<number, { info: MatchPick; picks: MatchPick[] }> {
  const matchMap = new Map<number, { info: MatchPick; picks: MatchPick[] }>();
  for (const p of picks) {
    if (!matchMap.has(p.match_id)) {
      matchMap.set(p.match_id, { info: p, picks: [] });
    }
    matchMap.get(p.match_id)!.picks.push(p);
  }
  return matchMap;
}

/**
 * Live Value Picks
 *
 * Combines the live-predictor's Kelly edge analysis with raw Sportybet markets
 * to produce pickable outcomes that have POSITIVE expected value.
 *
 * Output is a flat list of selections ready for /predictions/create-code,
 * each with:
 *   - eventId, marketId, outcomeId, specifier, sportId (for booking)
 *   - odds (Sportybet live price)
 *   - edge (Kelly edge in %, always positive)
 *   - confidence (0-100, from source agreement)
 *   - sources (which analysis sources contributed)
 *
 * Sources of the edge:
 *   1. Pinnacle sharp odds vs Sportybet (most reliable — Pinnacle is the sharpest bookmaker)
 *   2. Poisson statistical model
 *   3. Tipster consensus (rare for live)
 *   4. Sports-AI ML predictions
 */

import { logger } from '../utils/logger.js';
import { getSportyLiveGames } from './sportybet-live.js';
import { predictLiveState, kellyEdge } from './live-state-predictor.js';
import { broadcastPicks } from './telegram-broadcaster.js';

/**
 * Market-shrinkage blending (adapted from soccer-bet-bot's odds-based Bayesian blend).
 *
 * Blends our state model probability with the bookmaker's implied probability.
 * Weight shifts from market-heavy at kickoff to model-heavy at final whistle.
 *
 *   rate = 0.6 / 90
 *   final_p = (0.4 + rate*minute) * model_p  +  (0.6 - rate*minute) * book_p
 *
 * Rationale:
 *   - Early in match: few data points, state model has high variance. Trust the
 *     market (which knows team strength, lineups, etc.) more.
 *   - Late in match: score + time is the dominant signal. Model knows this better
 *     than market reactive pricing which can be noisy.
 *
 * Benefit: prevents wildly overconfident model picks when state model disagrees
 * hugely with market (usually indicates model error, not real edge).
 */
function blendWithMarket(modelPct: number, bookOdds: number, minute: number): number {
  if (bookOdds <= 1) return modelPct;
  const bookPct = (1 / bookOdds) * 100;
  // Strip ~5% bookmaker margin to estimate market's true belief
  const bookTrueBelief = bookPct / 1.05;
  const clampedMin = Math.max(0, Math.min(90, minute));
  const rate = 0.6 / 90;
  const modelWeight = 0.4 + rate * clampedMin; // 0.4 at kickoff → 1.0 at 90'
  const marketWeight = 1 - modelWeight;
  return modelPct * modelWeight + bookTrueBelief * marketWeight;
}

export interface LiveValuePick {
  eventId: string;
  marketId: string;
  outcomeId: string;
  specifier: string;
  sportId: string;
  odds: number;
  edge: number;              // Kelly edge %, positive
  confidence: number;        // 0-100
  probability: number;       // composite model prob %
  pick: string;              // e.g. "Home", "Over 2.5"
  market: string;            // e.g. "1X2", "Over/Under 2.5"
  home: string;
  away: string;
  league: string;
  sport: string;
  score: string;
  minute: string | null;
  matchStatus: string;
  sources: string[];         // e.g. ["pinnacle", "poisson"]
  fragility: number;         // # goals needed to flip outcome (higher = safer)
  flipRisk: number;          // 0-1, probability outcome gets flipped
  _isLive: true;
}

export interface LiveValueResult {
  picks: LiveValuePick[];
  count: number;
  highConfidence: number;    // count with confidence >= 60
  withPinnacle: number;       // count that had pinnacle edge
  scrapedAt: string;
  analysisSources: string[];
}

// ── Cache ────────────────────────────────────────────────

let cache: LiveValueResult | null = null;
let cacheTime = 0;
const CACHE_TTL = 90_000; // 90 seconds (live odds change fast)

// ── Outcome mapping ──────────────────────────────────────
// Map kelly edge keys → Sportybet marketId/outcomeId/specifier

interface OutcomeMapping {
  marketId: string;
  outcomeId: string;
  specifier: string;
  market: string;
  pickLabel: (home: string, away: string) => string;
}

const OUTCOME_MAP: Record<string, OutcomeMapping> = {
  // 1X2
  home: { marketId: '1', outcomeId: '1', specifier: '', market: '1X2', pickLabel: (h) => h },
  draw: { marketId: '1', outcomeId: '2', specifier: '', market: '1X2', pickLabel: () => 'Draw' },
  away: { marketId: '1', outcomeId: '3', specifier: '', market: '1X2', pickLabel: (_, a) => a },
  // Over/Under (total goals)
  over05: { marketId: '18', outcomeId: '12', specifier: 'total=0.5', market: 'O/U 0.5', pickLabel: () => 'Over 0.5' },
  under05: { marketId: '18', outcomeId: '13', specifier: 'total=0.5', market: 'O/U 0.5', pickLabel: () => 'Under 0.5' },
  over15: { marketId: '18', outcomeId: '12', specifier: 'total=1.5', market: 'O/U 1.5', pickLabel: () => 'Over 1.5' },
  under15: { marketId: '18', outcomeId: '13', specifier: 'total=1.5', market: 'O/U 1.5', pickLabel: () => 'Under 1.5' },
  over25: { marketId: '18', outcomeId: '12', specifier: 'total=2.5', market: 'O/U 2.5', pickLabel: () => 'Over 2.5' },
  under25: { marketId: '18', outcomeId: '13', specifier: 'total=2.5', market: 'O/U 2.5', pickLabel: () => 'Under 2.5' },
  over35: { marketId: '18', outcomeId: '12', specifier: 'total=3.5', market: 'O/U 3.5', pickLabel: () => 'Over 3.5' },
  under35: { marketId: '18', outcomeId: '13', specifier: 'total=3.5', market: 'O/U 3.5', pickLabel: () => 'Under 3.5' },
  // Both Teams to Score
  bttsYes: { marketId: '29', outcomeId: '74', specifier: '', market: 'BTTS', pickLabel: () => 'BTTS Yes' },
  bttsNo: { marketId: '29', outcomeId: '76', specifier: '', market: 'BTTS', pickLabel: () => 'BTTS No' },
  // Double Chance
  dc1X: { marketId: '10', outcomeId: '9', specifier: '', market: 'Double Chance', pickLabel: (h) => h + ' or Draw' },
  dc12: { marketId: '10', outcomeId: '10', specifier: '', market: 'Double Chance', pickLabel: (h, a) => h + ' or ' + a },
  dcX2: { marketId: '10', outcomeId: '11', specifier: '', market: 'Double Chance', pickLabel: (_, a) => 'Draw or ' + a },
  // Draw No Bet (refund on draw)
  dnbHome: { marketId: '11', outcomeId: '4', specifier: '', market: 'Draw No Bet', pickLabel: (h) => h + ' (DNB)' },
  dnbAway: { marketId: '11', outcomeId: '5', specifier: '', market: 'Draw No Bet', pickLabel: (_, a) => a + ' (DNB)' },
  // Odd/Even total goals (Betradar market 26, outcomes 70=odd, 72=even)
  oddTotal: { marketId: '26', outcomeId: '70', specifier: '', market: 'Odd/Even', pickLabel: () => 'Odd' },
  evenTotal: { marketId: '26', outcomeId: '72', specifier: '', market: 'Odd/Even', pickLabel: () => 'Even' },
  // Team totals — home side (market 19), away side (market 20)
  homeOver05: { marketId: '19', outcomeId: '12', specifier: 'total=0.5', market: 'Home Total', pickLabel: (h) => h + ' Over 0.5' },
  homeUnder05: { marketId: '19', outcomeId: '13', specifier: 'total=0.5', market: 'Home Total', pickLabel: (h) => h + ' Under 0.5' },
  homeOver15: { marketId: '19', outcomeId: '12', specifier: 'total=1.5', market: 'Home Total', pickLabel: (h) => h + ' Over 1.5' },
  homeUnder15: { marketId: '19', outcomeId: '13', specifier: 'total=1.5', market: 'Home Total', pickLabel: (h) => h + ' Under 1.5' },
  awayOver05: { marketId: '20', outcomeId: '12', specifier: 'total=0.5', market: 'Away Total', pickLabel: (_, a) => a + ' Over 0.5' },
  awayUnder05: { marketId: '20', outcomeId: '13', specifier: 'total=0.5', market: 'Away Total', pickLabel: (_, a) => a + ' Under 0.5' },
  awayOver15: { marketId: '20', outcomeId: '12', specifier: 'total=1.5', market: 'Away Total', pickLabel: (_, a) => a + ' Over 1.5' },
  awayUnder15: { marketId: '20', outcomeId: '13', specifier: 'total=1.5', market: 'Away Total', pickLabel: (_, a) => a + ' Under 1.5' },
};

/**
 * FRAGILITY: how many goals from either team would flip this outcome?
 *
 *   - fragility = 1 means a single goal can undo the bet → HIGH RISK late in match
 *   - fragility = 2+ means multiple goals needed → SAFER
 *
 * At 0:0 with 5 min left:
 *   - "Draw" pick: fragility 1 (one goal flips it to home/away win)
 *   - "Under 2.5" pick: fragility 3 (need 3 goals in 5 min)
 *   - "Under 0.5" pick: fragility 1 (one goal breaks it)
 *
 * At 1:0 home lead with 5 min left:
 *   - "Home win" pick: fragility 1 (one away goal = draw, 2 = loss)
 *   - "Draw No Bet Home" pick: fragility 2 (one away goal → refund, two → loss)
 *   - "Home or Draw" (DC 1X): fragility 2 (need away to score TWICE)
 *   - "Under 1.5": fragility 1 (one goal breaks it)
 */
function fragilityScore(edgeKey: string, score: string, sport: string): number {
  if (sport !== 'Football') return 99; // unknown for other sports, don't filter
  const parts = score.split(':').map(x => parseInt(x, 10));
  if (parts.length !== 2 || isNaN(parts[0]!) || isNaN(parts[1]!)) return 99;
  const [h, a] = parts as [number, number];
  const diff = h - a;

  switch (edgeKey) {
    // 1X2 picks — fragility depends on current lead size
    case 'home': return diff === 0 ? 1 : diff > 0 ? Math.max(1, diff) : 1;
    case 'away': return diff === 0 ? 1 : diff < 0 ? Math.max(1, -diff) : 1;
    case 'draw': return 1; // one goal to either side breaks the tie

    // Double Chance — needs multiple goals the wrong way
    case 'dc1X': return diff >= 0 ? diff + 1 : 1;  // safe if home leads or tied
    case 'dcX2': return diff <= 0 ? -diff + 1 : 1; // safe if away leads or tied
    case 'dc12': return 1; // loses only on draw — any current non-draw is fragile to 1 goal

    // Draw No Bet — refund on draw, so safer than pure 1X2
    case 'dnbHome': return diff >= 0 ? Math.max(2, diff + 1) : 1;
    case 'dnbAway': return diff <= 0 ? Math.max(2, -diff + 1) : 1;

    // Over totals — once threshold passed, bet is won (infinite fragility to lose)
    case 'over05': return h + a >= 1 ? 99 : 1;
    case 'over15': return h + a >= 2 ? 99 : Math.max(1, 2 - (h + a));
    case 'over25': return h + a >= 3 ? 99 : Math.max(1, 3 - (h + a));
    case 'over35': return h + a >= 4 ? 99 : Math.max(1, 4 - (h + a));

    // Under totals — fragile if close to threshold
    case 'under05': return Math.max(1, 1 - (h + a));
    case 'under15': return Math.max(1, 2 - (h + a));
    case 'under25': return Math.max(1, 3 - (h + a));
    case 'under35': return Math.max(1, 4 - (h + a));

    // BTTS
    case 'bttsYes': return (h >= 1 && a >= 1) ? 99 : (h >= 1 ? 1 : a >= 1 ? 1 : 2);
    case 'bttsNo': return (h >= 1 && a >= 1) ? 0 : (h === 0 && a === 0) ? 2 : 1;
  }
  return 99;
}

/**
 * Skip picks that are mathematically impossible or extremely unlikely given the
 * current live score — the Poisson model doesn't know the current state.
 */
function isImpossiblePick(
  edgeKey: string,
  score: string,
  minute: string | null,
  sport: string,
): boolean {
  // Only applies to football-like sports where score parsing makes sense
  if (sport !== 'Football') return false;

  const parts = score.split(':').map(x => parseInt(x, 10));
  if (parts.length !== 2 || isNaN(parts[0]!) || isNaN(parts[1]!)) return false;
  const [h, a] = parts as [number, number];
  const totalGoals = h + a;
  const m = minute ? parseInt((minute || '').replace(/[^\d]/g, ''), 10) : 0;

  // Under X.5 impossible if already >= X+1 goals scored
  if (edgeKey === 'under05' && totalGoals >= 1) return true;
  if (edgeKey === 'under15' && totalGoals >= 2) return true;
  if (edgeKey === 'under25' && totalGoals >= 3) return true;
  if (edgeKey === 'under35' && totalGoals >= 4) return true;

  // Over X.5 guaranteed if already >= X+1 goals (odds would be 1.0, no value)
  if (edgeKey === 'over05' && totalGoals >= 1) return true;
  if (edgeKey === 'over15' && totalGoals >= 2) return true;
  if (edgeKey === 'over25' && totalGoals >= 3) return true;
  if (edgeKey === 'over35' && totalGoals >= 4) return true;

  // Late match — Over unlikely with few goals remaining
  if (m >= 80) {
    if (edgeKey === 'over05' && totalGoals === 0) return true;
    if (edgeKey === 'over15' && totalGoals <= 1) return true;
    if (edgeKey === 'over25' && totalGoals <= 1) return true;
    if (edgeKey === 'over35' && totalGoals <= 2) return true;
  }

  // BTTS Yes impossible if late and one team hasn't scored
  if (edgeKey === 'bttsYes' && m >= 85 && (h === 0 || a === 0)) return true;

  // BTTS No guaranteed if 0-0 very late OR one team is held at 0
  if (edgeKey === 'bttsNo' && (h >= 1 && a >= 1)) return true;

  // Late match: losing team unlikely to win (minute >= 85, down by 2+)
  if (m >= 85) {
    if (edgeKey === 'home' && a - h >= 2) return true;
    if (edgeKey === 'away' && h - a >= 2) return true;
    if (edgeKey === 'dnbHome' && a - h >= 2) return true;
    if (edgeKey === 'dnbAway' && h - a >= 2) return true;
    // Double chance that includes the leading side is probably already safe
    // (no value in picking them). But we let the edge filter handle that.
  }

  return false;
}

// ── Public API ───────────────────────────────────────────

export async function getLiveValuePicks(forceRefresh = false): Promise<LiveValueResult> {
  if (!forceRefresh && cache && Date.now() - cacheTime < CACHE_TTL) {
    return cache;
  }

  const startMs = Date.now();
  const liveGames = await getSportyLiveGames();

  const picks: LiveValuePick[] = [];

  for (const g of liveGames.games) {
    // Run our state-aware probability model on the current match state
    const modelProbs = predictLiveState({
      sport: g.sport,
      score: g.score,
      minute: g.minute,
      matchStatus: g.matchStatus,
    });
    if (!modelProbs.valid) continue;

    // Confidence based on how far into the match we are (later = more signal)
    // and whether we have a real sport-specific model
    const minuteNum = parseInt((g.minute || '').replace(/[^\d]/g, ''), 10) || 0;
    const isFootball = g.sport === 'Football';
    const isBasketball = g.sport === 'Basketball';

    let baseConfidence = 40;
    if (isFootball) baseConfidence = 50 + Math.min(40, minuteNum / 2); // up to 90 at 80'
    else if (isBasketball) baseConfidence = 45 + Math.min(40, minuteNum);
    else baseConfidence = 30; // generic model — less reliable

    // Check each market outcome for value
    // For football the state model computes all these; for other sports only the
    // ones we've implemented (basketball does 1X2 only).
    const outcomeChecks: Array<{ key: string; probPct: number }> = [
      // Match result
      { key: 'home', probPct: modelProbs.homeWinPct },
      { key: 'draw', probPct: modelProbs.drawPct },
      { key: 'away', probPct: modelProbs.awayWinPct },
      // Totals
      { key: 'over05', probPct: Math.max(modelProbs.over15Pct, 50) }, // ~over 0.5 ≈ 1 - P(0 goals)
      { key: 'under05', probPct: 100 - Math.max(modelProbs.over15Pct, 50) },
      { key: 'over15', probPct: modelProbs.over15Pct },
      { key: 'under15', probPct: 100 - modelProbs.over15Pct },
      { key: 'over25', probPct: modelProbs.over25Pct },
      { key: 'under25', probPct: 100 - modelProbs.over25Pct },
      { key: 'over35', probPct: modelProbs.over35Pct },
      { key: 'under35', probPct: 100 - modelProbs.over35Pct },
      // BTTS
      { key: 'bttsYes', probPct: modelProbs.bttsYesPct },
      { key: 'bttsNo', probPct: modelProbs.bttsNoPct },
      // Double chance (one of two outcomes)
      { key: 'dc1X', probPct: modelProbs.homeWinPct + modelProbs.drawPct },
      { key: 'dc12', probPct: modelProbs.homeWinPct + modelProbs.awayWinPct },
      { key: 'dcX2', probPct: modelProbs.drawPct + modelProbs.awayWinPct },
      // Draw No Bet (prob of winning given not-a-draw)
      { key: 'dnbHome', probPct: modelProbs.drawPct >= 99 ? 50 : modelProbs.homeWinPct / (1 - modelProbs.drawPct / 100) },
      { key: 'dnbAway', probPct: modelProbs.drawPct >= 99 ? 50 : modelProbs.awayWinPct / (1 - modelProbs.drawPct / 100) },
      // Odd/Even total goals
      { key: 'oddTotal', probPct: modelProbs.oddTotalPct },
      { key: 'evenTotal', probPct: modelProbs.evenTotalPct },
      // Team totals
      { key: 'homeOver05', probPct: modelProbs.homeOver05Pct },
      { key: 'homeUnder05', probPct: 100 - modelProbs.homeOver05Pct },
      { key: 'homeOver15', probPct: modelProbs.homeOver15Pct },
      { key: 'homeUnder15', probPct: 100 - modelProbs.homeOver15Pct },
      { key: 'awayOver05', probPct: modelProbs.awayOver05Pct },
      { key: 'awayUnder05', probPct: 100 - modelProbs.awayOver05Pct },
      { key: 'awayOver15', probPct: modelProbs.awayOver15Pct },
      { key: 'awayUnder15', probPct: 100 - modelProbs.awayOver15Pct },
    ];

    for (const { key, probPct } of outcomeChecks) {
      if (probPct <= 0 || probPct >= 100) continue; // skip certainties
      const mapping = OUTCOME_MAP[key];
      if (!mapping) continue;

      // Skip picks that are mathematically impossible given current state
      if (isImpossiblePick(key, g.score || '0:0', g.minute, g.sport)) continue;

      // Fragility: how many goals would flip the outcome?
      const fragility = fragilityScore(key, g.score || '0:0', g.sport);
      // Expected goals remaining in match (rough):
      const minsLeft = Math.max(0, 90 - minuteNum);
      const expGoalsRemaining = 2.7 * (minsLeft / 90);
      // "Flip risk" = probability at least `fragility` goals happen in remaining time
      // For small lambda this is approximately 1 - Poisson CDF at fragility - 1
      let flipRisk = 0;
      if (fragility < 90 && expGoalsRemaining > 0) {
        let cdf = 0;
        let term = Math.exp(-expGoalsRemaining);
        cdf = term;
        for (let k = 1; k < fragility; k++) {
          term *= expGoalsRemaining / k;
          cdf += term;
        }
        flipRisk = Math.max(0, 1 - cdf);
      }

      // REJECT fragile bets in the last 15 min of football — this is the
      // "1:0 at 89'" scenario where one goal changes everything.
      if (g.sport === 'Football' && fragility <= 1 && minuteNum >= 75 && flipRisk > 0.08) {
        continue;
      }

      // Find the actual odds
      const mkt = g.markets.find(m =>
        m.id === mapping.marketId && (mapping.specifier === '' || (m.specifier || '').includes(mapping.specifier)),
      );
      if (!mkt) continue;
      const outcome = mkt.outcomes.find(o => o.id === mapping.outcomeId);
      if (!outcome) continue;
      const odds = parseFloat(outcome.odds);
      if (!odds || odds <= 1.05) continue;

      // SHRINKAGE: blend state-model probability with market's implied probability.
      // Early minute → more market weight (market knows team strength).
      // Late minute → more model weight (state signal dominates).
      const blendedProbPct = blendWithMarket(probPct, odds, minuteNum);

      // Calculate Kelly edge using the BLENDED (shrunken) probability.
      // This filters out model errors that cause unrealistic edges.
      const edgePct = kellyEdge(blendedProbPct, odds);
      if (edgePct <= 2) continue; // require at least 2% edge after shrinkage

      // Cap edges at 30% — bigger means model is probably still wrong
      const cappedEdge = Math.min(30, edgePct);

      // Confidence adjusted by:
      //  1. Edge magnitude (extreme edges = model wrong; modest edges = likely real)
      //  2. Fragility (easy-to-flip bets in late match = low confidence)
      //  3. Market agreement (if model after shrinkage still agrees with market direction, boost)
      let confidence = Math.round(baseConfidence);
      if (edgePct > 25) confidence = Math.max(20, confidence - 20);
      else if (edgePct >= 4 && edgePct <= 15) confidence = Math.min(100, confidence + 10); // sweet spot
      // Fragility penalty — scales with flip risk
      confidence = Math.round(confidence * (1 - flipRisk * 0.5));
      if (fragility >= 2) confidence = Math.min(100, confidence + 10); // robust picks get bonus
      if (fragility >= 3) confidence = Math.min(100, confidence + 5);

      picks.push({
        eventId: g.eventId,
        marketId: mapping.marketId,
        outcomeId: mapping.outcomeId,
        specifier: mapping.specifier,
        sportId: g.sportId,
        odds,
        edge: Math.round(cappedEdge * 10) / 10,
        confidence,
        probability: Math.round(blendedProbPct * 10) / 10,
        pick: mapping.pickLabel(g.homeTeamName, g.awayTeamName),
        market: mapping.market,
        home: g.homeTeamName,
        away: g.awayTeamName,
        league: g.country + ' - ' + g.league,
        sport: g.sport,
        score: g.score || '0:0',
        minute: g.minute,
        matchStatus: g.matchStatus,
        sources: ['state-model'],
        fragility,
        flipRisk: Math.round(flipRisk * 1000) / 10,
        _isLive: true,
      });
    }
  }

  // Sort by confidence * edge (prioritize both)
  picks.sort((a, b) => {
    const scoreA = a.edge * (a.confidence / 100);
    const scoreB = b.edge * (b.confidence / 100);
    return scoreB - scoreA;
  });

  const result: LiveValueResult = {
    picks,
    count: picks.length,
    highConfidence: picks.filter(p => p.confidence >= 60).length,
    withPinnacle: 0, // state-model doesn't use pinnacle
    scrapedAt: new Date().toISOString(),
    analysisSources: ['state-model'],
  };

  cache = result;
  cacheTime = Date.now();

  broadcastPicks(picks.map(p => ({
    eventId: p.eventId,
    marketId: p.marketId,
    outcomeId: p.outcomeId,
    specifier: p.specifier,
    home: p.home,
    away: p.away,
    league: p.league,
    market: p.market,
    pick: p.pick,
    odds: p.odds,
    evPct: p.edge,
    score: p.score,
    minute: p.minute,
    source: 'live-value',
  })));

  logger.info({
    totalPicks: picks.length,
    highConfidence: result.highConfidence,
    elapsed: Date.now() - startMs,
  }, 'Live value picks computed (state-model)');

  return result;
}

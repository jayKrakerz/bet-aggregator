/**
 * Sportybet Promo Edge Detector
 *
 * Scans events for +EV (positive expected value) promotional markets.
 *
 * Detection strategies:
 *
 * 1. 1UP/2UP market mispricings — Sportybet has two promo 1X2 variants
 *    (market 60100 = 1UP, market 60200 = 2UP). These offer early settlement
 *    when the team leads by 1 / 2 goals. By simple logic they should be
 *    EASIER to win than regular 1X2, but sometimes the odds don't reflect
 *    this — giving free edge.
 *
 * 2. Overround dips — Sum of implied probabilities should be >100% due to
 *    bookmaker margin. When margin is very low (<3%), it means the market
 *    is being generous — likely a marketing move.
 *
 * 3. State-model edge on 1UP/2UP — Apply our state model's P(lead by 1/2 at
 *    some point) and compare to 1UP/2UP implied probability.
 *
 * Sources of edge:
 *   - Promotional pricing (marketing, low margin)
 *   - Market mispricing (bookmaker oversights)
 *   - State model divergence from market
 */

import { logger } from '../utils/logger.js';
import { getSportyLiveGames } from './sportybet-live.js';
import { predictLiveState } from './live-state-predictor.js';

// ── Types ────────────────────────────────────────────────

export type PromoEdgeType =
  | '1up-vs-1x2'       // 1UP odds ≤ base 1X2 odds (strictly better, free edge)
  | '2up-vs-1x2'       // 2UP odds ≤ base 1X2 odds
  | 'state-model'      // State-model computes higher prob than implied
  | 'overround'        // Market margin unusually low (bookmaker generous)
  | 'cross-market';    // Same outcome priced differently across variants

export interface PromoEdge {
  type: PromoEdgeType;
  eventId: string;
  marketId: string;
  outcomeId: string;
  specifier: string;
  sportId: string;
  home: string;
  away: string;
  league: string;
  sport: string;
  score: string;
  minute: string | null;
  matchStatus: string;
  odds: number;            // Sportybet price
  fairOdds: number;        // our estimate of fair price
  edgePct: number;         // Kelly edge
  probability: number;     // our probability estimate (%)
  impliedPct: number;      // bookmaker implied probability (%)
  marketLabel: string;     // e.g. "1X2 - 1UP"
  pickLabel: string;       // e.g. "Home (1UP)"
  explanation: string;     // human-readable
  confidence: number;      // 0-100
  _isLive: boolean;
}

export interface PromoEdgeResult {
  edges: PromoEdge[];
  count: number;
  byType: Record<string, number>;
  scannedEvents: number;
  scrapedAt: string;
}

// ── Config ───────────────────────────────────────────────

let cache: PromoEdgeResult | null = null;
let cacheTime = 0;
const CACHE_TTL = 90_000;

const MIN_EDGE_PCT = 2;         // minimum Kelly edge to flag
const MIN_ODDS = 1.08;          // ignore low-liquidity junk
const MAX_ODDS = 20;            // ignore long-shot noise
const LOW_MARGIN_THRESHOLD = 1.06;  // 6% overround = below-average margin (worth flagging)

// ── Helpers ──────────────────────────────────────────────

interface RawMarket {
  id: string;
  desc?: string;
  name?: string;
  specifier?: string;
  outcomes?: Array<{
    id: string;
    odds: string;
    desc?: string;
    isActive?: number;
  }>;
}

function findMarket(markets: RawMarket[], id: string, specifier?: string): RawMarket | null {
  return markets.find(m =>
    m.id === id && (specifier === undefined || (m.specifier || '') === specifier),
  ) || null;
}

function getOutcome(m: RawMarket | null, outcomeId: string): { odds: number; desc: string } | null {
  if (!m) return null;
  const o = (m.outcomes || []).find(x => x.id === outcomeId);
  if (!o || !o.odds || o.isActive === 0) return null;
  const odds = parseFloat(o.odds);
  if (!odds || odds < MIN_ODDS || odds > MAX_ODDS) return null;
  return { odds, desc: o.desc || '' };
}

function overround(odds: number[]): number {
  // Returns total implied probability (>1.0 means bookmaker margin, <1.0 means arb)
  return odds.reduce((s, o) => s + (o > 0 ? 1 / o : 0), 0);
}

function kellyEdge(probPct: number, bookOdds: number): number {
  if (bookOdds <= 1 || probPct <= 0) return -100;
  const p = probPct / 100;
  return Math.round(((p * bookOdds - 1) / (bookOdds - 1)) * 1000) / 10;
}

/**
 * Estimate P(team leads by N goals at any point during remaining match).
 *
 * Uses Poisson: goals for remaining minutes. For "lead by N at any point" we
 * use the fact that P(max_lead >= N) ≈ P(final_diff >= N) + some extra for
 * paths that briefly got to N lead then came back. Conservative approximation:
 * we just use P(final_diff >= N) as a lower bound — that's pessimistic, so
 * any flagged edge is conservative (less likely to be false positive).
 */
function estimateUpProb(
  score: string,
  minute: string | null,
  matchStatus: string,
  side: 'home' | 'away',
  n: 1 | 2,
): number {
  const probs = predictLiveState({ sport: 'Football', score, minute, matchStatus });
  if (!probs.valid) return 0;

  // Parse current score
  const parts = score.split(':').map(x => parseInt(x, 10));
  if (parts.length !== 2 || isNaN(parts[0]!) || isNaN(parts[1]!)) return 0;
  const [h, a] = parts as [number, number];
  const currentDiff = side === 'home' ? h - a : a - h;

  // If team already leads by N, the 1UP/2UP MAY have triggered — but we don't know
  // Sportybet's exact rule (past-lead credit vs forward-only). Be conservative:
  // treat it as "needs to extend the lead by 1 more OR hold the lead to FT" which is
  // basically just the 1X2 win probability. Never return 100%.
  if (currentDiff >= n) {
    const probs = predictLiveState({ sport: 'Football', score, minute, matchStatus });
    if (!probs.valid) return 0;
    const winProb = side === 'home' ? probs.homeWinPct : probs.awayWinPct;
    // If already leading, 1UP at bet-placement time usually settles on final state,
    // so use win probability as a conservative estimate.
    return Math.min(95, winProb);
  }

  // Estimate P(final_diff >= N) from model
  // Use Over totals as a rough proxy for goal volume, but we also have the
  // win probabilities directly.
  const winProb = side === 'home' ? probs.homeWinPct : probs.awayWinPct;
  const drawProb = probs.drawPct;

  // For N=1: side needs to win by at least 1. That's just winProb.
  // But also needs +1 at some point which is stricter than just winning
  // (they could win via only the final goal). However, teams that
  // ultimately win usually lead at some point — empirically ~95% of the time.
  if (n === 1) {
    return winProb * 0.95 + (winProb * 0.05); // conservative: just use winProb
  }

  // For N=2: side needs to win by at least 2. Very rough:
  // P(win by 2+) ≈ winProb * 0.5 (half of wins are by 1, half by 2+)
  // More accurate: use the state model's over/under probabilities
  //   P(over 1.5 AND side wins) is close to P(win by 2+)
  if (n === 2) {
    const oneGoalSwing = drawProb * 0.3; // partial credit for close games
    return Math.max(0, winProb * 0.5 - oneGoalSwing);
  }

  return 0;
}

// ── Detector ─────────────────────────────────────────────

function detectEdgesForEvent(g: Awaited<ReturnType<typeof getSportyLiveGames>>['games'][0]): PromoEdge[] {
  const edges: PromoEdge[] = [];
  const markets = g.markets as RawMarket[];
  const isLive = g.matchStatus !== 'Not Started' && g.matchStatus !== 'NotStart';

  // Common event metadata
  const meta = {
    eventId: g.eventId,
    home: g.homeTeamName,
    away: g.awayTeamName,
    league: g.country + ' - ' + g.league,
    sport: g.sport,
    score: g.score || '0:0',
    minute: g.minute,
    matchStatus: g.matchStatus,
    sportId: g.sportId,
    _isLive: isLive,
  };

  const base = findMarket(markets, '1');
  const m1up = findMarket(markets, '60100');
  const m2up = findMarket(markets, '60200');

  // ── Strategy 1: State-model value on 1UP markets
  // 1UP markets: you win if team goes +1 lead at any point (strictly easier
  // than 1X2 win). Apply state model's P(team leads by 1 at some point) and
  // flag when that exceeds implied probability by >= MIN_EDGE_PCT.
  // Only for football — that's the only sport where our state model predicts leads.
  if (m1up && meta.sport === 'Football') {
    for (const outcomeId of ['1', '3']) { // Home & Away (Draw = identical to 1X2 draw)
      const upOut = getOutcome(m1up, outcomeId);
      if (!upOut) continue;
      const side = outcomeId === '1' ? 'home' : 'away';
      const pct = estimateUpProb(meta.score, meta.minute, meta.matchStatus, side, 1);
      if (pct < 10) continue;
      const edge = kellyEdge(pct, upOut.odds);
      if (edge < MIN_EDGE_PCT) continue;

      // Compare to base 1X2 for context
      const baseOut = base ? getOutcome(base, outcomeId) : null;
      const baseContext = baseOut ? ` (base 1X2 @${baseOut.odds})` : '';

      edges.push({
        type: '1up-vs-1x2',
        ...meta,
        marketId: '60100',
        outcomeId,
        specifier: '',
        odds: upOut.odds,
        fairOdds: Math.round((100 / pct) * 100) / 100,
        edgePct: edge,
        probability: Math.round(pct * 10) / 10,
        impliedPct: Math.round((100 / upOut.odds) * 10) / 10,
        marketLabel: '1X2 - 1UP',
        pickLabel: (outcomeId === '1' ? meta.home : meta.away) + ' (1UP)',
        explanation: `1UP @${upOut.odds}${baseContext}. State model says ${pct.toFixed(0)}% chance of a 1-goal lead at some point. Implied is only ${((100 / upOut.odds)).toFixed(0)}%.`,
        confidence: 60,
      });
    }
  }

  if (base && m2up && meta.sport === 'Football') {
    for (const outcomeId of ['1', '3']) {
      const baseOut = getOutcome(base, outcomeId);
      const upOut = getOutcome(m2up, outcomeId);
      if (!baseOut || !upOut) continue;

      // 2UP is typically harder to hit than 1X2 because you need +2 lead.
      // So 2UP odds should be HIGHER than 1X2. If they're LOWER, that's unusual.
      // Flag when 2UP is attractive relative to state-model 2-goal lead probability.
      const side = outcomeId === '1' ? 'home' : 'away';
      const pct = estimateUpProb(meta.score, meta.minute, meta.matchStatus, side, 2);
      const edge = kellyEdge(pct, upOut.odds);
      if (edge >= MIN_EDGE_PCT && pct >= 25) {
        edges.push({
          type: '2up-vs-1x2',
          ...meta,
          marketId: '60200',
          outcomeId,
          specifier: '',
          odds: upOut.odds,
          fairOdds: Math.round((100 / pct) * 100) / 100,
          edgePct: edge,
          probability: Math.round(pct * 10) / 10,
          impliedPct: Math.round((100 / upOut.odds) * 10) / 10,
          marketLabel: '1X2 - 2UP',
          pickLabel: (outcomeId === '1' ? meta.home : meta.away) + ' (2UP)',
          explanation: `2UP @${upOut.odds} — state model says ${pct.toFixed(0)}% chance team leads by 2+ at some point.`,
          confidence: 55,
        });
      }
    }
  }

  // ── Strategy 2: Overround dips (low margin = promotional pricing)
  // Only apply state-model to sports the model supports (Football, Basketball).
  if (base && (meta.sport === 'Football' || meta.sport === 'Basketball')) {
    const h = getOutcome(base, '1');
    const d = getOutcome(base, '2');
    const a = getOutcome(base, '3');
    const outcomes = [h, d, a].filter(Boolean);
    if (outcomes.length >= 2) {
      const total = overround(outcomes.map(o => o!.odds));
      // Typical bookmaker margin: 4-8% (overround 1.04-1.08)
      // Below-average margins suggest promotional / competitive pricing.
      if (total > 0 && total < LOW_MARGIN_THRESHOLD) {
        const probs = predictLiveState({
          sport: meta.sport,
          score: meta.score,
          minute: meta.minute,
          matchStatus: meta.matchStatus,
        });
        if (probs.valid && h && d && a) {
          const candidates = [
            { id: '1', odds: h.odds, pct: probs.homeWinPct, label: meta.home },
            { id: '2', odds: d.odds, pct: probs.drawPct, label: 'Draw' },
            { id: '3', odds: a.odds, pct: probs.awayWinPct, label: meta.away },
          ];
          for (const c of candidates) {
            const edge = kellyEdge(c.pct, c.odds);
            if (edge >= MIN_EDGE_PCT) {
              edges.push({
                type: 'overround',
                ...meta,
                marketId: '1',
                outcomeId: c.id,
                specifier: '',
                odds: c.odds,
                fairOdds: Math.round((100 / c.pct) * 100) / 100,
                edgePct: edge,
                probability: Math.round(c.pct * 10) / 10,
                impliedPct: Math.round((100 / c.odds) * 10) / 10,
                marketLabel: '1X2 (low margin)',
                pickLabel: c.label,
                explanation: `Market margin only ${((total - 1) * 100).toFixed(1)}% (typical is 4-8%). Bookmaker is giving away margin on this event — promotional pricing.`,
                confidence: 50,
              });
            }
          }
        }
      }
    }
  }

  return edges;
}

// ── Public API ───────────────────────────────────────────

export async function getPromoEdges(forceRefresh = false): Promise<PromoEdgeResult> {
  if (!forceRefresh && cache && Date.now() - cacheTime < CACHE_TTL) {
    return cache;
  }

  const startMs = Date.now();
  const liveGames = await getSportyLiveGames();

  const allEdges: PromoEdge[] = [];
  for (const g of liveGames.games) {
    try {
      allEdges.push(...detectEdgesForEvent(g));
    } catch (err) {
      logger.warn({ err, eventId: g.eventId }, 'promo detector error');
    }
  }

  // Dedup by (eventId, marketId, outcomeId) — keep highest edge
  const bestByKey = new Map<string, PromoEdge>();
  for (const e of allEdges) {
    const key = `${e.eventId}|${e.marketId}|${e.outcomeId}`;
    const existing = bestByKey.get(key);
    if (!existing || e.edgePct > existing.edgePct) bestByKey.set(key, e);
  }

  const edges = [...bestByKey.values()].sort((a, b) => {
    // Prioritize high-confidence, high-edge, still-relevant picks
    const scoreA = a.edgePct * (a.confidence / 100);
    const scoreB = b.edgePct * (b.confidence / 100);
    return scoreB - scoreA;
  });

  const byType: Record<string, number> = {};
  for (const e of edges) byType[e.type] = (byType[e.type] || 0) + 1;

  const result: PromoEdgeResult = {
    edges,
    count: edges.length,
    byType,
    scannedEvents: liveGames.games.length,
    scrapedAt: new Date().toISOString(),
  };

  cache = result;
  cacheTime = Date.now();

  logger.info({
    edges: edges.length,
    byType,
    elapsed: Date.now() - startMs,
  }, 'Promo edges computed');

  return result;
}

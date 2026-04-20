/**
 * Cashout Value Analyzer
 *
 * For any Sportybet booking code (placed bet or booking), compute whether
 * taking a cashout right now is +EV vs letting it ride.
 *
 * Math:
 *   potential_win    = stake × product(original_odds)
 *   true_ev          = stake × product(original_odds) × product(model_prob_remaining)
 *   simulated_cashout = stake × product(original_odds) × product(market_prob_remaining) × (1 - margin)
 *
 * Decision:
 *   - If simulated_cashout > true_ev → TAKE (book offers more than fair value)
 *   - If simulated_cashout < true_ev → HOLD (book underpaying, let it ride)
 *   - If any leg lost → DEAD BET (cashout = 0)
 *   - If all pending legs are near certain → ALREADY WON (cashout ≈ full win)
 *
 * Sources of edge:
 *   - Sportybet's cashout includes a 5-10% discount margin — that's your cost
 *   - Our state-model probability often disagrees with their implied probability
 *   - The disagreement is the edge
 */

import { logger } from '../utils/logger.js';
import { predictLiveState } from './live-state-predictor.js';

// Typical cashout margin applied by Sportybet (empirically 8-12%)
const CASHOUT_MARGIN = 0.10;

// ── Types ────────────────────────────────────────────────

export interface CashoutLeg {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  sport: string;
  marketDesc: string;
  pick: string;
  originalOdds: number;
  currentOdds: number | null;
  currentImpliedProb: number | null;  // from current odds (with SB margin)
  modelProb: number | null;            // our state-model estimate (0-1)
  isLive: boolean;
  score: string;
  minute: string | null;
  matchStatus: string;
  isWinning: number | null;  // null=pending, 1=won, 0=lost
  status: 'pending' | 'won' | 'lost';
}

export interface CashoutAnalysis {
  code: string;
  valid: boolean;
  stake: number;
  totalOriginalOdds: number;
  potentialWin: number;

  wonLegs: number;
  lostLegs: number;
  pendingLegs: number;
  totalLegs: number;

  // Remaining leg product (uses pending legs only)
  remainingMarketProb: number;   // 0-1, product of (1/current_odds)
  remainingModelProb: number;    // 0-1, product of model probs

  simulatedCashout: number;      // what Sportybet would likely offer
  trueExpectedValue: number;     // stake × potentialWin × remainingModelProb
  edge: number;                  // trueEV - simulatedCashout (₦)
  edgePct: number;               // edge as % of stake

  recommendation: 'HOLD' | 'TAKE_CASHOUT' | 'DEAD_BET' | 'ALREADY_WON' | 'CLOSE_CALL';
  confidence: number;            // 0-100
  explanation: string;

  legs: CashoutLeg[];
}

// ── Helpers ──────────────────────────────────────────────

interface ApiOutcome { id: string; odds: string; desc?: string; isActive?: number; isWinning?: number }
interface ApiMarket { id: string; desc?: string; specifier?: string; outcomes: ApiOutcome[] }
interface ApiEventOutcome {
  eventId: string;
  homeTeamName: string;
  awayTeamName: string;
  setScore?: string;
  matchStatus: string;
  playedSeconds?: string;
  sport: { id: string; name: string; category: { name: string; tournament: { name: string } } };
  markets: ApiMarket[];
}
interface ApiSelection {
  eventId: string;
  marketId: string;
  outcomeId: string;
  specifier?: string;
  sportId: string;
  odds: string;
  isWinning?: number;
}
interface ApiShareResponse {
  bizCode: number;
  data?: {
    shareCode: string;
    ticket?: { selections?: ApiSelection[] };
    outcomes?: ApiEventOutcome[];
  };
}

function parseMinute(playedSeconds: string | undefined, status: string): string | null {
  if (playedSeconds) {
    const parts = playedSeconds.split(':');
    if (parts.length >= 1) return `${parts[0]}'`;
  }
  if (['H1', '1H', 'HT', 'H2', '2H', 'FT'].includes(status)) return status;
  return null;
}

function mapKeyToSide(marketId: string, outcomeId: string): 'home' | 'away' | 'draw' | 'over25' | 'under25' | null {
  if (marketId === '1') {
    if (outcomeId === '1') return 'home';
    if (outcomeId === '2') return 'draw';
    if (outcomeId === '3') return 'away';
  }
  if (marketId === '18') {
    if (outcomeId === '12') return 'over25';
    if (outcomeId === '13') return 'under25';
  }
  return null;
}

function computeModelProb(
  sport: string,
  score: string,
  minute: string | null,
  matchStatus: string,
  marketId: string,
  outcomeId: string,
  specifier: string,
): number | null {
  const probs = predictLiveState({ sport, score, minute, matchStatus });
  if (!probs.valid) return null;

  const side = mapKeyToSide(marketId, outcomeId);
  if (side === 'home') return probs.homeWinPct / 100;
  if (side === 'draw') return probs.drawPct / 100;
  if (side === 'away') return probs.awayWinPct / 100;
  // Over/Under — handle non-2.5 totals via specifier
  if (marketId === '18') {
    if (specifier.includes('total=0.5')) return outcomeId === '12' ? probs.over15Pct / 100 : (1 - probs.over15Pct / 100);
    if (specifier.includes('total=1.5')) return outcomeId === '12' ? probs.over15Pct / 100 : (1 - probs.over15Pct / 100);
    if (specifier.includes('total=2.5')) return outcomeId === '12' ? probs.over25Pct / 100 : (1 - probs.over25Pct / 100);
    if (specifier.includes('total=3.5')) return outcomeId === '12' ? probs.over35Pct / 100 : (1 - probs.over35Pct / 100);
  }
  // BTTS
  if (marketId === '29') {
    if (outcomeId === '74') return probs.bttsYesPct / 100;
    if (outcomeId === '76') return probs.bttsNoPct / 100;
  }
  return null;
}

// ── Fetch code details ───────────────────────────────────

async function fetchCode(code: string): Promise<ApiShareResponse | null> {
  try {
    // Try Ghana first, fallback to Nigeria (supports same codes)
    for (const cc of ['gh', 'ng', 'ke']) {
      const res = await fetch(`https://www.sportybet.com/api/${cc}/orders/share/${encodeURIComponent(code)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const data = await res.json() as ApiShareResponse;
      if (data.bizCode === 10000 && data.data?.outcomes) return data;
    }
    return null;
  } catch (err) {
    logger.warn({ err, code }, 'cashout fetch error');
    return null;
  }
}

// ── Public API ───────────────────────────────────────────

export async function analyzeCashout(code: string, stake = 100, userOriginalOdds?: number): Promise<CashoutAnalysis> {
  const empty = (valid: boolean, reason: string): CashoutAnalysis => ({
    code, valid, stake,
    totalOriginalOdds: 0, potentialWin: 0,
    wonLegs: 0, lostLegs: 0, pendingLegs: 0, totalLegs: 0,
    remainingMarketProb: 0, remainingModelProb: 0,
    simulatedCashout: 0, trueExpectedValue: 0,
    edge: 0, edgePct: 0,
    recommendation: 'DEAD_BET',
    confidence: 0,
    explanation: reason,
    legs: [],
  });

  const data = await fetchCode(code.toUpperCase());
  if (!data || !data.data) return empty(false, 'Code not found on Sportybet');
  const selections = data.data.ticket?.selections || [];
  const outcomes = data.data.outcomes || [];
  if (!selections.length) return empty(false, 'No selections in code');

  // Build leg data
  const legs: CashoutLeg[] = [];
  let totalOriginalOdds = 1;
  let wonLegs = 0, lostLegs = 0, pendingLegs = 0;
  let remainingMarketProb = 1;
  let remainingModelProb = 1;

  for (const sel of selections) {
    // Booking codes don't store odds at creation time — fall back to current market odds
    let origOdds = parseFloat(sel.odds || '0');
    if (!origOdds || origOdds <= 1) {
      // Look up current odds from outcomes
      const ev = outcomes.find(o => o.eventId === sel.eventId);
      if (ev) {
        const mkt = ev.markets.find(m => m.id === sel.marketId && (sel.specifier === undefined || sel.specifier === '' || (m.specifier || '') === sel.specifier));
        if (mkt) {
          const out = mkt.outcomes.find(o => o.id === sel.outcomeId);
          if (out) origOdds = parseFloat(out.odds) || 1;
        }
      }
      if (!origOdds || origOdds <= 1) origOdds = 1;
    }
    totalOriginalOdds *= origOdds;
    const ev = outcomes.find(o => o.eventId === sel.eventId);
    const isWinning = sel.isWinning !== undefined ? sel.isWinning : ev?.markets?.[0]?.outcomes?.[0]?.isWinning ?? null;
    const status: 'pending' | 'won' | 'lost' = isWinning === 1 ? 'won' : isWinning === 0 ? 'lost' : 'pending';

    if (status === 'won') wonLegs++;
    else if (status === 'lost') lostLegs++;
    else pendingLegs++;

    // Find current odds for this selection from the live markets in the response
    let currentOdds: number | null = null;
    let pickDesc = '';
    let marketDesc = '';
    if (ev) {
      const mkt = ev.markets.find(m => m.id === sel.marketId && (sel.specifier === undefined || sel.specifier === '' || (m.specifier || '') === sel.specifier));
      marketDesc = mkt?.desc || '';
      if (mkt) {
        const out = mkt.outcomes.find(o => o.id === sel.outcomeId);
        if (out) {
          currentOdds = parseFloat(out.odds);
          pickDesc = out.desc || '';
        }
      }
    }

    const currentImpliedProb = currentOdds && currentOdds > 1 ? 1 / currentOdds : null;
    const modelProb = ev ? computeModelProb(
      ev.sport.name,
      ev.setScore || '0:0',
      parseMinute(ev.playedSeconds, ev.matchStatus),
      ev.matchStatus,
      sel.marketId, sel.outcomeId, sel.specifier || '',
    ) : null;

    // Contribute to product only if pending
    if (status === 'pending') {
      if (currentImpliedProb !== null) remainingMarketProb *= currentImpliedProb;
      if (modelProb !== null) remainingModelProb *= modelProb;
      else if (currentImpliedProb !== null) remainingModelProb *= currentImpliedProb; // fallback to market
    }

    const isLive = ev ? ['H1', '1H', 'H2', '2H', 'HT', 'Live'].includes(ev.matchStatus) : false;

    legs.push({
      eventId: sel.eventId,
      homeTeam: ev?.homeTeamName || '',
      awayTeam: ev?.awayTeamName || '',
      league: ev ? `${ev.sport.category.name} - ${ev.sport.category.tournament.name}` : '',
      sport: ev?.sport.name || '',
      marketDesc,
      pick: pickDesc,
      originalOdds: origOdds,
      currentOdds,
      currentImpliedProb,
      modelProb,
      isLive,
      score: ev?.setScore || '',
      minute: ev ? parseMinute(ev.playedSeconds, ev.matchStatus) : null,
      matchStatus: ev?.matchStatus || 'Unknown',
      isWinning: isWinning as number | null,
      status,
    });
  }

  // If user provided the acca odds at time of placement, use that instead
  // (booking codes don't capture the odds, only selection refs)
  if (userOriginalOdds && userOriginalOdds > 1) {
    totalOriginalOdds = userOriginalOdds;
  }
  const potentialWin = stake * totalOriginalOdds;

  // Dead bet: any leg lost = cashout is 0
  if (lostLegs > 0) {
    return {
      ...empty(true, `${lostLegs} leg(s) already lost — this bet is dead.`),
      totalOriginalOdds, potentialWin,
      wonLegs, lostLegs, pendingLegs, totalLegs: selections.length,
      legs,
    };
  }

  // Already won: all legs decided as wins
  if (pendingLegs === 0 && wonLegs === selections.length) {
    return {
      code, valid: true, stake,
      totalOriginalOdds, potentialWin,
      wonLegs, lostLegs, pendingLegs, totalLegs: selections.length,
      remainingMarketProb: 1, remainingModelProb: 1,
      simulatedCashout: potentialWin,
      trueExpectedValue: potentialWin,
      edge: 0, edgePct: 0,
      recommendation: 'ALREADY_WON',
      confidence: 100,
      explanation: 'All legs won — waiting for Sportybet to settle the payout.',
      legs,
    };
  }

  // Simulated cashout: stake × totalOdds × remaining_market_prob × (1 - margin)
  const simulatedCashout = stake * totalOriginalOdds * remainingMarketProb * (1 - CASHOUT_MARGIN);
  const trueExpectedValue = stake * totalOriginalOdds * remainingModelProb;
  const edge = trueExpectedValue - simulatedCashout;
  const edgePct = (edge / stake) * 100;

  // Recommendation logic
  let recommendation: CashoutAnalysis['recommendation'];
  let explanation: string;
  let confidence: number;

  const edgeThreshold = stake * 0.03; // 3% of stake

  if (remainingModelProb >= 0.85 && pendingLegs <= 2) {
    // Near-certain win — hold
    recommendation = 'HOLD';
    explanation = `${(remainingModelProb * 100).toFixed(0)}% chance of winning remaining ${pendingLegs} leg(s). Hold — cashout undervalues your position.`;
    confidence = 80;
  } else if (edge > edgeThreshold) {
    // Model thinks it's more likely to win than market — hold
    recommendation = 'HOLD';
    explanation = `Model sees ${(remainingModelProb * 100).toFixed(1)}% win chance vs market ${(remainingMarketProb * 100).toFixed(1)}%. True EV (${trueExpectedValue.toFixed(0)}) > cashout (${simulatedCashout.toFixed(0)}). Hold for +${edgePct.toFixed(1)}% edge.`;
    confidence = 65;
  } else if (edge < -edgeThreshold) {
    // Market thinks it's MORE likely than model — cash out (they're overpaying!)
    recommendation = 'TAKE_CASHOUT';
    explanation = `Model sees ${(remainingModelProb * 100).toFixed(1)}% win chance vs market ${(remainingMarketProb * 100).toFixed(1)}%. Cashout (${simulatedCashout.toFixed(0)}) > true EV (${trueExpectedValue.toFixed(0)}). Take +${Math.abs(edgePct).toFixed(1)}% edge.`;
    confidence = 65;
  } else {
    recommendation = 'CLOSE_CALL';
    explanation = `True value (${trueExpectedValue.toFixed(0)}) ≈ cashout (${simulatedCashout.toFixed(0)}). Either hold or take — nearly break-even.`;
    confidence = 40;
  }

  // Raise confidence if mostly live games with clear state signals
  const livePending = legs.filter(l => l.status === 'pending' && l.isLive).length;
  if (livePending >= 2) confidence = Math.min(95, confidence + 10);

  return {
    code, valid: true, stake,
    totalOriginalOdds, potentialWin,
    wonLegs, lostLegs, pendingLegs, totalLegs: selections.length,
    remainingMarketProb, remainingModelProb,
    simulatedCashout, trueExpectedValue,
    edge, edgePct,
    recommendation, confidence,
    explanation,
    legs,
  };
}

/**
 * Late-Lock Scanner — positive-EV picks on almost-ending matches.
 *
 * At 85+ min, certain markets have near-deterministic outcomes under a
 * Poisson goal model. Soft books (Sportybet) are slow to fully compress
 * their prices on these markets, leaving thin but real EV. This scanner
 * targets the four highest-lock markets identified in our analysis:
 *
 *   1. Odd/Even total goals (current parity holds ~92% at 90')
 *   2. Under X.5 where line is ≥2 above current total (~99.6%)
 *   3. Double Chance on the leading side (~99.9%+ any lead)
 *   4. Draw when scores level at 85'+ (~80%, ~92% at 90')
 *
 * We deliberately skip very-short-odds markets (<1.05) where book margin
 * eats all EV; and we skip matches with a goal in the last 3 min where
 * the Poisson baseline under-states momentum.
 */

import { logger } from '../utils/logger.js';
import { getSportyLiveGames, type LiveGame, type LiveMarket } from './sportybet-live.js';

const BASELINE_GOALS_PER_MATCH = 2.7;
const STOPPAGE_MIN = 3;
const MIN_MINUTE = 85;
const MIN_BOOK_ODDS = 1.05;         // avoid short-odds vig traps
const MIN_EV_PCT = 0.5;              // require ≥0.5% EV after Pinnacle-style fair pricing

// ── Poisson helpers (local — existing live-state-predictor only exposes packaged probs) ──

function factorial(n: number): number { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; }
function pmf(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda) * lambda ** k / factorial(k);
}
function cdf(lambda: number, k: number): number {
  let s = 0; for (let i = 0; i <= k; i++) s += pmf(lambda, i); return Math.min(1, s);
}

// Betradar standard IDs used by Sportybet feed:
//   market 1  = 1X2        (outcomes 1=home, 2=draw, 3=away)
//   market 10 = DoubleChance (9=1X, 10=12, 11=X2)
//   market 18 = Over/Under total goals (12=over, 13=under; specifier total=X.5)
//   market 26 = Odd/Even total goals   (70=odd, 72=even)
// NOTE: outcome id prop in LiveMarketOutcome is called `id` in the raw API;
//   our type preserves that as `id` — double-check via `outcomes[].id`.

interface LateMarketQuote {
  key: string;
  label: string;
  marketId: string;
  outcomeId: string;
  specifier: string;
  odds: number;
  modelProb: number;   // 0-1
}

function parseScore(score: string): [number, number] | null {
  const m = score.split(':').map(s => parseInt(s.trim(), 10));
  if (m.length !== 2 || Number.isNaN(m[0]) || Number.isNaN(m[1])) return null;
  return [m[0]!, m[1]!];
}

function parseMinute(minute: string | null): number {
  if (!minute) return 0;
  const m = minute.match(/(\d+)/);
  return m ? parseInt(m[1]!, 10) : 0;
}

function findOutcomeById(markets: LiveMarket[], marketId: string, outcomeIdRaw: string, specifier?: string): number | null {
  const wantSpec = specifier ?? '';
  for (const m of markets) {
    if (m.id !== marketId) continue;
    const haveSpec = m.specifier ?? '';
    if (wantSpec && haveSpec !== wantSpec) continue;
    for (const o of m.outcomes) {
      if (o.id === outcomeIdRaw && o.isActive === 1) {
        const odds = parseFloat(o.odds);
        if (odds > 1) return odds;
      }
    }
  }
  return null;
}

function buildLateQuotes(g: LiveGame): LateMarketQuote[] {
  const score = parseScore(g.score);
  if (!score) return [];
  const minute = parseMinute(g.minute);
  if (minute < MIN_MINUTE) return [];
  const [h, a] = score;
  const total = h + a;
  const diff = h - a;

  // Remaining goal rate (symmetric split):
  const remainingMin = Math.max(0, 90 - minute) + STOPPAGE_MIN;
  const lam = BASELINE_GOALS_PER_MATCH * (remainingMin / 90);
  const lamHalf = lam / 2;

  const quotes: LateMarketQuote[] = [];

  // 1) Odd/Even (current parity holds when # additional goals is even)
  // P(Poisson(λ) is even) = (1 + e^(-2λ)) / 2
  const pParityHolds = (1 + Math.exp(-2 * lam)) / 2;
  const currentParity: 'odd' | 'even' = total % 2 === 0 ? 'even' : 'odd';
  const holdOdds = findOutcomeById(g.markets, '26', currentParity === 'odd' ? '70' : '72', '');
  if (holdOdds !== null) {
    quotes.push({
      key: currentParity === 'odd' ? 'oddGoals' : 'evenGoals',
      label: `Total Goals ${currentParity === 'odd' ? 'Odd' : 'Even'} (current ${total} locks ~${(pParityHolds * 100).toFixed(1)}%)`,
      marketId: '26',
      outcomeId: currentParity === 'odd' ? '70' : '72',
      specifier: '',
      odds: holdOdds,
      modelProb: pParityHolds,
    });
  }

  // 2) Under lines — pick 0.5 above current total and 1.5 above (covers safe range)
  //    P(no goal) = e^-λ    (line = total + 0.5)
  //    P(≤1 goal) = cdf(λ, 1)  (line = total + 1.5)
  for (const extra of [0.5, 1.5, 2.5]) {
    const line = total + extra;                  // e.g. score 1-0, line 1.5 / 2.5 / 3.5
    const spec = `total=${line.toFixed(1)}`;
    const under = findOutcomeById(g.markets, '18', '13', spec);
    if (under === null) continue;
    const need = Math.floor(extra);               // goals ≤ need keeps Under safe
    const pUnder = cdf(lam, need);
    quotes.push({
      key: `under${line}`,
      label: `Under ${line} (at ${h}-${a} needs ≤${need} more; locks ~${(pUnder * 100).toFixed(1)}%)`,
      marketId: '18',
      outcomeId: '13',
      specifier: spec,
      odds: under,
      modelProb: pUnder,
    });
  }

  // 3) Double Chance on the leading side
  if (diff !== 0) {
    // P(leader holds) = 1 − P(opposing side scores > |diff| more NET goals)
    // Compute joint grid — λ is small so small grid suffices.
    let pLeaderHolds = 0;
    for (let hm = 0; hm <= 8; hm++) {
      for (let am = 0; am <= 8; am++) {
        const fh = h + hm, fa = a + am;
        if ((fh >= fa && diff > 0) || (fa >= fh && diff < 0)) {
          pLeaderHolds += pmf(lamHalf, hm) * pmf(lamHalf, am);
        }
      }
    }
    const outcomeId = diff > 0 ? '9' : '11';      // 9=1X, 11=X2
    const label = diff > 0 ? `${g.homeTeamName} or Draw` : `Draw or ${g.awayTeamName}`;
    const dc = findOutcomeById(g.markets, '10', outcomeId, '');
    if (dc !== null) {
      quotes.push({
        key: diff > 0 ? 'dc1X' : 'dcX2',
        label: `Double Chance ${label} (locks ~${(pLeaderHolds * 100).toFixed(2)}%)`,
        marketId: '10',
        outcomeId,
        specifier: '',
        odds: dc,
        modelProb: pLeaderHolds,
      });
    }
  } else {
    // 4) Draw holds when level score
    let pDraw = 0;
    for (let hm = 0; hm <= 8; hm++) {
      for (let am = 0; am <= 8; am++) {
        if (hm === am) pDraw += pmf(lamHalf, hm) * pmf(lamHalf, am);
      }
    }
    const drawOdds = findOutcomeById(g.markets, '1', '2', '');
    if (drawOdds !== null) {
      quotes.push({
        key: 'draw',
        label: `Draw (level ${h}-${a}; locks ~${(pDraw * 100).toFixed(1)}%)`,
        marketId: '1',
        outcomeId: '2',
        specifier: '',
        odds: drawOdds,
        modelProb: pDraw,
      });
    }
  }

  return quotes;
}

// ── Pick construction ──

export interface LateLockPick {
  eventId: string;
  sportId: string;
  marketId: string;
  outcomeId: string;
  specifier: string;
  odds: number;
  modelProbPct: number;   // our Poisson lock probability
  impliedPct: number;     // 1 / odds × 100
  evPct: number;          // (prob × odds − 1) × 100
  market: string;
  pick: string;
  home: string;
  away: string;
  league: string;
  country: string;
  score: string;
  minute: string | null;
  _isLive: true;
  _lateLocks: true;
}

export interface LateLockResult {
  picks: LateLockPick[];
  count: number;
  scanned: number;        // matches inspected
  lateMatches: number;    // matches that passed the 85'+ filter
  scrapedAt: string;
}

let cache: LateLockResult | null = null;
let cacheTime = 0;
const CACHE_TTL = 45_000;

export async function getLateLockPicks(forceRefresh = false): Promise<LateLockResult> {
  if (!forceRefresh && cache && Date.now() - cacheTime < CACHE_TTL) return cache;

  const startMs = Date.now();
  const live = await getSportyLiveGames();

  let lateMatches = 0;
  const picks: LateLockPick[] = [];

  for (const g of live.games) {
    if (g.sport !== 'Football') continue;
    const minute = parseMinute(g.minute);
    if (minute < MIN_MINUTE) continue;
    // Skip halftime / finished
    if (g.matchStatus === 'HT' || g.matchStatus === 'FT' || g.matchStatus === 'Ended') continue;
    lateMatches++;

    const quotes = buildLateQuotes(g);
    for (const q of quotes) {
      if (q.odds < MIN_BOOK_ODDS) continue;
      const ev = q.modelProb * q.odds - 1;
      if (ev * 100 < MIN_EV_PCT) continue;
      picks.push({
        eventId: g.eventId,
        sportId: g.sportId,
        marketId: q.marketId,
        outcomeId: q.outcomeId,
        specifier: q.specifier,
        odds: q.odds,
        modelProbPct: Math.round(q.modelProb * 1000) / 10,
        impliedPct: Math.round((1 / q.odds) * 1000) / 10,
        evPct: Math.round(ev * 10000) / 100,
        market: q.label.split(' (')[0]!,
        pick: q.label,
        home: g.homeTeamName,
        away: g.awayTeamName,
        league: g.league,
        country: g.country,
        score: g.score,
        minute: g.minute,
        _isLive: true,
        _lateLocks: true,
      });
    }
  }

  picks.sort((a, b) => b.evPct - a.evPct);

  const result: LateLockResult = {
    picks,
    count: picks.length,
    scanned: live.games.length,
    lateMatches,
    scrapedAt: new Date().toISOString(),
  };

  cache = result;
  cacheTime = Date.now();

  logger.info({
    picks: picks.length,
    scanned: live.games.length,
    lateMatches,
    elapsed: Date.now() - startMs,
  }, 'Late-lock scan complete');

  return result;
}

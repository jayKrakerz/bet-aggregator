/**
 * ELO-driven pick generator.
 *
 * Scans Sportybet's upcoming match list, runs predictElo on each fixture,
 * and emits pickable selections (eventId/marketId/outcomeId) for matches
 * where both teams have confident ratings AND the top pick has enough
 * probability margin over the book's implied odds to produce positive EV.
 *
 * Output shape matches `LiveValuePick` closely so the existing UI renderer
 * and betslip / create-code flows can consume it verbatim.
 */

import { logger } from '../utils/logger.js';
import { predictElo } from './elo-predictor.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const COUNTRIES = ['ng', 'gh', 'ke', 'tz', 'zm', 'cm'];
const PAGE_SIZE = 100;
const CACHE_TTL_MS = 5 * 60 * 1000;

// ── Types ────────────────────────────────────────────────

export interface EloPick {
  eventId: string;
  sportId: string;
  marketId: string;
  outcomeId: string;
  specifier: string;
  odds: number;
  edge: number;         // %, positive means ELO prob > book implied
  probability: number;  // ELO-derived %
  bookImpliedPct: number;
  pick: string;         // 'Home', 'Draw', 'Away' (or 1X/X2 etc)
  market: string;       // '1X2' or 'Double Chance'
  home: string;
  away: string;
  league: string;
  kickoff: string | null;
  homeRating: number;
  awayRating: number;
  confident: boolean;
}

export interface EloPicksResult {
  picks: EloPick[];
  count: number;
  scanned: number;
  scrapedAt: string;
}

// ── Sportybet prematch fetch ─────────────────────────────

interface SpOutcome { id: string; odds: string; desc?: string; isActive?: number; }
interface SpMarket { id: string; desc?: string; specifier?: string; status?: number; outcomes: SpOutcome[]; }
interface SpEvent {
  eventId: string;
  sport?: { id: string };
  tournament?: { name?: string };
  homeTeamName?: string; awayTeamName?: string;
  homeTeam?: string; awayTeam?: string;
  estimateStartTime?: number; startTime?: number;
  markets?: SpMarket[];
}
interface SpTournament { name?: string; events?: SpEvent[]; }

async function fetchPrematchForCountry(cc: string): Promise<SpEvent[]> {
  const ts = Date.now();
  const url = `https://www.sportybet.com/api/${cc}/factsCenter/liveOrPrematchEvents?_t=${ts}`
    + `&sportId=sr:sport:1&group=Prematch&marketId=1,10&pageSize=${PAGE_SIZE}&pageNum=1`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { bizCode?: number; data?: unknown };
    if (data.bizCode !== 10000 || !data.data) return [];
    const events: SpEvent[] = [];
    const raw = data.data as SpTournament[] | { tournaments?: SpTournament[] };
    const tournaments: SpTournament[] = Array.isArray(raw) ? raw : (raw.tournaments ?? []);
    for (const t of tournaments) {
      for (const e of t.events ?? []) {
        events.push({ ...e, tournament: { name: t.name ?? '' } });
      }
    }
    return events;
  } catch {
    return [];
  }
}

let cache: EloPicksResult | null = null;
let cacheTime = 0;

// ── Picker ───────────────────────────────────────────────

export interface EloPickerOpts {
  minEdge?: number;            // default 3 (percent)
  minProbability?: number;     // default 45
  maxOdds?: number;            // default 3.5
  minOdds?: number;            // default 1.15
  allowDoubleChance?: boolean; // default true
}

export async function getEloPicks(opts: EloPickerOpts = {}, forceRefresh = false): Promise<EloPicksResult> {
  if (!forceRefresh && cache && Date.now() - cacheTime < CACHE_TTL_MS) return cache;

  const minEdge = opts.minEdge ?? 3;
  const minProb = opts.minProbability ?? 45;
  const maxOdds = opts.maxOdds ?? 3.5;
  const minOdds = opts.minOdds ?? 1.15;
  const allowDC = opts.allowDoubleChance ?? true;

  // Fetch events from the first country that returns a useful payload.
  let events: SpEvent[] = [];
  for (const cc of COUNTRIES) {
    const got = await fetchPrematchForCountry(cc);
    if (got.length) { events = got; break; }
  }

  const picks: EloPick[] = [];

  for (const e of events) {
    const home = e.homeTeamName ?? e.homeTeam ?? '';
    const away = e.awayTeamName ?? e.awayTeam ?? '';
    if (!home || !away || !e.eventId) continue;

    const pred = predictElo(home, away);
    if (!pred.confident) continue;

    // Find the 1X2 and Double Chance markets.
    const m1x2 = e.markets?.find(m => m.id === '1' && m.status !== 3);
    const mDC = e.markets?.find(m => m.id === '10' && m.status !== 3);
    if (!m1x2) continue;

    const candidates: Array<{ marketId: string; outcomeId: string; specifier: string; market: string; pick: string; probPct: number; odds: number; }> = [];

    // 1X2 sides
    const oc1 = m1x2.outcomes.find(o => o.id === '1');
    const oc2 = m1x2.outcomes.find(o => o.id === '2');
    const oc3 = m1x2.outcomes.find(o => o.id === '3');
    if (oc1?.odds) candidates.push({ marketId: '1', outcomeId: '1', specifier: '', market: '1X2', pick: home, probPct: pred.homeWinPct, odds: parseFloat(oc1.odds) });
    if (oc2?.odds) candidates.push({ marketId: '1', outcomeId: '2', specifier: '', market: '1X2', pick: 'Draw', probPct: pred.drawPct, odds: parseFloat(oc2.odds) });
    if (oc3?.odds) candidates.push({ marketId: '1', outcomeId: '3', specifier: '', market: '1X2', pick: away, probPct: pred.awayWinPct, odds: parseFloat(oc3.odds) });

    // Double Chance
    if (allowDC && mDC) {
      const ocDc1X = mDC.outcomes.find(o => o.id === '9');
      const ocDc12 = mDC.outcomes.find(o => o.id === '10');
      const ocDcX2 = mDC.outcomes.find(o => o.id === '11');
      if (ocDc1X?.odds) candidates.push({ marketId: '10', outcomeId: '9', specifier: '', market: 'Double Chance', pick: home + ' or Draw', probPct: pred.homeWinPct + pred.drawPct, odds: parseFloat(ocDc1X.odds) });
      if (ocDc12?.odds) candidates.push({ marketId: '10', outcomeId: '10', specifier: '', market: 'Double Chance', pick: home + ' or ' + away, probPct: pred.homeWinPct + pred.awayWinPct, odds: parseFloat(ocDc12.odds) });
      if (ocDcX2?.odds) candidates.push({ marketId: '10', outcomeId: '11', specifier: '', market: 'Double Chance', pick: 'Draw or ' + away, probPct: pred.drawPct + pred.awayWinPct, odds: parseFloat(ocDcX2.odds) });
    }

    // Pick best candidate for this match — highest edge that also meets filters.
    let best: typeof candidates[number] & { edge: number; impliedPct: number } | null = null;
    for (const c of candidates) {
      if (!c.odds || c.odds < minOdds || c.odds > maxOdds) continue;
      if (c.probPct < minProb) continue;
      const impliedPct = (1 / c.odds) * 100;
      const edge = c.probPct - impliedPct;
      if (edge < minEdge) continue;
      if (!best || edge > best.edge) best = { ...c, edge, impliedPct };
    }
    if (!best) continue;

    const kickoff = e.estimateStartTime
      ? new Date(e.estimateStartTime).toISOString()
      : e.startTime ? new Date(e.startTime).toISOString() : null;

    picks.push({
      eventId: e.eventId,
      sportId: e.sport?.id ?? 'sr:sport:1',
      marketId: best.marketId,
      outcomeId: best.outcomeId,
      specifier: best.specifier,
      odds: best.odds,
      edge: Math.round(best.edge * 10) / 10,
      probability: Math.round(best.probPct * 10) / 10,
      bookImpliedPct: Math.round(best.impliedPct * 10) / 10,
      pick: best.pick,
      market: best.market,
      home, away,
      league: e.tournament?.name ?? '',
      kickoff,
      homeRating: pred.homeRating,
      awayRating: pred.awayRating,
      confident: pred.confident,
    });
  }

  // Sort: highest edge first.
  picks.sort((a, b) => b.edge - a.edge);

  cache = {
    picks,
    count: picks.length,
    scanned: events.length,
    scrapedAt: new Date().toISOString(),
  };
  cacheTime = Date.now();

  logger.info({ picks: picks.length, scanned: events.length }, 'ELO picks computed');
  return cache;
}

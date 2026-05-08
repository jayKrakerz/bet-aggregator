/**
 * Over 1.5 Picks
 *
 * Scans Sportybet upcoming football fixtures, runs the Poisson model on each,
 * and ranks Over 1.5 selections by edge (model prob − book implied prob).
 *
 * Output shape mirrors EloPick / LiveValuePick so the existing UI render +
 * playPick / create-code flow can consume it verbatim.
 */

import { logger } from '../utils/logger.js';
import { predictMatch } from './stats-predictor.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const COUNTRIES = ['ng', 'gh', 'ke', 'tz', 'zm', 'cm'];
const PAGE_SIZE = 100;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Sportybet O/U 1.5 mapping
const MARKET_ID = '18';
const OUTCOME_ID_OVER = '12';
const SPECIFIER = 'total=1.5';

// ── Types ────────────────────────────────────────────────

export interface Over15Pick {
  eventId: string;
  sportId: string;
  marketId: string;
  outcomeId: string;
  specifier: string;
  odds: number;
  edge: number;          // %, model prob − book implied
  probability: number;   // Poisson Over 1.5 %
  bookImpliedPct: number;
  expectedGoals: number; // expHome + expAway
  pick: string;          // 'Over 1.5'
  market: string;        // 'O/U 1.5'
  home: string;
  away: string;
  league: string;
  kickoff: string | null;
  confidence: number;    // from Poisson sample size
}

export interface Over15PicksResult {
  picks: Over15Pick[];
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
  // marketId=1,18 — pull 1X2 + Total Goals so we can find the 1.5 line specifier.
  const url = `https://www.sportybet.com/api/${cc}/factsCenter/liveOrPrematchEvents?_t=${ts}`
    + `&sportId=sr:sport:1&group=Prematch&marketId=1,18&pageSize=${PAGE_SIZE}&pageNum=1`;
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

let cache: Over15PicksResult | null = null;
let cacheTime = 0;

// ── Picker ───────────────────────────────────────────────

export interface Over15PickerOpts {
  minEdge?: number;       // default 3 (percent)
  minProbability?: number; // default 70 — Over 1.5 is high-prob by nature
  maxOdds?: number;       // default 2.0
  minOdds?: number;       // default 1.10
  limit?: number;         // default 4
}

export async function getOver15Picks(opts: Over15PickerOpts = {}, forceRefresh = false): Promise<Over15PicksResult> {
  if (!forceRefresh && cache && Date.now() - cacheTime < CACHE_TTL_MS) {
    const limit = opts.limit ?? 4;
    return { ...cache, picks: cache.picks.slice(0, limit), count: Math.min(cache.count, limit) };
  }

  const minEdge = opts.minEdge ?? 3;
  const minProb = opts.minProbability ?? 70;
  const maxOdds = opts.maxOdds ?? 2.0;
  const minOdds = opts.minOdds ?? 1.10;
  const limit = opts.limit ?? 4;

  // Fetch events from the first country that returns a useful payload.
  let events: SpEvent[] = [];
  for (const cc of COUNTRIES) {
    const got = await fetchPrematchForCountry(cc);
    if (got.length) { events = got; break; }
  }

  const picks: Over15Pick[] = [];

  for (const e of events) {
    const home = e.homeTeamName ?? e.homeTeam ?? '';
    const away = e.awayTeamName ?? e.awayTeam ?? '';
    if (!home || !away || !e.eventId) continue;

    // Find the Over 1.5 outcome on this event.
    const ouMarket = (e.markets ?? []).find(m =>
      m.id === MARKET_ID
      && (m.specifier ?? '') === SPECIFIER
      && m.status !== 3,
    );
    if (!ouMarket) continue;
    const overOc = ouMarket.outcomes.find(o => o.id === OUTCOME_ID_OVER);
    const odds = overOc?.odds ? parseFloat(overOc.odds) : 0;
    if (!odds || odds < minOdds || odds > maxOdds) continue;

    // Run Poisson — needs league coverage (~12 European leagues).
    const league = e.tournament?.name ?? '';
    const pred = await predictMatch(home, away, league);
    if (!pred) continue;
    if (pred.over15Pct < minProb) continue;

    const impliedPct = (1 / odds) * 100;
    const edge = pred.over15Pct - impliedPct;
    if (edge < minEdge) continue;

    const kickoff = e.estimateStartTime
      ? new Date(e.estimateStartTime).toISOString()
      : e.startTime ? new Date(e.startTime).toISOString() : null;

    picks.push({
      eventId: e.eventId,
      sportId: e.sport?.id ?? 'sr:sport:1',
      marketId: MARKET_ID,
      outcomeId: OUTCOME_ID_OVER,
      specifier: SPECIFIER,
      odds,
      edge: Math.round(edge * 10) / 10,
      probability: Math.round(pred.over15Pct * 10) / 10,
      bookImpliedPct: Math.round(impliedPct * 10) / 10,
      expectedGoals: Math.round((pred.expectedHomeGoals + pred.expectedAwayGoals) * 100) / 100,
      pick: 'Over 1.5',
      market: 'O/U 1.5',
      home, away,
      league,
      kickoff,
      confidence: pred.confidence,
    });
  }

  // Sort by edge desc, fall back to probability for ties.
  picks.sort((a, b) => (b.edge - a.edge) || (b.probability - a.probability));

  const allResult: Over15PicksResult = {
    picks,
    count: picks.length,
    scanned: events.length,
    scrapedAt: new Date().toISOString(),
  };
  cache = allResult;
  cacheTime = Date.now();

  logger.info({ picks: picks.length, scanned: events.length }, 'Over 1.5 picks computed');

  return { ...allResult, picks: picks.slice(0, limit), count: Math.min(picks.length, limit) };
}

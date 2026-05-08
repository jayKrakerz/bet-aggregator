/**
 * SRL Fixtures
 *
 * Pulls Sportybet's Simulated Reality League fixtures from the football
 * sport (sr:sport:1) and filters to category sr:category:2123. Each SRL
 * tournament shows up with a ` SRL` suffix (e.g. "Premier League SRL").
 *
 * Important quirks vs real football:
 *   - SRL matches play in ~12 real minutes, so events tagged group=Prematch
 *     are often already in-progress (matchStatus=H1, playedSeconds set).
 *     There is no real prematch window — first sighting IS the snapshot.
 *   - The API exposes the engine's own `probability` per outcome. That's
 *     the bookie's TRUE probability (engine computed). Bookie margin =
 *     1/odds - probability. Lets us de-vig exactly, not by power method.
 *   - No plain BTTS market — derive from "1X2 & GG/NG" (market id 35).
 */

import { logger } from '../utils/logger.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const COUNTRIES = ['ng', 'gh', 'ke', 'tz', 'zm', 'cm'];
const PAGE_SIZE = 100;
const SRL_CATEGORY_ID = 'sr:category:2123';

// Sportybet market IDs we care about.
const M_1X2 = '1';
const M_OU = '18';
const M_1X2_GG = '35'; // combined 1X2 & GG/NG → derive BTTS
const SPEC_OU_25 = 'total=2.5';

// 1X2 outcome IDs
const O_HOME = '1';
const O_DRAW = '2';
const O_AWAY = '3';

// O/U outcome IDs
const O_OVER = '12';
const O_UNDER = '13';

// ── Types ────────────────────────────────────────────────

interface SpOutcome {
  id: string;
  desc?: string;
  odds: string;
  probability?: string;
  isActive?: number;
}
interface SpMarket {
  id: string;
  desc?: string;
  specifier?: string;
  status?: number;
  outcomes: SpOutcome[];
}
interface SpEvent {
  eventId: string;
  estimateStartTime?: number;
  startTime?: number;
  status?: number;
  setScore?: string;
  matchStatus?: string;
  playedSeconds?: string;
  homeTeamName?: string;
  awayTeamName?: string;
  sport?: {
    id?: string;
    category?: { id?: string; name?: string; tournament?: { name?: string } };
  };
  markets?: SpMarket[];
}
interface SpTournament {
  name?: string;
  events?: SpEvent[];
}

export interface SrlOutcome {
  /** Bookie offered decimal odds */
  odds: number;
  /** Bookie's true probability (engine output, 0-1). null if engine omitted it. */
  trueProb: number | null;
  /** 1/odds — what naive bettor sees as implied probability */
  impliedProb: number;
  /** isActive flag — selection is bettable */
  active: boolean;
  /** SB outcome ID for code creation */
  outcomeId: string;
}

export interface SrlMarketSet {
  /** 1X2 home/draw/away */
  home: SrlOutcome | null;
  draw: SrlOutcome | null;
  away: SrlOutcome | null;
  /** Over/Under 2.5 line */
  over25: SrlOutcome | null;
  under25: SrlOutcome | null;
  /** Both Teams To Score derived from "1X2 & GG/NG" combined market.
   *  trueProb is summed engine probability across (Home/Draw/Away & yes). */
  bttsYes: SrlOutcome | null;
  bttsNo: SrlOutcome | null;
}

export interface SrlFixture {
  eventId: string;
  sportId: string;
  tournamentName: string;        // raw, e.g. "Copa Libertadores SRL"
  realLeague: string;            // stripped, e.g. "Copa Libertadores"
  homeRaw: string;               // "Always Ready SRL"
  awayRaw: string;               // "CA Lanus Srl"
  homeReal: string;              // "Always Ready"
  awayReal: string;              // "CA Lanus"
  estimateStartTime: number | null;
  setScore: string | null;       // "2:1" if in-progress / final
  matchStatus: string | null;    // H1, H2, FT, Ended, NotStarted
  playedSeconds: string | null;  // "43:07"
  isInProgress: boolean;         // status is live (H1/H2/HT)
  isFinished: boolean;           // status is FT/Ended
  markets: SrlMarketSet;
  /** Sum of engine probabilities for 1X2 — should be ~1.0; quality check. */
  engineSum1x2: number | null;
  /** Bookmaker margin on 1X2 in percentage points (impliedSum - 1) * 100. */
  marginPct1x2: number | null;
  /** Bookmaker margin on O/U 2.5 line. */
  marginPctOu25: number | null;
}

// ── SRL name handling ────────────────────────────────────

/** Strip SRL suffixes/markers from a team name, leaving the real-world name. */
export function stripSrl(name: string): string {
  return (name || '')
    .replace(/\s*\bSRL\b\s*$/i, '')
    .replace(/\s*\(SRL\)\s*$/i, '')
    .replace(/\s+Srl\s*$/i, '')
    .replace(/\s*Sim\b\s*$/i, '')
    .trim();
}

function stripSrlLeague(name: string): string {
  return (name || '')
    .replace(/\s+SRL\b/gi, '')
    .replace(/\s+\(SRL\)/gi, '')
    .replace(/\s+Sim\b/gi, '')
    .trim();
}

// ── Outcome parsing ──────────────────────────────────────

function parseOutcome(o: SpOutcome | undefined): SrlOutcome | null {
  if (!o) return null;
  const odds = parseFloat(o.odds || '0');
  if (!odds || odds < 1.01) return null;
  let trueProb: number | null = null;
  const p = o.probability ? parseFloat(o.probability) : NaN;
  // SB sometimes returns "0E-10" (zero in scientific form) for derived
  // markets — treat as missing rather than zero so we don't pretend the
  // engine said the outcome is impossible.
  if (Number.isFinite(p) && p > 0 && p < 1) trueProb = p;
  return {
    odds,
    trueProb,
    impliedProb: 1 / odds,
    active: o.isActive === 1,
    outcomeId: o.id,
  };
}

function findMarket(e: SpEvent, id: string, spec?: string): SpMarket | null {
  return (e.markets || []).find(m =>
    m.id === id && (spec === undefined || (m.specifier ?? '') === spec) && m.status !== 3,
  ) || null;
}

function deriveBtts(e: SpEvent): { yes: SrlOutcome | null; no: SrlOutcome | null } {
  // Combined "1X2 & GG/NG" — outcome IDs 78=H&y, 80=H&n, 82=D&y, 84=D&n, 86=A&y, 88=A&n.
  // BTTS yes prob = sum of engine probs on _&y outcomes.
  // BTTS yes odds = no clean single price; we instead compute fair odds = 1 / yesProb.
  const m = findMarket(e, M_1X2_GG);
  if (!m) return { yes: null, no: null };
  let pYes = 0;
  let pNo = 0;
  let havePYes = false;
  let havePNo = false;
  for (const o of m.outcomes) {
    const p = parseFloat(o.probability || '0');
    if (!Number.isFinite(p) || p <= 0) continue;
    if (['78', '82', '86'].includes(o.id)) { pYes += p; havePYes = true; }
    else if (['80', '84', '88'].includes(o.id)) { pNo += p; havePNo = true; }
  }
  if (!havePYes && !havePNo) return { yes: null, no: null };
  // Renormalize within the BTTS bucket so margin shows up as fair-odds inflation.
  const total = pYes + pNo;
  const trueYes = total > 0 ? pYes / total : null;
  const trueNo = total > 0 ? pNo / total : null;
  // We don't have a clean BTTS bookmaker price here — leave odds null
  // (predictor will fall back to the engine probability for value math).
  return {
    yes: trueYes !== null ? { odds: trueYes > 0 ? 1 / trueYes : 0, trueProb: trueYes, impliedProb: trueYes, active: true, outcomeId: 'derived' } : null,
    no: trueNo !== null ? { odds: trueNo > 0 ? 1 / trueNo : 0, trueProb: trueNo, impliedProb: trueNo, active: true, outcomeId: 'derived' } : null,
  };
}

function buildMarketSet(e: SpEvent): SrlMarketSet {
  const m1 = findMarket(e, M_1X2);
  const home = m1 ? parseOutcome(m1.outcomes.find(o => o.id === O_HOME)) : null;
  const draw = m1 ? parseOutcome(m1.outcomes.find(o => o.id === O_DRAW)) : null;
  const away = m1 ? parseOutcome(m1.outcomes.find(o => o.id === O_AWAY)) : null;

  const mou = findMarket(e, M_OU, SPEC_OU_25);
  const over25 = mou ? parseOutcome(mou.outcomes.find(o => o.id === O_OVER)) : null;
  const under25 = mou ? parseOutcome(mou.outcomes.find(o => o.id === O_UNDER)) : null;

  const btts = deriveBtts(e);
  return { home, draw, away, over25, under25, bttsYes: btts.yes, bttsNo: btts.no };
}

function classifyStatus(s?: string | null): { live: boolean; finished: boolean } {
  if (!s) return { live: false, finished: false };
  const u = s.toUpperCase();
  if (u === 'NOT_STARTED' || u === 'NOTSTARTED') return { live: false, finished: false };
  if (['FT', 'ENDED', 'AET', 'AP', 'AB'].includes(u)) return { live: false, finished: true };
  return { live: true, finished: false };
}

// ── Fetching ─────────────────────────────────────────────

async function fetchOnceForCountry(cc: string, group: 'Prematch' | 'Live', marketId: string): Promise<SpEvent[]> {
  const ts = Date.now();
  const url = `https://www.sportybet.com/api/${cc}/factsCenter/liveOrPrematchEvents?_t=${ts}`
    + `&sportId=sr:sport:1&group=${group}&marketId=${marketId}&pageSize=${PAGE_SIZE}&pageNum=1`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { bizCode?: number; data?: unknown };
    if (data.bizCode !== 10000 || !data.data) return [];
    const out: SpEvent[] = [];
    const raw = data.data as SpTournament[] | { tournaments?: SpTournament[] };
    const tournaments: SpTournament[] = Array.isArray(raw) ? raw : (raw.tournaments ?? []);
    for (const t of tournaments) {
      const tname = (t.name ?? '').toLowerCase();
      // SRL tournament names always end with " SRL" (case insensitive).
      if (!tname.includes('srl') && !tname.includes('simulated')) continue;
      for (const e of t.events ?? []) {
        // Belt-and-braces: also check the category id on the event itself.
        const catId = e.sport?.category?.id ?? '';
        if (catId && catId !== SRL_CATEGORY_ID) continue;
        out.push(e);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Fetch SRL fixtures (both prematch and live), merging by eventId.
 * Live fetch wins for status fields (setScore/playedSeconds change as the
 * match runs); prematch fetch wins for market completeness.
 *
 * We pull marketId=1 (which returns ALL markets in practice — SB's API
 * ignores the filter for SRL) so we get 1X2 + O/U 2.5 + BTTS in one shot.
 */
export async function fetchSrlFixtures(): Promise<SrlFixture[]> {
  const byId = new Map<string, SpEvent>();

  for (const cc of COUNTRIES) {
    const pre = await fetchOnceForCountry(cc, 'Prematch', '1');
    if (pre.length === 0) continue;
    for (const e of pre) byId.set(e.eventId, e);
    // Live overlay — surfaces freshly-finished matches with final setScore.
    const live = await fetchOnceForCountry(cc, 'Live', '1');
    for (const e of live) {
      const existing = byId.get(e.eventId);
      // Prefer live event's status fields, but keep prematch markets if live
      // returns a thinner set (which it sometimes does after late-period suspensions).
      if (existing && (e.markets?.length || 0) < (existing.markets?.length || 0)) {
        byId.set(e.eventId, { ...existing, setScore: e.setScore, matchStatus: e.matchStatus, playedSeconds: e.playedSeconds, status: e.status });
      } else {
        byId.set(e.eventId, e);
      }
    }
    if (byId.size > 0) break;
  }

  const fixtures: SrlFixture[] = [];
  for (const e of byId.values()) {
    const home = e.homeTeamName ?? '';
    const away = e.awayTeamName ?? '';
    if (!home || !away || !e.eventId) continue;

    const tournamentName = e.sport?.category?.tournament?.name ?? '';
    const cls = classifyStatus(e.matchStatus);
    const markets = buildMarketSet(e);

    const engineSum1x2 = (markets.home?.trueProb || 0) + (markets.draw?.trueProb || 0) + (markets.away?.trueProb || 0);
    const impliedSum1x2 = (markets.home?.impliedProb || 0) + (markets.draw?.impliedProb || 0) + (markets.away?.impliedProb || 0);
    const marginPct1x2 = impliedSum1x2 > 0 ? (impliedSum1x2 - 1) * 100 : null;

    const impliedSumOu = (markets.over25?.impliedProb || 0) + (markets.under25?.impliedProb || 0);
    const marginPctOu25 = impliedSumOu > 0 ? (impliedSumOu - 1) * 100 : null;

    fixtures.push({
      eventId: e.eventId,
      sportId: e.sport?.id ?? 'sr:sport:1',
      tournamentName,
      realLeague: stripSrlLeague(tournamentName),
      homeRaw: home,
      awayRaw: away,
      homeReal: stripSrl(home),
      awayReal: stripSrl(away),
      estimateStartTime: e.estimateStartTime ?? e.startTime ?? null,
      setScore: e.setScore || null,
      matchStatus: e.matchStatus || null,
      playedSeconds: e.playedSeconds || null,
      isInProgress: cls.live,
      isFinished: cls.finished,
      markets,
      engineSum1x2: engineSum1x2 > 0 ? engineSum1x2 : null,
      marginPct1x2,
      marginPctOu25,
    });
  }

  logger.info({ count: fixtures.length }, 'SRL fixtures fetched');
  return fixtures;
}

/**
 * Per-event lookup. Used as the settle fallback: SB's grouped fetch
 * drops finished events from Live/Prematch listings before we ever see
 * matchStatus=Ended, so we have to poll each open snapshot directly.
 *
 * Returns a slimmed result that's enough to detect a settle. We do NOT
 * try to rebuild full markets here — by the time a match is finished,
 * the markets are suspended anyway, so they'd be useless for snapshotting.
 */
export interface SrlEventResult {
  eventId: string;
  setScore: string | null;
  matchStatus: string | null;
  isFinished: boolean;
  isInProgress: boolean;
  /** True if the event lookup itself failed (404 / non-10000 biz code). Caller may want to retry later. */
  notFound: boolean;
}

export async function fetchSrlEventResult(eventId: string): Promise<SrlEventResult> {
  for (const cc of COUNTRIES) {
    const ts = Date.now();
    const url = `https://www.sportybet.com/api/${cc}/factsCenter/event?eventId=${encodeURIComponent(eventId)}&_t=${ts}`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = (await res.json()) as { bizCode?: number; data?: { matchStatus?: string; setScore?: string } };
      if (data.bizCode !== 10000 || !data.data) continue;
      const cls = classifyStatus(data.data.matchStatus);
      return {
        eventId,
        setScore: data.data.setScore || null,
        matchStatus: data.data.matchStatus || null,
        isFinished: cls.finished,
        isInProgress: cls.live,
        notFound: false,
      };
    } catch {
      // try next country
    }
  }
  return { eventId, setScore: null, matchStatus: null, isFinished: false, isInProgress: false, notFound: true };
}

// ── Cache wrapper ────────────────────────────────────────

let cache: { fixtures: SrlFixture[]; at: number } | null = null;
const CACHE_TTL = 30 * 1000; // 30s — SRL matches turn over fast

export async function getSrlFixtures(forceRefresh = false): Promise<SrlFixture[]> {
  if (!forceRefresh && cache && Date.now() - cache.at < CACHE_TTL) return cache.fixtures;
  const fixtures = await fetchSrlFixtures();
  cache = { fixtures, at: Date.now() };
  return fixtures;
}

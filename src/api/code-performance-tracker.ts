/**
 * Booking Code Performance Tracker
 *
 * Tracks win/loss/ROI stats for scraped booking codes by checking
 * their status via the Sportybet API. Aggregates by source, odds range,
 * and market type.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { getAllBookingCodes, type BookingCode } from './booking-codes-scraper.js';
import { getStats as getConsensusStats } from './consensus-tracker.js';

// ── Historical archive ─────────────────────────────────────
//
// The booking codes disk cache in booking-codes-scraper is a 2-hour
// rolling snapshot, so computing stats directly over it gives a
// ~2-hour-wide track record. This archive appends every newly-settled
// code (keyed by code string, so duplicates are idempotent) and lets
// getCodePerformance() compute stats over months of history.

const ARCHIVE_FILE = path.join(process.cwd(), 'data', 'code_archive.json');
const MAX_ARCHIVE_ENTRIES = 10_000;

interface ArchivedCode {
  code: string;
  source: string;
  totalOdds: number;
  won: boolean;
  legs: number;
  selections: Array<{
    homeTeam: string;
    awayTeam: string;
    league: string;
    market: string;
    pick: string;
    odds: number;
    isWinning: number | null;
    score: string | null;
  }>;
  settledAt: number;
}

let archive: Map<string, ArchivedCode> | null = null;

function loadArchive(): Map<string, ArchivedCode> {
  try {
    if (fs.existsSync(ARCHIVE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8')) as ArchivedCode[];
      if (Array.isArray(raw)) return new Map(raw.map((c) => [c.code, c]));
    }
  } catch (err) {
    logger.warn({ err }, 'Code archive: failed to load — starting fresh');
  }
  return new Map();
}

function saveArchive(): void {
  if (!archive) return;
  try {
    fs.mkdirSync(path.dirname(ARCHIVE_FILE), { recursive: true });
    // Keep newest N by settledAt
    const sorted = [...archive.values()].sort((a, b) => b.settledAt - a.settledAt);
    const trimmed = sorted.slice(0, MAX_ARCHIVE_ENTRIES);
    fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(trimmed));
    if (trimmed.length < sorted.length) {
      archive = new Map(trimmed.map((c) => [c.code, c]));
    }
  } catch (err) {
    logger.warn({ err }, 'Code archive: failed to save');
  }
}

function archiveCode(c: BookingCode, won: boolean): void {
  if (!archive) archive = loadArchive();
  archive.set(c.code, {
    code: c.code,
    source: c.source,
    totalOdds: c.totalOdds || 0,
    won,
    legs: c.selections.length,
    selections: c.selections.map((s) => ({
      homeTeam: s.homeTeam,
      awayTeam: s.awayTeam,
      league: s.league,
      market: s.market,
      pick: s.pick,
      odds: s.odds,
      isWinning: s.isWinning,
      score: s.score,
    })),
    settledAt: Date.now(),
  });
}

// ── Bayesian shrinkage ─────────────────────────────────────
//
// Same Beta(5, 5) prior as consensus-tracker: new buckets start at 0.5
// and move toward the observed rate as evidence accumulates. Prevents a
// bucket with 1/1 wins from looking like a 100% edge.
const PRIOR_WINS = 5;
const PRIOR_TOTAL = 10;

function shrunkRate(won: number, lost: number): number {
  const total = won + lost;
  return Math.round(((won + PRIOR_WINS) / (total + PRIOR_TOTAL)) * 1000) / 10;
}

// ── Types ──────────────────────────────────────────────────

interface SourceStats {
  source: string;
  total: number;
  won: number;
  lost: number;
  pending: number;
  winRate: number;
  shrunkWinRate: number; // Bayesian-shrunk; use this for weighting
  avgOdds: number;
  roi: number; // assuming $1 flat bet per code
}

interface OddsRangeStats {
  range: string;
  total: number;
  won: number;
  lost: number;
  winRate: number;
  shrunkWinRate: number;
}

interface MarketStats {
  market: string;
  total: number;
  won: number;
  lost: number;
  winRate: number;
  shrunkWinRate: number;
}

export interface CodePerformance {
  summary: {
    totalCodes: number;
    archived: number;     // cumulative settled codes in the persistent archive
    settled: number;
    won: number;
    lost: number;
    pending: number;
    winRate: number;
    shrunkWinRate: number;
    roi: number;
    avgOdds: number;
    bestStreak: number;
    worstStreak: number;
  };
  bySource: SourceStats[];
  byOddsRange: OddsRangeStats[];
  byMarket: MarketStats[];
  recentSettled: Array<{
    code: string;
    source: string;
    totalOdds: number;
    legs: number;
    won: boolean;
    selections: Array<{
      match: string;
      pick: string;
      odds: number;
      score: string | null;
      won: boolean | null;
    }>;
  }>;
  trackedAt: string;
}

// ── Helpers ────────────────────────────────────────────────

function oddsRange(odds: number): string {
  if (odds < 2) return '1.0-1.99';
  if (odds < 3) return '2.0-2.99';
  if (odds < 5) return '3.0-4.99';
  if (odds < 10) return '5.0-9.99';
  return '10+';
}

function isSettled(c: BookingCode): boolean {
  return c.validated && c.isValid && c.pendingCount === 0 && (c.wonCount > 0 || c.lostCount > 0);
}

function isWon(c: BookingCode): boolean {
  return c.lostCount === 0 && c.wonCount > 0 && c.pendingCount === 0;
}

// ── Main tracker ───────────────────────────────────────────

/**
 * Build full performance report from the code archive + current codes.
 *
 * Side effect: every newly-settled code encountered here is appended
 * to the persistent archive so the next call has a longer history.
 */
export async function getCodePerformance(): Promise<CodePerformance> {
  if (!archive) archive = loadArchive();

  const codes = await getAllBookingCodes();

  // Append any freshly-settled codes to the archive so stats span multiple
  // scrape cycles instead of just the last 2 hours.
  let archiveDirty = false;
  for (const c of codes) {
    if (isSettled(c) && !archive.has(c.code)) {
      archiveCode(c, isWon(c));
      archiveDirty = true;
    }
  }
  if (archiveDirty) saveArchive();

  // Pending codes are pulled live from the current scrape (archive has
  // only settled entries by definition).
  const pending = codes.filter((c) => c.validated && c.isValid && c.pendingCount > 0 && c.lostCount === 0);

  // Unified "settled view" = archived codes (long history). We re-expose
  // them as BookingCode-shaped enough for the existing aggregation logic.
  const archivedAsCodes: BookingCode[] = [...archive.values()].map((a) => ({
    code: a.code,
    source: a.source,
    totalOdds: a.totalOdds,
    events: a.legs,
    validated: true,
    isValid: true,
    wonCount: a.won ? 1 : 0,
    lostCount: a.won ? 0 : 1,
    pendingCount: 0,
    selections: a.selections as BookingCode['selections'],
  } as BookingCode));

  const settled = archivedAsCodes;
  const won = settled.filter(isWon);
  const lost = settled.filter((c) => !isWon(c));

  // Overall ROI: assuming $1 flat bet, payout = totalOdds if won, 0 if lost
  const totalStaked = settled.length;
  const totalReturn = won.reduce((sum, c) => sum + (c.totalOdds || 0), 0);
  const roi = totalStaked > 0 ? Math.round(((totalReturn - totalStaked) / totalStaked) * 1000) / 10 : 0;
  const avgOdds = settled.length > 0
    ? Math.round((settled.reduce((s, c) => s + (c.totalOdds || 0), 0) / settled.length) * 100) / 100
    : 0;

  // Streaks
  let bestStreak = 0;
  let worstStreak = 0;
  let curWin = 0;
  let curLose = 0;
  for (const c of settled) {
    if (isWon(c)) {
      curWin++;
      curLose = 0;
      bestStreak = Math.max(bestStreak, curWin);
    } else {
      curLose++;
      curWin = 0;
      worstStreak = Math.max(worstStreak, curLose);
    }
  }

  // By source — merge archive (settled) + current live codes (pending)
  const srcMap = new Map<string, { total: number; won: number; lost: number; pending: number; oddsSum: number; returnSum: number }>();

  const touchSrc = (source: string) =>
    srcMap.get(source) || { total: 0, won: 0, lost: 0, pending: 0, oddsSum: 0, returnSum: 0 };

  for (const c of settled) {
    const s = touchSrc(c.source);
    s.total++;
    s.oddsSum += c.totalOdds || 0;
    if (isWon(c)) {
      s.won++;
      s.returnSum += c.totalOdds || 0;
    } else {
      s.lost++;
    }
    srcMap.set(c.source, s);
  }
  for (const c of pending) {
    const s = touchSrc(c.source);
    s.total++;
    s.oddsSum += c.totalOdds || 0;
    s.pending++;
    srcMap.set(c.source, s);
  }

  const bySource: SourceStats[] = [...srcMap.entries()]
    .map(([source, s]) => ({
      source,
      total: s.total,
      won: s.won,
      lost: s.lost,
      pending: s.pending,
      winRate: (s.won + s.lost) > 0 ? Math.round((s.won / (s.won + s.lost)) * 1000) / 10 : 0,
      shrunkWinRate: shrunkRate(s.won, s.lost),
      avgOdds: s.total > 0 ? Math.round((s.oddsSum / s.total) * 100) / 100 : 0,
      roi: (s.won + s.lost) > 0 ? Math.round(((s.returnSum - (s.won + s.lost)) / (s.won + s.lost)) * 1000) / 10 : 0,
    }))
    // Sort by shrunk rate — naive winRate rewards tiny samples
    .sort((a, b) => b.shrunkWinRate - a.shrunkWinRate);

  // By odds range
  const rangeMap = new Map<string, { total: number; won: number; lost: number }>();
  for (const c of settled) {
    const range = oddsRange(c.totalOdds || 0);
    const s = rangeMap.get(range) || { total: 0, won: 0, lost: 0 };
    s.total++;
    if (isWon(c)) s.won++;
    else s.lost++;
    rangeMap.set(range, s);
  }

  const byOddsRange: OddsRangeStats[] = [...rangeMap.entries()]
    .map(([range, s]) => ({
      range,
      total: s.total,
      won: s.won,
      lost: s.lost,
      winRate: s.total > 0 ? Math.round((s.won / s.total) * 1000) / 10 : 0,
      shrunkWinRate: shrunkRate(s.won, s.lost),
    }))
    .sort((a, b) => {
      const order = ['1.0-1.99', '2.0-2.99', '3.0-4.99', '5.0-9.99', '10+'];
      return order.indexOf(a.range) - order.indexOf(b.range);
    });

  // By market (from individual selections)
  const mktMap = new Map<string, { total: number; won: number; lost: number }>();
  for (const c of settled) {
    for (const sel of c.selections) {
      const mkt = sel.market || 'Unknown';
      const s = mktMap.get(mkt) || { total: 0, won: 0, lost: 0 };
      s.total++;
      if (sel.isWinning === 1) s.won++;
      else if (sel.isWinning === 0) s.lost++;
      mktMap.set(mkt, s);
    }
  }

  const byMarket: MarketStats[] = [...mktMap.entries()]
    .map(([market, s]) => ({
      market,
      total: s.total,
      won: s.won,
      lost: s.lost,
      winRate: (s.won + s.lost) > 0 ? Math.round((s.won / (s.won + s.lost)) * 1000) / 10 : 0,
      shrunkWinRate: shrunkRate(s.won, s.lost),
    }))
    .sort((a, b) => b.shrunkWinRate - a.shrunkWinRate);

  // Recent settled
  const recentSettled = settled.slice(-20).reverse().map((c) => ({
    code: c.code,
    source: c.source,
    totalOdds: c.totalOdds || 0,
    legs: c.selections.length,
    won: isWon(c),
    selections: c.selections.map((s) => ({
      match: `${s.homeTeam} vs ${s.awayTeam}`,
      pick: `${s.market}: ${s.pick}`,
      odds: s.odds,
      score: s.score,
      won: s.isWinning === 1 ? true : s.isWinning === 0 ? false : null,
    })),
  }));

  return {
    summary: {
      totalCodes: codes.filter((c) => c.validated && c.isValid).length,
      archived: archive.size,
      settled: settled.length,
      won: won.length,
      lost: lost.length,
      pending: pending.length,
      winRate: settled.length > 0 ? Math.round((won.length / settled.length) * 1000) / 10 : 0,
      shrunkWinRate: shrunkRate(won.length, lost.length),
      roi,
      avgOdds,
      bestStreak,
      worstStreak,
    },
    bySource,
    byOddsRange,
    byMarket,
    recentSettled,
    trackedAt: new Date().toISOString(),
  };
}

// ── Learned Weights ────────────────────────────────────────
// Matches the frontend's getLearnedRates() format but computed
// from ALL scraped codes + consensus results (much bigger sample).

interface WL { won: number; lost: number }

function normalizeMarketKey(m: string): string {
  const l = m.toLowerCase();
  if (l.includes('over/under') || l.includes('total')) return 'ou';
  if (l.includes('double chance')) return 'dc';
  if (l.includes('1x2') || l === 'match winner') return '1x2';
  if (l.includes('both teams') || l.includes('gg/ng') || l.includes('btts')) return 'btts';
  if (l.includes('handicap')) return 'hcap';
  if (l.includes('correct score')) return 'cs';
  return l.slice(0, 20);
}

function normalizeLeagueKey(league: string): string {
  if (!league) return '';
  if (league.includes('sr:tournament')) return '';
  const parts = league.split(' - ');
  return (parts[parts.length - 1] || '').toLowerCase().trim();
}

export interface LearnedWeights {
  sampleSize: number;
  byMarket: Record<string, WL>;
  byLeague: Record<string, WL>;
  byOddsBand: Record<string, WL>;
  byPickOdds: Record<string, WL>;
  bySource: Record<string, WL & { avgOdds: number }>;
  consensusByPick: Record<string, WL>;
  consensusBySources: Record<string, WL>;
}

/**
 * Build learned weights from the settled-code archive + consensus results.
 * The frontend merges this with its local codeHistory to make smarter picks.
 *
 * Uses the persistent archive (built by getCodePerformance) so weights
 * reflect months of history, not just the last 2 hours of scrapes.
 */
export async function getLearnedWeights(): Promise<LearnedWeights> {
  // Ensure archive is populated with any brand-new settled codes.
  await getCodePerformance();
  if (!archive) archive = loadArchive();

  const settled: BookingCode[] = [...archive.values()].map((a) => ({
    code: a.code,
    source: a.source,
    totalOdds: a.totalOdds,
    events: a.legs,
    validated: true,
    isValid: true,
    wonCount: a.won ? 1 : 0,
    lostCount: a.won ? 0 : 1,
    pendingCount: 0,
    selections: a.selections as BookingCode['selections'],
  } as BookingCode));

  const byMarket: Record<string, WL> = {};
  const byLeague: Record<string, WL> = {};
  const byOddsBand: Record<string, WL> = {};
  const byPickOdds: Record<string, WL> = {};
  const bySource: Record<string, WL & { avgOdds: number; _oddsSum: number; _count: number }> = {};

  // Per-selection stats from booking codes
  for (const c of settled) {
    // Source-level
    const src = c.source;
    if (!bySource[src]) bySource[src] = { won: 0, lost: 0, avgOdds: 0, _oddsSum: 0, _count: 0 };
    const srcS = bySource[src]!;
    if (isWon(c)) srcS.won++;
    else srcS.lost++;
    srcS._oddsSum += c.totalOdds || 0;
    srcS._count++;

    // Code-level odds band
    const o = c.totalOdds || 0;
    const band = o <= 2 ? 'low' : o <= 5 ? 'mid' : o <= 15 ? 'high' : 'extreme';
    if (!byOddsBand[band]) byOddsBand[band] = { won: 0, lost: 0 };
    if (isWon(c)) byOddsBand[band]!.won++;
    else byOddsBand[band]!.lost++;

    // Per-selection
    for (const sel of c.selections) {
      const mk = normalizeMarketKey(sel.market);
      if (!byMarket[mk]) byMarket[mk] = { won: 0, lost: 0 };
      if (sel.isWinning === 1) byMarket[mk]!.won++;
      else if (sel.isWinning === 0) byMarket[mk]!.lost++;

      const lg = normalizeLeagueKey(sel.league);
      if (lg) {
        if (!byLeague[lg]) byLeague[lg] = { won: 0, lost: 0 };
        if (sel.isWinning === 1) byLeague[lg]!.won++;
        else if (sel.isWinning === 0) byLeague[lg]!.lost++;
      }

      const selOdds = sel.odds || 1;
      const pickBand = selOdds <= 1.20 ? 'very-low' : selOdds <= 1.50 ? 'low' : selOdds <= 2.00 ? 'mid' : 'high';
      if (!byPickOdds[pickBand]) byPickOdds[pickBand] = { won: 0, lost: 0 };
      if (sel.isWinning === 1) byPickOdds[pickBand]!.won++;
      else if (sel.isWinning === 0) byPickOdds[pickBand]!.lost++;
    }
  }

  // Finalize source avgOdds
  for (const s of Object.values(bySource)) {
    const ss = s as WL & { avgOdds: number; _oddsSum: number; _count: number };
    ss.avgOdds = ss._count > 0 ? Math.round((ss._oddsSum / ss._count) * 100) / 100 : 0;
    delete (ss as unknown as Record<string, unknown>)._oddsSum;
    delete (ss as unknown as Record<string, unknown>)._count;
  }

  // Consensus stats
  const cStats = getConsensusStats();
  const consensusByPick: Record<string, WL> = {};
  const consensusBySources: Record<string, WL> = {};
  for (const [pick, stats] of Object.entries(cStats.byPick)) {
    consensusByPick[pick] = { won: stats.won, lost: stats.lost };
  }
  for (const [count, stats] of Object.entries(cStats.bySourceCount)) {
    consensusBySources[count] = { won: stats.won, lost: stats.lost };
  }

  return {
    sampleSize: settled.length,
    byMarket,
    byLeague,
    byOddsBand,
    byPickOdds,
    bySource: bySource as Record<string, WL & { avgOdds: number }>,
    consensusByPick,
    consensusBySources,
  };
}

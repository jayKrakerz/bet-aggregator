/**
 * SRL History
 *
 * Append-only JSONL log of every observed SRL fixture. Each fixture is
 * snapshotted on first sight (snapshot row), then settled when we later
 * see it with a finished matchStatus (settle row). The combined record
 * powers empirical priors (per-league rates, per-team form) and the
 * evaluator (Brier/log-loss/CLV).
 *
 * Storage choice: append-only JSONL keeps writes O(1) and crash-safe; we
 * compact to a final settled-record map in memory. CLAUDE.md forbids a DB,
 * so this stays consistent with the stack.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import type { SrlFixture } from './srl-fixtures.js';

const HISTORY_DIR = path.join(process.cwd(), 'data');
const HISTORY_FILE = path.join(HISTORY_DIR, 'srl-history.jsonl');

// ── Persisted row shapes ─────────────────────────────────

interface SnapshotRow {
  type: 'snap';
  ts: number;
  eventId: string;
  league: string;
  realLeague: string;
  homeReal: string;
  awayReal: string;
  oddsH: number | null;
  oddsD: number | null;
  oddsA: number | null;
  trueH: number | null;
  trueD: number | null;
  trueA: number | null;
  oddsOver25: number | null;
  oddsUnder25: number | null;
  trueOver25: number | null;
  trueUnder25: number | null;
  trueBttsYes: number | null;
}

interface SettleRow {
  type: 'settle';
  ts: number;
  eventId: string;
  homeGoals: number;
  awayGoals: number;
  result: 'H' | 'D' | 'A';
  bttsYes: boolean;
  over25: boolean;
}

type Row = SnapshotRow | SettleRow;

export interface SettledMatch {
  eventId: string;
  league: string;          // raw "Premier League SRL"
  realLeague: string;      // stripped "Premier League"
  homeReal: string;
  awayReal: string;
  snap: SnapshotRow;
  settle: SettleRow;
}

// ── In-memory state ──────────────────────────────────────

const snaps = new Map<string, SnapshotRow>();
const settles = new Map<string, SettleRow>();
let loaded = false;

function ensureDir() {
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

function loadHistory(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;
    const text = fs.readFileSync(HISTORY_FILE, 'utf8');
    let snapCount = 0;
    let settleCount = 0;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as Row;
        if (row.type === 'snap') {
          // Last snapshot per eventId wins (in case we re-snapped pre-game).
          snaps.set(row.eventId, row);
          snapCount++;
        } else if (row.type === 'settle') {
          settles.set(row.eventId, row);
          settleCount++;
        }
      } catch {
        // skip malformed line
      }
    }
    logger.info({ snaps: snapCount, settles: settleCount }, 'SRL history loaded');
  } catch (err) {
    logger.warn({ err }, 'SRL history: failed to load — starting fresh');
  }
}

function appendRow(row: Row): void {
  try {
    ensureDir();
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(row) + '\n');
  } catch (err) {
    logger.warn({ err }, 'SRL history: failed to append');
  }
}

// ── Snapshot + settle from fixture stream ────────────────

/**
 * Process a batch of currently-observed fixtures. New events get a snapshot;
 * finished events that we previously snapshotted get settled.
 *
 * Returns counts of rows written for telemetry.
 */
export function ingestFixtures(fixtures: SrlFixture[]): { snapped: number; settled: number } {
  loadHistory();
  let snapped = 0;
  let settled = 0;

  for (const f of fixtures) {
    // Snapshot if we haven't seen this event yet AND it's not already finished
    // without a snapshot (we can't snapshot retroactively — odds have moved).
    if (!snaps.has(f.eventId) && !f.isFinished) {
      const row: SnapshotRow = {
        type: 'snap',
        ts: Date.now(),
        eventId: f.eventId,
        league: f.tournamentName,
        realLeague: f.realLeague,
        homeReal: f.homeReal,
        awayReal: f.awayReal,
        oddsH: f.markets.home?.odds ?? null,
        oddsD: f.markets.draw?.odds ?? null,
        oddsA: f.markets.away?.odds ?? null,
        trueH: f.markets.home?.trueProb ?? null,
        trueD: f.markets.draw?.trueProb ?? null,
        trueA: f.markets.away?.trueProb ?? null,
        oddsOver25: f.markets.over25?.odds ?? null,
        oddsUnder25: f.markets.under25?.odds ?? null,
        trueOver25: f.markets.over25?.trueProb ?? null,
        trueUnder25: f.markets.under25?.trueProb ?? null,
        trueBttsYes: f.markets.bttsYes?.trueProb ?? null,
      };
      snaps.set(f.eventId, row);
      appendRow(row);
      snapped++;
    }

    // Settle if finished AND we have a final score AND not already settled.
    if (f.isFinished && f.setScore && !settles.has(f.eventId) && snaps.has(f.eventId)) {
      const m = /^(\d+)\s*[:\-]\s*(\d+)$/.exec(f.setScore);
      if (m) {
        const homeGoals = parseInt(m[1]!, 10);
        const awayGoals = parseInt(m[2]!, 10);
        const result: 'H' | 'D' | 'A' = homeGoals > awayGoals ? 'H' : homeGoals < awayGoals ? 'A' : 'D';
        const row: SettleRow = {
          type: 'settle',
          ts: Date.now(),
          eventId: f.eventId,
          homeGoals,
          awayGoals,
          result,
          bttsYes: homeGoals > 0 && awayGoals > 0,
          over25: (homeGoals + awayGoals) > 2,
        };
        settles.set(f.eventId, row);
        appendRow(row);
        settled++;
      }
    }
  }

  if (snapped > 0 || settled > 0) {
    logger.info({ snapped, settled, totalSnaps: snaps.size, totalSettles: settles.size }, 'SRL history ingested');
  }
  return { snapped, settled };
}

/**
 * Settle a single open snapshot from a per-event lookup result. Used by
 * the fallback poller for events that vanished from the grouped fetch
 * before transitioning through an Ended state we could observe.
 *
 * Returns true if a settle row was written.
 */
export function settleFromLookup(eventId: string, setScore: string | null, isFinished: boolean): boolean {
  loadHistory();
  if (!isFinished || !setScore) return false;
  if (!snaps.has(eventId)) return false;
  if (settles.has(eventId)) return false;
  const m = /^(\d+)\s*[:\-]\s*(\d+)$/.exec(setScore);
  if (!m) return false;
  const homeGoals = parseInt(m[1]!, 10);
  const awayGoals = parseInt(m[2]!, 10);
  const result: 'H' | 'D' | 'A' = homeGoals > awayGoals ? 'H' : homeGoals < awayGoals ? 'A' : 'D';
  const row: SettleRow = {
    type: 'settle',
    ts: Date.now(),
    eventId,
    homeGoals,
    awayGoals,
    result,
    bttsYes: homeGoals > 0 && awayGoals > 0,
    over25: (homeGoals + awayGoals) > 2,
  };
  settles.set(eventId, row);
  appendRow(row);
  return true;
}

/** All eventIds with an open (un-settled) snapshot. Cheaper than getOpenSnapshots() when caller only wants IDs. */
export function getOpenEventIds(): string[] {
  loadHistory();
  const out: string[] = [];
  for (const eventId of snaps.keys()) {
    if (!settles.has(eventId)) out.push(eventId);
  }
  return out;
}

/**
 * Open eventIds whose snapshot is between minAgeMs and maxAgeMs old.
 * SRL matches play in ~real time, so a snap fresher than ~30 min is
 * almost certainly still in progress (skip it — group fetch will catch it).
 * Anything older than maxAgeMs is presumed lost (network / SB schema)
 * and dropped from the poll set so the fallback doesn't grow unbounded.
 */
export function getStaleOpenEventIds(minAgeMs: number, maxAgeMs: number): string[] {
  loadHistory();
  const now = Date.now();
  const out: string[] = [];
  for (const [eventId, snap] of snaps) {
    if (settles.has(eventId)) continue;
    const age = now - snap.ts;
    if (age >= minAgeMs && age <= maxAgeMs) out.push(eventId);
  }
  return out;
}

// ── Read API ─────────────────────────────────────────────

export function getSettledMatches(): SettledMatch[] {
  loadHistory();
  const out: SettledMatch[] = [];
  for (const [eventId, settle] of settles) {
    const snap = snaps.get(eventId);
    if (!snap) continue;
    out.push({
      eventId,
      league: snap.league,
      realLeague: snap.realLeague,
      homeReal: snap.homeReal,
      awayReal: snap.awayReal,
      snap,
      settle,
    });
  }
  return out;
}

export function getOpenSnapshots(): SnapshotRow[] {
  loadHistory();
  const out: SnapshotRow[] = [];
  for (const [eventId, snap] of snaps) {
    if (!settles.has(eventId)) out.push(snap);
  }
  return out;
}

// ── Empirical priors ─────────────────────────────────────

export interface LeaguePrior {
  league: string;          // raw e.g. "Premier League SRL"
  realLeague: string;      // stripped
  n: number;
  homeRate: number;        // 0..1
  drawRate: number;
  awayRate: number;
  over25Rate: number;
  bttsRate: number;
  /** Average total goals — useful as the engine's per-league scoring level. */
  avgGoals: number;
  /** Brier score of bookie engine probability vs actual outcome on this league. */
  bookieBrier1x2: number | null;
}

/** Per-league empirical rates and the bookie engine's Brier on 1X2. */
export function computeLeaguePriors(): Map<string, LeaguePrior> {
  const settled = getSettledMatches();
  const buckets = new Map<string, SettledMatch[]>();
  for (const s of settled) {
    if (!s.realLeague) continue;
    const arr = buckets.get(s.realLeague) || [];
    arr.push(s);
    buckets.set(s.realLeague, arr);
  }
  const out = new Map<string, LeaguePrior>();
  for (const [realLeague, arr] of buckets) {
    const n = arr.length;
    if (n === 0) continue;
    const homeWins = arr.filter(a => a.settle.result === 'H').length;
    const draws = arr.filter(a => a.settle.result === 'D').length;
    const awayWins = arr.filter(a => a.settle.result === 'A').length;
    const over25 = arr.filter(a => a.settle.over25).length;
    const btts = arr.filter(a => a.settle.bttsYes).length;
    const goalsTotal = arr.reduce((s, a) => s + a.settle.homeGoals + a.settle.awayGoals, 0);

    let brierSum = 0;
    let brierN = 0;
    for (const a of arr) {
      const tH = a.snap.trueH;
      const tD = a.snap.trueD;
      const tA = a.snap.trueA;
      if (tH === null || tD === null || tA === null) continue;
      const oH = a.settle.result === 'H' ? 1 : 0;
      const oD = a.settle.result === 'D' ? 1 : 0;
      const oA = a.settle.result === 'A' ? 1 : 0;
      brierSum += (tH - oH) ** 2 + (tD - oD) ** 2 + (tA - oA) ** 2;
      brierN++;
    }

    out.set(realLeague, {
      league: arr[0]!.league,
      realLeague,
      n,
      homeRate: homeWins / n,
      drawRate: draws / n,
      awayRate: awayWins / n,
      over25Rate: over25 / n,
      bttsRate: btts / n,
      avgGoals: goalsTotal / n,
      bookieBrier1x2: brierN > 0 ? brierSum / brierN : null,
    });
  }
  return out;
}

export interface TeamForm {
  team: string;
  realLeague: string;
  played: number;
  goalsFor: number;
  goalsAgainst: number;
  /** Multiplier vs league avg-goals-for — 1.0 = league average. */
  attackIndex: number;
  /** Multiplier vs league avg-goals-against — lower = better defense. */
  defenseIndex: number;
}

/** Per-team SRL-engine form. Separate from real-world form because the
 *  engine has its own dynamics (some teams over/underperform). Indexed by
 *  realLeague + team key so a team can have different form by league. */
export function computeTeamForm(): Map<string, TeamForm> {
  const settled = getSettledMatches();
  const out = new Map<string, TeamForm>();

  // Per-league averages first.
  const leagueGoals = new Map<string, { matches: number; total: number }>();
  for (const s of settled) {
    const lg = leagueGoals.get(s.realLeague) || { matches: 0, total: 0 };
    lg.matches++;
    lg.total += s.settle.homeGoals + s.settle.awayGoals;
    leagueGoals.set(s.realLeague, lg);
  }

  // Tally per-team-per-league.
  const stats = new Map<string, { played: number; gf: number; ga: number; realLeague: string; team: string }>();
  for (const s of settled) {
    for (const [team, gf, ga] of [
      [s.homeReal, s.settle.homeGoals, s.settle.awayGoals] as const,
      [s.awayReal, s.settle.awayGoals, s.settle.homeGoals] as const,
    ]) {
      if (!team) continue;
      const key = `${s.realLeague}|${team.toLowerCase()}`;
      const entry = stats.get(key) || { played: 0, gf: 0, ga: 0, realLeague: s.realLeague, team };
      entry.played++;
      entry.gf += gf;
      entry.ga += ga;
      stats.set(key, entry);
    }
  }

  for (const [key, entry] of stats) {
    const lg = leagueGoals.get(entry.realLeague);
    if (!lg || lg.matches === 0) continue;
    // League avg per-team-per-game = totalGoals / (matches * 2 sides)
    const avgPerSide = lg.total / (lg.matches * 2);
    const teamFor = entry.gf / entry.played;
    const teamAgainst = entry.ga / entry.played;
    out.set(key, {
      team: entry.team,
      realLeague: entry.realLeague,
      played: entry.played,
      goalsFor: entry.gf,
      goalsAgainst: entry.ga,
      attackIndex: avgPerSide > 0 ? teamFor / avgPerSide : 1,
      defenseIndex: avgPerSide > 0 ? teamAgainst / avgPerSide : 1,
    });
  }
  return out;
}

export function getTeamForm(realLeague: string, team: string): TeamForm | null {
  const key = `${realLeague}|${(team || '').toLowerCase()}`;
  const map = computeTeamForm();
  return map.get(key) ?? null;
}

/** Header counts for UI honesty banner. */
export function getHistoryStats(): { snapshots: number; settled: number; openSnapshots: number; oldestSnap: number | null; newestSettle: number | null } {
  loadHistory();
  let oldestSnap: number | null = null;
  for (const s of snaps.values()) {
    if (oldestSnap === null || s.ts < oldestSnap) oldestSnap = s.ts;
  }
  let newestSettle: number | null = null;
  for (const s of settles.values()) {
    if (newestSettle === null || s.ts > newestSettle) newestSettle = s.ts;
  }
  return {
    snapshots: snaps.size,
    settled: settles.size,
    openSnapshots: snaps.size - settles.size,
    oldestSnap,
    newestSettle,
  };
}

/**
 * Consensus Result Tracker
 *
 * Snapshots consensus picks, then checks ESPN scoreboards
 * to verify results. Tracks win/loss/pending per pick type
 * and overall accuracy stats.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import {
  scrapeAllTipsters,
  buildConsensus,
  findMatchingPredictions,
  type ConsensusPrediction,
} from './tipster-scrapers.js';
import { findPinnacleOdds, type PinnacleOdds } from './pinnacle-odds.js';

// ── Types ──────────────────────────────────────────────────

export interface TrackedPick {
  id: string; // homeTeam|awayTeam|date
  homeTeam: string;
  awayTeam: string;
  date: string;
  pick: string; // "Home", "Away", "Draw", "Over 2.5", "BTS"
  pickPct: number;
  sourceCount: number;
  sources: string[];
  consensus: ConsensusPrediction;
  result: 'pending' | 'won' | 'lost' | 'void';
  homeGoals: number | null;
  awayGoals: number | null;
  settledAt: string | null;
  snapshotAt: string;
  // CLV tracking — Pinnacle fair decimal odds for the chosen pick, captured at
  // snapshot time (our "take") and at settle time (the "close"). CLV% per pick
  // is (snapshot / close - 1) * 100 — positive means our pick was taken at a
  // price the sharp market later agreed was cheap.
  snapshotOdds?: number | null;
  closingOdds?: number | null;
}

export interface TrackerStats {
  total: number;
  won: number;
  lost: number;
  pending: number;
  voided: number;
  winRate: number;
  byPick: Record<string, { total: number; won: number; lost: number; winRate: number }>;
  bySourceCount: Record<string, { total: number; won: number; lost: number; winRate: number }>;
  bySource: Record<string, { total: number; won: number; lost: number; winRate: number; weight: number }>;
  streak: { current: number; type: 'W' | 'L' | null };
  recentResults: TrackedPick[];
  clv: { samples: number; avgPct: number; positivePct: number };
}

// Bayesian shrinkage prior: every source starts at 50% with 10 pseudo-bets.
// Prevents a brand-new source with 1 win from getting 100% weight.
const PRIOR_TOTAL = 10;
const PRIOR_WINS = 5;

// ── ESPN Score Fetcher ─────────────────────────────────────

const ESPN_BASE = 'https://site.api.espn.com/apis';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ESPN_LEAGUES = [
  'eng.1', 'eng.2', 'esp.1', 'ger.1', 'ita.1', 'fra.1',
  'uefa.champions', 'uefa.europa', 'usa.1', 'ned.1', 'por.1',
  'bra.1', 'arg.1', 'tur.1', 'sco.1', 'bel.1', 'gre.1',
];

interface ESPNScore {
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  status: 'pre' | 'in' | 'post';
}

const scoresCache = new Map<string, { data: ESPNScore[]; ts: number }>();
const SCORES_TTL = 5 * 60 * 1000; // 5 min

async function fetchScores(dateStr: string): Promise<ESPNScore[]> {
  const cached = scoresCache.get(dateStr);
  if (cached && Date.now() - cached.ts < SCORES_TTL) return cached.data;

  const formatted = dateStr.replace(/-/g, '');
  const scores: ESPNScore[] = [];

  const results = await Promise.allSettled(
    ESPN_LEAGUES.map(async (league) => {
      const res = await fetch(
        `${ESPN_BASE}/site/v2/sports/soccer/${league}/scoreboard?dates=${formatted}`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) },
      );
      if (!res.ok) return [];
      const data = (await res.json()) as {
        events?: Array<{
          competitions: Array<{
            status: { type: { state: string } };
            competitors: Array<{
              homeAway: string;
              team: { displayName: string; shortDisplayName: string };
              score?: { value: number } | string;
            }>;
          }>;
        }>;
      };
      return data.events || [];
    }),
  );

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const event of r.value) {
      const comp = event.competitions?.[0];
      if (!comp) continue;
      const home = comp.competitors?.find((c) => c.homeAway === 'home');
      const away = comp.competitors?.find((c) => c.homeAway === 'away');
      if (!home || !away) continue;

      const homeScore = typeof home.score === 'object' ? home.score?.value : parseFloat(String(home.score));
      const awayScore = typeof away.score === 'object' ? away.score?.value : parseFloat(String(away.score));

      scores.push({
        homeTeam: home.team.displayName,
        awayTeam: away.team.displayName,
        homeGoals: isNaN(homeScore as number) ? 0 : homeScore as number,
        awayGoals: isNaN(awayScore as number) ? 0 : awayScore as number,
        status: comp.status?.type?.state === 'post'
          ? 'post'
          : comp.status?.type?.state === 'in'
            ? 'in'
            : 'pre',
      });
    }
  }

  scoresCache.set(dateStr, { data: scores, ts: Date.now() });
  return scores;
}

// ── Name matching (same logic as fotmob-enrichment) ────────

function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\b(fc|sc|cf|ac|as|ss|us|cd|ca|rc|sd|rcd|ud|fk|bk|if|aik)\b/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function teamMatch(a: string, b: string): boolean {
  const na = normName(a);
  const nb = normName(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const fa = na.split(/\s+/)[0]!;
  const fb = nb.split(/\s+/)[0]!;
  if (fa.length >= 4 && fa === fb) return true;
  return false;
}

// ── Pick result evaluation ─────────────────────────────────

function evaluatePick(
  pick: string,
  homeGoals: number,
  awayGoals: number,
): 'won' | 'lost' {
  const totalGoals = homeGoals + awayGoals;
  const bothScored = homeGoals > 0 && awayGoals > 0;

  switch (pick) {
    case 'Home':
      return homeGoals > awayGoals ? 'won' : 'lost';
    case 'Away':
      return awayGoals > homeGoals ? 'won' : 'lost';
    case 'Draw':
      return homeGoals === awayGoals ? 'won' : 'lost';
    case 'Over 2.5':
      return totalGoals > 2.5 ? 'won' : 'lost';
    case 'Under 2.5':
      return totalGoals < 2.5 ? 'won' : 'lost';
    case 'BTS':
      return bothScored ? 'won' : 'lost';
    default:
      return 'lost';
  }
}

// ── Persisted store ─────────────────────────────────────────

const STATE_FILE = path.join(process.cwd(), 'data', 'consensus_tracker.json');
const MAX_PICKS = 500;

interface PersistedState {
  picks: TrackedPick[];
  sourceStats: Array<[string, { total: number; won: number; lost: number }]>;
}

function loadState(): { picks: TrackedPick[]; sourceStats: Map<string, { total: number; won: number; lost: number }> } {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as PersistedState;
      return {
        picks: Array.isArray(raw.picks) ? raw.picks : [],
        sourceStats: new Map(Array.isArray(raw.sourceStats) ? raw.sourceStats : []),
      };
    }
  } catch (err) {
    logger.warn({ err }, 'Consensus tracker: failed to load state — starting fresh');
  }
  return { picks: [], sourceStats: new Map() };
}

function saveState(): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const state: PersistedState = {
      picks: picks.slice(-MAX_PICKS),
      sourceStats: [...sourceStats.entries()],
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (err) {
    logger.warn({ err }, 'Consensus tracker: failed to save state');
  }
}

const _loaded = loadState();
const picks: TrackedPick[] = _loaded.picks;

// Per-source accumulated settled picks (wins/losses). Populated during
// settleResults() — every source that contributed to a settled pick gets
// credit/blame for the outcome.
const sourceStats = _loaded.sourceStats;

function recordSourceOutcome(source: string, result: 'won' | 'lost'): void {
  let stat = sourceStats.get(source);
  if (!stat) {
    stat = { total: 0, won: 0, lost: 0 };
    sourceStats.set(source, stat);
  }
  stat.total++;
  if (result === 'won') stat.won++;
  else stat.lost++;
}

/**
 * Bayesian-shrunk win rate for a source. Returns the posterior mean under
 * a Beta(PRIOR_WINS, PRIOR_TOTAL - PRIOR_WINS) prior. New sources land at
 * 0.5 and move toward their observed rate as evidence accumulates.
 */
function sourceWeight(source: string): number {
  const stat = sourceStats.get(source);
  const won = stat?.won ?? 0;
  const total = stat?.total ?? 0;
  return (won + PRIOR_WINS) / (total + PRIOR_TOTAL);
}

/**
 * Get Bayesian-shrunk win-rate weights for all known sources. Used by
 * buildConsensus to compute an accuracy-weighted average instead of a
 * naive unweighted mean.
 */
export function getSourceWeights(): Map<string, number> {
  const weights = new Map<string, number>();
  for (const [source] of sourceStats) {
    weights.set(source, sourceWeight(source));
  }
  return weights;
}

/**
 * Map a consensus pick label (e.g. "Home", "Over 2.5", "BTS") to Pinnacle's
 * fair decimal odds (margin-stripped via 1/implied-prob). Returns null when
 * we can't match the match or the specific market. Best-effort — missing CLV
 * data is fine and common, but hits give us ground truth on pick quality.
 */
function stripVigTwoWay(over: number, under: number): { over: number; under: number } | null {
  if (over <= 1 || under <= 1) return null;
  const inv = 1 / over + 1 / under;
  if (inv <= 0) return null;
  return { over: inv / (1 / over), under: inv / (1 / under) };
}
function stripVigThreeWay(h: number, d: number, a: number): { h: number; d: number; a: number } | null {
  if (h <= 1 || d <= 1 || a <= 1) return null;
  const inv = 1 / h + 1 / d + 1 / a;
  if (inv <= 0) return null;
  return { h: inv / (1 / h), d: inv / (1 / d), a: inv / (1 / a) };
}

function fairOddsForPick(odds: PinnacleOdds, pick: string): number | null {
  const p = pick.toLowerCase().trim();
  if (odds.moneyline) {
    const fair = stripVigThreeWay(odds.moneyline.home, odds.moneyline.draw, odds.moneyline.away);
    if (fair) {
      if (p === 'home' || p === '1') return fair.h;
      if (p === 'draw' || p === 'x') return fair.d;
      if (p === 'away' || p === '2') return fair.a;
      if (p === '1x' || p === 'home or draw') return 1 / (1 / fair.h + 1 / fair.d);
      if (p === 'x2' || p === 'draw or away') return 1 / (1 / fair.d + 1 / fair.a);
      if (p === '12' || p === 'home or away') return 1 / (1 / fair.h + 1 / fair.a);
    }
  }
  // Over/Under X.X
  const m = p.match(/^(over|under)\s+(\d+\.?\d*)$/);
  if (m && odds.totals) {
    const side = m[1] as 'over' | 'under';
    const line = parseFloat(m[2]!);
    const row = odds.totals.find(t => Math.abs(t.line - line) < 0.01);
    if (row) {
      const fair = stripVigTwoWay(row.over, row.under);
      if (fair) return side === 'over' ? fair.over : fair.under;
    }
  }
  return null;
}

async function fetchFairOddsForPick(home: string, away: string, pick: string, league = ''): Promise<number | null> {
  const pin = await findPinnacleOdds(home, away, league);
  if (!pin) return null;
  return fairOddsForPick(pin, pick);
}

function pickId(home: string, away: string, date: string, pick: string): string {
  // Normalize date to YYYY-MM-DD
  const d = date.includes('-') && date.length === 10 ? date : (() => {
    // Handle DD/MM/YY format
    const parts = date.split('/');
    if (parts.length === 3) {
      const [dd, mm, yy] = parts;
      return `20${yy}-${mm}-${dd}`;
    }
    return date;
  })();
  return `${normName(home)}|${normName(away)}|${d}|${pick}`;
}

/**
 * Snapshot today's consensus picks into the tracker.
 * Only adds picks not already tracked.
 */
export async function snapshotConsensus(minSources = 2, minPct = 50): Promise<TrackedPick[]> {
  const allPredictions = await scrapeAllTipsters();
  const today = new Date().toISOString().slice(0, 10);

  // Group predictions by match
  const matchMap = new Map<string, { home: string; away: string }>();
  for (const p of allPredictions) {
    const mkey = `${normName(p.homeTeam)}|${normName(p.awayTeam)}`;
    if (!matchMap.has(mkey)) {
      matchMap.set(mkey, { home: p.homeTeam, away: p.awayTeam });
    }
  }

  const added: TrackedPick[] = [];

  const weights = getSourceWeights();

  for (const [, { home, away }] of matchMap) {
    const matched = findMatchingPredictions(allPredictions, home, away);
    const consensus = buildConsensus(matched, home, away, undefined, weights);
    if (!consensus || consensus.sourceCount < minSources || consensus.bestPickPct < minPct) continue;

    const key = pickId(home, away, today, consensus.bestPick);
    // Skip if already tracked
    if (picks.some((p) => p.id === key)) continue;

    const pick: TrackedPick = {
      id: key,
      homeTeam: home,
      awayTeam: away,
      date: today,
      pick: consensus.bestPick,
      pickPct: consensus.bestPickPct,
      sourceCount: consensus.sourceCount,
      sources: consensus.sources,
      consensus,
      result: 'pending',
      homeGoals: null,
      awayGoals: null,
      settledAt: null,
      snapshotAt: new Date().toISOString(),
      snapshotOdds: null,
      closingOdds: null,
    };

    // CLV capture (best-effort, non-blocking): fetch Pinnacle fair odds at snapshot
    fetchFairOddsForPick(home, away, consensus.bestPick).then(o => {
      if (o && o > 1) pick.snapshotOdds = Math.round(o * 1000) / 1000;
    }).catch(() => { /* swallow — CLV is best-effort */ });

    picks.push(pick);
    added.push(pick);
  }

  // Trim old picks
  while (picks.length > MAX_PICKS) picks.shift();

  if (added.length > 0) saveState();

  logger.info(`Consensus tracker: ${added.length} new picks snapshotted, ${picks.length} total`);
  return added;
}

/**
 * Check results for all pending picks by fetching ESPN scores.
 */
export async function settleResults(): Promise<{ settled: number; pending: number }> {
  const pending = picks.filter((p) => p.result === 'pending');
  if (!pending.length) return { settled: 0, pending: 0 };

  // Get unique dates
  const dates = [...new Set(pending.map((p) => p.date))];
  const allScores: ESPNScore[] = [];
  for (const d of dates) {
    const scores = await fetchScores(d);
    allScores.push(...scores);
  }

  let settled = 0;

  for (const pick of pending) {
    // Find matching score
    const score = allScores.find(
      (s) =>
        s.status === 'post' &&
        teamMatch(pick.homeTeam, s.homeTeam) &&
        teamMatch(pick.awayTeam, s.awayTeam),
    );

    if (!score) continue;

    pick.homeGoals = score.homeGoals;
    pick.awayGoals = score.awayGoals;
    pick.result = evaluatePick(pick.pick, score.homeGoals, score.awayGoals);
    pick.settledAt = new Date().toISOString();
    settled++;

    // Close-odds capture (best-effort, non-blocking) — only if not already set
    if (!pick.closingOdds) {
      fetchFairOddsForPick(pick.homeTeam, pick.awayTeam, pick.pick).then(o => {
        if (o && o > 1) {
          pick.closingOdds = Math.round(o * 1000) / 1000;
          saveState();
        }
      }).catch(() => { /* swallow */ });
    }

    // Credit / blame every source that contributed to this pick
    for (const src of pick.sources) {
      recordSourceOutcome(src, pick.result as 'won' | 'lost');
    }
  }

  if (settled > 0) saveState();

  const stillPending = picks.filter((p) => p.result === 'pending').length;
  logger.info(`Consensus tracker: settled ${settled}, still pending ${stillPending}`);
  return { settled, pending: stillPending };
}

/**
 * Get full performance stats.
 */
export function getStats(): TrackerStats {
  const won = picks.filter((p) => p.result === 'won');
  const lost = picks.filter((p) => p.result === 'lost');
  const pending = picks.filter((p) => p.result === 'pending');
  const voided = picks.filter((p) => p.result === 'void');
  const settled = [...won, ...lost];

  // By pick type
  const byPick: TrackerStats['byPick'] = {};
  for (const p of settled) {
    if (!byPick[p.pick]) byPick[p.pick] = { total: 0, won: 0, lost: 0, winRate: 0 };
    const s = byPick[p.pick]!;
    s.total++;
    if (p.result === 'won') s.won++;
    else s.lost++;
    s.winRate = Math.round((s.won / s.total) * 1000) / 10;
  }

  // By source count (2, 3, 4+)
  const bySourceCount: TrackerStats['bySourceCount'] = {};
  for (const p of settled) {
    const key = p.sourceCount >= 4 ? '4+' : String(p.sourceCount);
    if (!bySourceCount[key]) bySourceCount[key] = { total: 0, won: 0, lost: 0, winRate: 0 };
    const s = bySourceCount[key]!;
    s.total++;
    if (p.result === 'won') s.won++;
    else s.lost++;
    s.winRate = Math.round((s.won / s.total) * 1000) / 10;
  }

  // Current streak
  let streakType: 'W' | 'L' | null = null;
  let streakCount = 0;
  const settledByTime = [...settled].sort(
    (a, b) => new Date(b.settledAt!).getTime() - new Date(a.settledAt!).getTime(),
  );
  for (const p of settledByTime) {
    const t = p.result === 'won' ? 'W' : 'L';
    if (streakType === null) {
      streakType = t;
      streakCount = 1;
    } else if (t === streakType) {
      streakCount++;
    } else {
      break;
    }
  }

  // Recent results (last 20)
  const recentResults = settledByTime.slice(0, 20);

  // CLV — Pinnacle-fair-odds delta between snapshot and close.
  // Positive CLV across many picks is the only statistical proof of edge.
  let clvSum = 0;
  let clvSamples = 0;
  let clvPositive = 0;
  for (const p of picks) {
    if (p.snapshotOdds && p.closingOdds && p.snapshotOdds > 1 && p.closingOdds > 1) {
      const clvPct = (p.snapshotOdds / p.closingOdds - 1) * 100;
      clvSum += clvPct;
      clvSamples++;
      if (clvPct > 0) clvPositive++;
    }
  }
  const clv = {
    samples: clvSamples,
    avgPct: clvSamples > 0 ? Math.round((clvSum / clvSamples) * 100) / 100 : 0,
    positivePct: clvSamples > 0 ? Math.round((clvPositive / clvSamples) * 1000) / 10 : 0,
  };

  // Per-source performance + Bayesian-shrunk weight (used by buildConsensus)
  const bySource: TrackerStats['bySource'] = {};
  for (const [source, stat] of sourceStats) {
    bySource[source] = {
      total: stat.total,
      won: stat.won,
      lost: stat.lost,
      winRate: stat.total > 0 ? Math.round((stat.won / stat.total) * 1000) / 10 : 0,
      weight: Math.round(sourceWeight(source) * 1000) / 1000,
    };
  }

  return {
    total: settled.length,
    won: won.length,
    lost: lost.length,
    pending: pending.length,
    voided: voided.length,
    winRate: settled.length > 0 ? Math.round((won.length / settled.length) * 1000) / 10 : 0,
    byPick,
    bySourceCount,
    bySource,
    streak: { current: streakCount, type: streakType },
    recentResults,
    clv,
  };
}

/**
 * Get all tracked picks (optionally filtered).
 */
export function getAllPicks(filter?: 'pending' | 'won' | 'lost'): TrackedPick[] {
  if (filter) return picks.filter((p) => p.result === filter);
  return [...picks];
}

// ── Background auto-tracker ────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Start background loop: snapshot consensus every 2 hours,
 * settle results every 15 minutes.
 */
export function startAutoTracker(): void {
  if (intervalId) return;

  // Initial snapshot + settle
  void snapshotConsensus().catch((e) => logger.error(e, 'Auto-snapshot failed'));
  void settleResults().catch((e) => logger.error(e, 'Auto-settle failed'));

  // Settle results every 15 min
  intervalId = setInterval(() => {
    void settleResults().catch((e) => logger.error(e, 'Auto-settle failed'));
  }, 15 * 60 * 1000);

  // Re-snapshot every 2 hours
  setInterval(() => {
    void snapshotConsensus().catch((e) => logger.error(e, 'Auto-snapshot failed'));
  }, 2 * 60 * 60 * 1000);

  logger.info('Consensus auto-tracker started (settle every 15m, snapshot every 2h)');
}

export function stopAutoTracker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/**
 * Consensus Result Tracker
 *
 * Snapshots consensus picks, then checks ESPN scoreboards
 * to verify results. Tracks win/loss/pending per pick type
 * and overall accuracy stats.
 */

import { logger } from '../utils/logger.js';
import {
  scrapeAllTipsters,
  buildConsensus,
  findMatchingPredictions,
  type ConsensusPrediction,
} from './tipster-scrapers.js';

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
  streak: { current: number; type: 'W' | 'L' | null };
  recentResults: TrackedPick[];
}

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

// ── In-memory store ────────────────────────────────────────

const picks: TrackedPick[] = [];
const MAX_PICKS = 500;

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

  for (const [, { home, away }] of matchMap) {
    const matched = findMatchingPredictions(allPredictions, home, away);
    const consensus = buildConsensus(matched, home, away);
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
    };

    picks.push(pick);
    added.push(pick);
  }

  // Trim old picks
  while (picks.length > MAX_PICKS) picks.shift();

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
  }

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

  return {
    total: settled.length,
    won: won.length,
    lost: lost.length,
    pending: pending.length,
    voided: voided.length,
    winRate: settled.length > 0 ? Math.round((won.length / settled.length) * 1000) / 10 : 0,
    byPick,
    bySourceCount,
    streak: { current: streakCount, type: streakType },
    recentResults,
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

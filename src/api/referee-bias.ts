/**
 * Referee bias — port of bot-main FootStats scrapers/referee_db.py.
 *
 * football-data.co.uk's per-season CSVs include `Referee`, `HY`/`AY`
 * (yellows), `HR`/`AR` (reds), and `FTHG`/`FTAG`, so we can build a
 * referee-stats index from data we already pull — no Playwright, no new
 * scraper, no API key.
 *
 * Classification (thresholds copied from bot-main):
 *   • cards-heavy  — avg yellow per match > 4.3
 *   • goals-heavy  — avg goals per match  > 3.0
 *   • neutral      — otherwise
 *   • unknown      — referee not in our index
 *
 * λ adjustment (symmetric — applies to both sides):
 *   • cards-heavy → ×0.95  (stoppages + cautious play → fewer goals)
 *   • goals-heavy → ×1.05  (open game / lax fouls → more goals)
 *   • neutral / unknown → ×1.00
 *
 * Fetched lazily on first request; cache TTL 24h.
 */

import { logger } from '../utils/logger.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const FETCH_TIMEOUT = 12000;
const CACHE_TTL = 24 * 60 * 60 * 1000;

// Cards-heavy / goals-heavy thresholds (matches bot-main's referee_db.py).
const KARTKOWY_AVG_YELLOW = 4.3;
const BRAMKOWY_AVG_GOALS = 3.0;
const CARDS_HEAVY_MULT = 0.95;
const GOALS_HEAVY_MULT = 1.05;
const MIN_MATCHES_FOR_SIGNAL = 5;

// Subset of football-data.co.uk's main-format league CSVs known to include
// the `Referee` + `HY/AY/HR/AR` columns. We keep this list local rather
// than reusing stats-predictor's full league set: the "/new/" multi-year
// CSVs (Brazil, MLS, J League, etc.) don't carry referee data.
const REFEREE_LEAGUES = [
  { country: 'England', name: 'Premier League', code: 'E0' },
  { country: 'England', name: 'Championship', code: 'E1' },
  { country: 'England', name: 'League One', code: 'E2' },
  { country: 'England', name: 'League Two', code: 'E3' },
  { country: 'England', name: 'National League', code: 'EC' },
  { country: 'Spain', name: 'La Liga', code: 'SP1' },
  { country: 'Spain', name: 'Segunda', code: 'SP2' },
  { country: 'Germany', name: 'Bundesliga', code: 'D1' },
  { country: 'Germany', name: 'Bundesliga 2', code: 'D2' },
  { country: 'Italy', name: 'Serie A', code: 'I1' },
  { country: 'Italy', name: 'Serie B', code: 'I2' },
  { country: 'France', name: 'Ligue 1', code: 'F1' },
  { country: 'France', name: 'Ligue 2', code: 'F2' },
  { country: 'Netherlands', name: 'Eredivisie', code: 'N1' },
  { country: 'Portugal', name: 'Liga Portugal', code: 'P1' },
  { country: 'Turkey', name: 'Super Lig', code: 'T1' },
  { country: 'Belgium', name: 'Pro League', code: 'B1' },
  { country: 'Scotland', name: 'Premiership', code: 'SC0' },
  { country: 'Greece', name: 'Super League', code: 'G1' },
];

export interface RefereeStats {
  /** Canonical name (first encountered casing). */
  name: string;
  nMatches: number;
  avgYellow: number;
  avgRed: number;
  avgGoals: number;
  /** League codes the ref has officiated in (set of codes). */
  leagues: string[];
}

export type RefereeSignal = 'cards-heavy' | 'goals-heavy' | 'neutral' | 'unknown';

export interface RefereeAnalysis {
  signal: RefereeSignal;
  lambdaMult: number;
  reason: string;
  stats: RefereeStats | null;
}

// ── State ────────────────────────────────────────────────

interface Agg {
  name: string;
  nMatches: number;
  yellow: number;
  red: number;
  goals: number;
  leagues: Set<string>;
}

const refIndex = new Map<string, Agg>(); // normalised-name → agg
let loadedAt = 0;
let loadInflight: Promise<void> | null = null;

function normRef(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function currentSeasonCode(): string {
  // football-data.co.uk season codes: "2425" = 2024/25.
  const now = new Date();
  const startYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return `${String(startYear).slice(-2)}${String(startYear + 1).slice(-2)}`;
}

async function fetchCsv(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/csv,*/*;q=0.5' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function parseCsvRefs(csv: string, leagueCode: string, agg: Map<string, Agg>): number {
  const lines = csv.split('\n').filter(l => l.trim());
  if (lines.length < 2) return 0;
  const header = lines[0]!.split(',').map(h => h.trim().replace(/^﻿/, ''));
  const refIdx = header.findIndex(h => h === 'Referee');
  const fthgIdx = header.findIndex(h => h === 'FTHG' || h === 'HG');
  const ftagIdx = header.findIndex(h => h === 'FTAG' || h === 'AG');
  const hyIdx = header.findIndex(h => h === 'HY');
  const ayIdx = header.findIndex(h => h === 'AY');
  const hrIdx = header.findIndex(h => h === 'HR');
  const arIdx = header.findIndex(h => h === 'AR');
  if (refIdx < 0 || fthgIdx < 0 || ftagIdx < 0) return 0;

  let counted = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(',');
    const refName = (cols[refIdx] || '').trim();
    if (!refName) continue;
    const hg = parseInt(cols[fthgIdx] || '', 10);
    const ag = parseInt(cols[ftagIdx] || '', 10);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;

    const hy = hyIdx >= 0 ? parseInt(cols[hyIdx] || '', 10) : NaN;
    const ay = ayIdx >= 0 ? parseInt(cols[ayIdx] || '', 10) : NaN;
    const hr = hrIdx >= 0 ? parseInt(cols[hrIdx] || '', 10) : NaN;
    const ar = arIdx >= 0 ? parseInt(cols[arIdx] || '', 10) : NaN;

    const key = normRef(refName);
    if (!key) continue;
    const entry = agg.get(key) ?? {
      name: refName,
      nMatches: 0,
      yellow: 0,
      red: 0,
      goals: 0,
      leagues: new Set<string>(),
    };
    entry.nMatches++;
    entry.goals += hg + ag;
    if (Number.isFinite(hy)) entry.yellow += hy;
    if (Number.isFinite(ay)) entry.yellow += ay;
    if (Number.isFinite(hr)) entry.red += hr;
    if (Number.isFinite(ar)) entry.red += ar;
    entry.leagues.add(leagueCode);
    agg.set(key, entry);
    counted++;
  }
  return counted;
}

async function loadIndex(): Promise<void> {
  const season = currentSeasonCode();
  const agg = new Map<string, Agg>();
  // Pull current season + previous season per league to get a decent
  // per-ref sample. Two-season window matches bot-main's effective scope.
  const prevSeason = (() => {
    const sn = parseInt(season.slice(0, 2), 10);
    const en = parseInt(season.slice(2, 4), 10);
    return `${String((sn + 99) % 100).padStart(2, '0')}${String((en + 99) % 100).padStart(2, '0')}`;
  })();

  const urls: Array<{ league: typeof REFEREE_LEAGUES[number]; url: string }> = [];
  for (const lg of REFEREE_LEAGUES) {
    urls.push({ league: lg, url: `https://www.football-data.co.uk/mmz4281/${season}/${lg.code}.csv` });
    urls.push({ league: lg, url: `https://www.football-data.co.uk/mmz4281/${prevSeason}/${lg.code}.csv` });
  }

  const results = await Promise.allSettled(urls.map(u => fetchCsv(u.url).then(csv => ({ league: u.league, csv }))));
  let totalRows = 0;
  let loadedSheets = 0;
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value.csv) continue;
    const rows = parseCsvRefs(r.value.csv, r.value.league.code, agg);
    if (rows > 0) {
      totalRows += rows;
      loadedSheets++;
    }
  }

  refIndex.clear();
  for (const [k, v] of agg) refIndex.set(k, v);
  loadedAt = Date.now();
  logger.info({ sheets: loadedSheets, totalRows, refs: refIndex.size }, 'referee-bias: index loaded');
}

async function ensureLoaded(): Promise<void> {
  if (refIndex.size > 0 && Date.now() - loadedAt < CACHE_TTL) return;
  if (loadInflight) { await loadInflight; return; }
  loadInflight = loadIndex().finally(() => { loadInflight = null; });
  await loadInflight;
}

// ── Public lookup ────────────────────────────────────────

function findRef(name: string): Agg | null {
  const target = normRef(name);
  if (!target) return null;
  // Exact normalised match first.
  const exact = refIndex.get(target);
  if (exact) return exact;
  // Token-subset match — handles "R Jones" vs "Robert Jones".
  const targetTokens = new Set(target.split(/\s+/).filter(t => t.length >= 2));
  let best: { agg: Agg; score: number } | null = null;
  for (const [key, agg] of refIndex) {
    const keyTokens = new Set(key.split(/\s+/).filter(t => t.length >= 2));
    let overlap = 0;
    for (const t of targetTokens) if (keyTokens.has(t)) overlap++;
    if (overlap === 0) continue;
    const union = targetTokens.size + keyTokens.size - overlap;
    const score = (overlap / union) * 100 + Math.min(agg.nMatches, 50) * 0.1;
    if (score >= 40 && (!best || score > best.score)) {
      best = { agg, score };
    }
  }
  return best?.agg ?? null;
}

function statsFrom(agg: Agg): RefereeStats {
  const n = agg.nMatches;
  return {
    name: agg.name,
    nMatches: n,
    avgYellow: n > 0 ? Math.round((agg.yellow / n) * 100) / 100 : 0,
    avgRed: n > 0 ? Math.round((agg.red / n) * 1000) / 1000 : 0,
    avgGoals: n > 0 ? Math.round((agg.goals / n) * 100) / 100 : 0,
    leagues: [...agg.leagues].sort(),
  };
}

export async function getRefereeStats(name: string): Promise<RefereeStats | null> {
  await ensureLoaded();
  const agg = findRef(name);
  return agg ? statsFrom(agg) : null;
}

export async function analyzeReferee(name: string | undefined | null): Promise<RefereeAnalysis> {
  if (!name) {
    return { signal: 'unknown', lambdaMult: 1, reason: 'No referee supplied.', stats: null };
  }
  const stats = await getRefereeStats(name);
  if (!stats || stats.nMatches < MIN_MATCHES_FOR_SIGNAL) {
    return {
      signal: 'unknown',
      lambdaMult: 1,
      reason: stats ? `${stats.name} — only ${stats.nMatches} matches in index, signal too thin.` : `Referee "${name}" not in index.`,
      stats,
    };
  }
  if (stats.avgYellow > KARTKOWY_AVG_YELLOW) {
    return {
      signal: 'cards-heavy',
      lambdaMult: CARDS_HEAVY_MULT,
      reason: `🟨 ${stats.name} averages ${stats.avgYellow} yellows/match (>${KARTKOWY_AVG_YELLOW}) — λ ×${CARDS_HEAVY_MULT}.`,
      stats,
    };
  }
  if (stats.avgGoals > BRAMKOWY_AVG_GOALS) {
    return {
      signal: 'goals-heavy',
      lambdaMult: GOALS_HEAVY_MULT,
      reason: `⚽ ${stats.name} averages ${stats.avgGoals} goals/match (>${BRAMKOWY_AVG_GOALS}) — λ ×${GOALS_HEAVY_MULT}.`,
      stats,
    };
  }
  return {
    signal: 'neutral',
    lambdaMult: 1,
    reason: `${stats.name} neutral: ${stats.avgYellow} yel, ${stats.avgGoals} g/match.`,
    stats,
  };
}

/** Diagnostics. */
export function getRefereeIndexStats(): { refsIndexed: number; loadedAtIso: string | null } {
  return {
    refsIndexed: refIndex.size,
    loadedAtIso: loadedAt > 0 ? new Date(loadedAt).toISOString() : null,
  };
}

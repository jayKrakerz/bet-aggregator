/**
 * Stats-Based Match Predictor (Poisson Model)
 *
 * Inspired by ProphitBet — uses football-data.co.uk historical CSVs
 * to compute team-level attack/defense strength, then applies a Poisson
 * model to predict 1X2, Over/Under 2.5, and BTS probabilities.
 *
 * This is the same approach used by sharp bettors and quant models:
 * - Download current-season CSV for each major league
 * - Compute avg goals scored/conceded per team (home & away split)
 * - Calculate attack/defense strength relative to league average
 * - Use Poisson distribution to predict goal probabilities
 * - Derive 1X2, O/U, BTS from the goal matrix
 *
 * Feeds into the consensus engine as source "poisson-model".
 */

import { logger } from '../utils/logger.js';

// ── League config (from ProphitBet's leagues.json) ─────────

interface LeagueConfig {
  country: string;
  name: string;
  code: string; // football-data.co.uk code
  url: string;
  aliases: string[]; // names used by Sportybet/tipsters
}

const LEAGUES: LeagueConfig[] = [
  { country: 'England', name: 'Premier League', code: 'E0', url: 'https://www.football-data.co.uk/mmz4281/{}/E0.csv', aliases: ['premier league', 'epl', 'english premier'] },
  { country: 'England', name: 'Championship', code: 'E1', url: 'https://www.football-data.co.uk/mmz4281/{}/E1.csv', aliases: ['championship', 'efl championship'] },
  { country: 'Spain', name: 'La Liga', code: 'SP1', url: 'https://www.football-data.co.uk/mmz4281/{}/SP1.csv', aliases: ['laliga', 'la liga', 'primera division'] },
  { country: 'Germany', name: 'Bundesliga', code: 'D1', url: 'https://www.football-data.co.uk/mmz4281/{}/D1.csv', aliases: ['bundesliga', '1. bundesliga'] },
  { country: 'Italy', name: 'Serie A', code: 'I1', url: 'https://www.football-data.co.uk/mmz4281/{}/I1.csv', aliases: ['serie a', 'italian serie a'] },
  { country: 'France', name: 'Ligue 1', code: 'F1', url: 'https://www.football-data.co.uk/mmz4281/{}/F1.csv', aliases: ['ligue 1', 'french ligue 1'] },
  { country: 'Netherlands', name: 'Eredivisie', code: 'N1', url: 'https://www.football-data.co.uk/mmz4281/{}/N1.csv', aliases: ['eredivisie'] },
  { country: 'Portugal', name: 'Liga Portugal', code: 'P1', url: 'https://www.football-data.co.uk/mmz4281/{}/P1.csv', aliases: ['liga portugal', 'primeira liga', 'liga nos'] },
  { country: 'Turkey', name: 'Super Lig', code: 'T1', url: 'https://www.football-data.co.uk/mmz4281/{}/T1.csv', aliases: ['super lig', 'turkish super lig'] },
  { country: 'Belgium', name: 'Pro League', code: 'B1', url: 'https://www.football-data.co.uk/mmz4281/{}/B1.csv', aliases: ['pro league', 'jupiler pro league', 'jupiler league'] },
  { country: 'Scotland', name: 'Premiership', code: 'SC0', url: 'https://www.football-data.co.uk/mmz4281/{}/SC0.csv', aliases: ['scottish premiership', 'spfl premiership'] },
  { country: 'Greece', name: 'Super League', code: 'G1', url: 'https://www.football-data.co.uk/mmz4281/{}/G1.csv', aliases: ['greek super league', 'super league greece'] },
];

// ── Types ──────────────────────────────────────────────────

interface MatchRow {
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
}

interface TeamStats {
  played: number;
  goalsFor: number;
  goalsAgainst: number;
  avgFor: number;
  avgAgainst: number;
}

interface LeagueData {
  matches: MatchRow[];
  homeTeams: Map<string, TeamStats>;
  awayTeams: Map<string, TeamStats>;
  avgHomeGoals: number;
  avgAwayGoals: number;
  fetchedAt: number;
}

export interface PoissonPrediction {
  source: 'poisson-model';
  homeTeam: string;
  awayTeam: string;
  league: string;
  expectedHomeGoals: number;
  expectedAwayGoals: number;
  homePct: number;
  drawPct: number;
  awayPct: number;
  over25Pct: number;
  under25Pct: number;
  btsPct: number;
  confidence: number; // 0-100, based on sample size
}

// ── CSV Parser ─────────────────────────────────────────────

function parseCSV(csv: string): MatchRow[] {
  const lines = csv.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];

  const header = lines[0]!.split(',').map((h) => h.trim());
  const homeIdx = header.findIndex((h) => h === 'HomeTeam' || h === 'Home');
  const awayIdx = header.findIndex((h) => h === 'AwayTeam' || h === 'Away');
  const fthgIdx = header.findIndex((h) => h === 'FTHG' || h === 'HG');
  const ftagIdx = header.findIndex((h) => h === 'FTAG' || h === 'AG');

  if (homeIdx < 0 || awayIdx < 0 || fthgIdx < 0 || ftagIdx < 0) return [];

  const matches: MatchRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(',');
    const homeGoals = parseInt(cols[fthgIdx] || '', 10);
    const awayGoals = parseInt(cols[ftagIdx] || '', 10);
    if (isNaN(homeGoals) || isNaN(awayGoals)) continue;
    matches.push({
      homeTeam: (cols[homeIdx] || '').trim(),
      awayTeam: (cols[awayIdx] || '').trim(),
      homeGoals,
      awayGoals,
    });
  }
  return matches;
}

// ── Data Fetching & Caching ────────────────────────────────

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h
const leagueCache = new Map<string, LeagueData>();

function currentSeasonCode(): string {
  const now = new Date();
  // Season starts in August — if before August, use previous year
  const year = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return `${String(year).slice(-2)}${String(year + 1).slice(-2)}`;
}

async function fetchLeagueData(league: LeagueConfig): Promise<LeagueData | null> {
  const cached = leagueCache.get(league.code);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached;

  const season = currentSeasonCode();
  const url = league.url.replace('{}', season);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return cached || null;
    const csv = await res.text();
    const matches = parseCSV(csv);
    if (matches.length < 20) return cached || null; // too few matches

    // Compute stats
    const homeTeams = new Map<string, TeamStats>();
    const awayTeams = new Map<string, TeamStats>();
    let totalHomeGoals = 0;
    let totalAwayGoals = 0;

    for (const m of matches) {
      totalHomeGoals += m.homeGoals;
      totalAwayGoals += m.awayGoals;

      // Home stats
      const hs = homeTeams.get(m.homeTeam) || { played: 0, goalsFor: 0, goalsAgainst: 0, avgFor: 0, avgAgainst: 0 };
      hs.played++;
      hs.goalsFor += m.homeGoals;
      hs.goalsAgainst += m.awayGoals;
      homeTeams.set(m.homeTeam, hs);

      // Away stats
      const as_ = awayTeams.get(m.awayTeam) || { played: 0, goalsFor: 0, goalsAgainst: 0, avgFor: 0, avgAgainst: 0 };
      as_.played++;
      as_.goalsFor += m.awayGoals;
      as_.goalsAgainst += m.homeGoals;
      awayTeams.set(m.awayTeam, as_);
    }

    // Compute averages
    const avgHomeGoals = totalHomeGoals / matches.length;
    const avgAwayGoals = totalAwayGoals / matches.length;

    for (const [, stats] of homeTeams) {
      stats.avgFor = stats.goalsFor / stats.played;
      stats.avgAgainst = stats.goalsAgainst / stats.played;
    }
    for (const [, stats] of awayTeams) {
      stats.avgFor = stats.goalsFor / stats.played;
      stats.avgAgainst = stats.goalsAgainst / stats.played;
    }

    const data: LeagueData = { matches, homeTeams, awayTeams, avgHomeGoals, avgAwayGoals, fetchedAt: Date.now() };
    leagueCache.set(league.code, data);
    logger.info(`Stats predictor: loaded ${league.name} — ${matches.length} matches, ${homeTeams.size} teams`);
    return data;
  } catch (err) {
    logger.warn(`Stats predictor: failed to fetch ${league.name}: ${err}`);
    return cached || null;
  }
}

// ── Poisson Math ───────────────────────────────────────────

function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

function factorial(n: number): number {
  if (n <= 1) return 1;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

/**
 * Build a goal probability matrix (up to maxGoals each side)
 * and derive 1X2, O/U 2.5, BTS probabilities.
 */
function poissonPredict(expHome: number, expAway: number, maxGoals = 7) {
  let homePct = 0;
  let drawPct = 0;
  let awayPct = 0;
  let over25 = 0;
  let bts = 0;

  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = poissonPmf(h, expHome) * poissonPmf(a, expAway);
      if (h > a) homePct += p;
      else if (h === a) drawPct += p;
      else awayPct += p;

      if (h + a > 2) over25 += p; // strictly > 2.5
      if (h > 0 && a > 0) bts += p;
    }
  }

  return {
    homePct: Math.round(homePct * 1000) / 10,
    drawPct: Math.round(drawPct * 1000) / 10,
    awayPct: Math.round(awayPct * 1000) / 10,
    over25Pct: Math.round(over25 * 1000) / 10,
    under25Pct: Math.round((1 - over25) * 1000) / 10,
    btsPct: Math.round(bts * 1000) / 10,
  };
}

// ── Team Name Matching ─────────────────────────────────────

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\b(fc|sc|cf|ac|as|ss|us|cd|ca|rc|sd|rcd|ud|fk|bk|if|aik)\b/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function teamMatch(query: string, candidate: string): boolean {
  const a = norm(query);
  const b = norm(candidate);
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const fa = a.split(/\s+/)[0]!;
  const fb = b.split(/\s+/)[0]!;
  if (fa.length >= 4 && fa === fb) return true;
  return false;
}

function findLeagueByName(leagueName: string): LeagueConfig | null {
  const n = leagueName.toLowerCase().trim();
  for (const l of LEAGUES) {
    if (l.aliases.some((a) => n.includes(a) || a.includes(n))) return l;
    if (n.includes(l.name.toLowerCase())) return l;
  }
  return null;
}

// ── Public API ─────────────────────────────────────────────

/**
 * Predict a single match using Poisson model.
 * Returns null if we don't have data for the league/teams.
 */
export async function predictMatch(
  homeTeam: string,
  awayTeam: string,
  league?: string,
): Promise<PoissonPrediction | null> {
  // Find league data
  let leagueConfig: LeagueConfig | null = null;
  let data: LeagueData | null = null;

  if (league) {
    leagueConfig = findLeagueByName(league);
  }

  // If no league hint, search all cached leagues for the team
  if (!leagueConfig) {
    for (const l of LEAGUES) {
      const d = leagueCache.get(l.code);
      if (!d) continue;
      const hasHome = [...d.homeTeams.keys()].some((t) => teamMatch(homeTeam, t));
      const hasAway = [...d.awayTeams.keys()].some((t) => teamMatch(awayTeam, t));
      if (hasHome || hasAway) {
        leagueConfig = l;
        data = d;
        break;
      }
    }
  }

  if (!leagueConfig) return null;
  if (!data) data = await fetchLeagueData(leagueConfig);
  if (!data) return null;

  // Find team stats
  const homeKey = [...data.homeTeams.keys()].find((t) => teamMatch(homeTeam, t));
  const awayKey = [...data.awayTeams.keys()].find((t) => teamMatch(awayTeam, t));

  if (!homeKey || !awayKey) return null;

  const homeStats = data.homeTeams.get(homeKey)!;
  const awayStats = data.awayTeams.get(awayKey)!;

  // Attack/Defense strength (relative to league average)
  const homeAttack = homeStats.avgFor / data.avgHomeGoals;
  const homeDefense = homeStats.avgAgainst / data.avgAwayGoals;
  const awayAttack = awayStats.avgFor / data.avgAwayGoals;
  const awayDefense = awayStats.avgAgainst / data.avgHomeGoals;

  // Expected goals
  const expHome = homeAttack * awayDefense * data.avgHomeGoals;
  const expAway = awayAttack * homeDefense * data.avgAwayGoals;

  // Clamp to reasonable range
  const eh = Math.max(0.2, Math.min(5, expHome));
  const ea = Math.max(0.2, Math.min(5, expAway));

  const probs = poissonPredict(eh, ea);

  // Confidence based on sample size
  const minGames = Math.min(homeStats.played, awayStats.played);
  const confidence = Math.min(95, Math.round(minGames * 5));

  return {
    source: 'poisson-model',
    homeTeam,
    awayTeam,
    league: leagueConfig.name,
    expectedHomeGoals: Math.round(eh * 100) / 100,
    expectedAwayGoals: Math.round(ea * 100) / 100,
    ...probs,
    confidence,
  };
}

/**
 * Batch-predict matches. Preloads all league data first.
 */
export async function predictMatches(
  matches: Array<{ homeTeam: string; awayTeam: string; league?: string }>,
): Promise<Map<string, PoissonPrediction>> {
  // Preload all league data in parallel
  await Promise.allSettled(LEAGUES.map((l) => fetchLeagueData(l)));

  const results = new Map<string, PoissonPrediction>();
  for (const m of matches) {
    const pred = await predictMatch(m.homeTeam, m.awayTeam, m.league);
    if (pred) {
      results.set(`${m.homeTeam} vs ${m.awayTeam}`, pred);
    }
  }
  return results;
}

/**
 * Preload all league data (call on server start).
 */
export async function preloadLeagueData(): Promise<void> {
  const results = await Promise.allSettled(LEAGUES.map((l) => fetchLeagueData(l)));
  const loaded = results.filter((r) => r.status === 'fulfilled' && r.value !== null).length;
  logger.info(`Stats predictor: preloaded ${loaded}/${LEAGUES.length} leagues`);
}

/**
 * Get all available teams across all cached leagues.
 */
export function getAvailableTeams(): Array<{ team: string; league: string; homeGames: number; awayGames: number }> {
  const teams: Array<{ team: string; league: string; homeGames: number; awayGames: number }> = [];
  for (const l of LEAGUES) {
    const data = leagueCache.get(l.code);
    if (!data) continue;
    const allTeams = new Set([...data.homeTeams.keys(), ...data.awayTeams.keys()]);
    for (const t of allTeams) {
      teams.push({
        team: t,
        league: l.name,
        homeGames: data.homeTeams.get(t)?.played || 0,
        awayGames: data.awayTeams.get(t)?.played || 0,
      });
    }
  }
  return teams;
}

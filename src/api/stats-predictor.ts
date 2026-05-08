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
  code: string; // football-data.co.uk code (or country code for "extras")
  url: string;
  aliases: string[]; // names used by Sportybet/tipsters
  /**
   * 'main'  → /mmz4281/{season}/CODE.csv  (per-season file, FTHG/FTAG columns)
   * 'extra' → /new/CODE.csv               (multi-year file, HG/AG columns, Season field)
   */
  format: 'main' | 'extra';
}

// Main football-data.co.uk leagues (per-season CSVs).
const MAIN_LEAGUES: LeagueConfig[] = [
  // Top flights
  { country: 'England', name: 'Premier League', code: 'E0', url: 'https://www.football-data.co.uk/mmz4281/{}/E0.csv', aliases: ['premier league', 'epl', 'english premier'], format: 'main' },
  { country: 'England', name: 'Championship', code: 'E1', url: 'https://www.football-data.co.uk/mmz4281/{}/E1.csv', aliases: ['championship', 'efl championship'], format: 'main' },
  { country: 'England', name: 'League One', code: 'E2', url: 'https://www.football-data.co.uk/mmz4281/{}/E2.csv', aliases: ['league one', 'efl league one', 'league 1'], format: 'main' },
  { country: 'England', name: 'League Two', code: 'E3', url: 'https://www.football-data.co.uk/mmz4281/{}/E3.csv', aliases: ['league two', 'efl league two', 'league 2'], format: 'main' },
  { country: 'England', name: 'National League', code: 'EC', url: 'https://www.football-data.co.uk/mmz4281/{}/EC.csv', aliases: ['national league', 'vanarama national'], format: 'main' },
  { country: 'Spain', name: 'La Liga', code: 'SP1', url: 'https://www.football-data.co.uk/mmz4281/{}/SP1.csv', aliases: ['laliga', 'la liga', 'primera division'], format: 'main' },
  { country: 'Spain', name: 'Segunda', code: 'SP2', url: 'https://www.football-data.co.uk/mmz4281/{}/SP2.csv', aliases: ['segunda', 'segunda division', 'la liga 2', 'laliga 2'], format: 'main' },
  { country: 'Germany', name: 'Bundesliga', code: 'D1', url: 'https://www.football-data.co.uk/mmz4281/{}/D1.csv', aliases: ['bundesliga', '1. bundesliga'], format: 'main' },
  { country: 'Germany', name: 'Bundesliga 2', code: 'D2', url: 'https://www.football-data.co.uk/mmz4281/{}/D2.csv', aliases: ['bundesliga 2', '2. bundesliga', 'zweite bundesliga'], format: 'main' },
  { country: 'Italy', name: 'Serie A', code: 'I1', url: 'https://www.football-data.co.uk/mmz4281/{}/I1.csv', aliases: ['serie a', 'italian serie a'], format: 'main' },
  { country: 'Italy', name: 'Serie B', code: 'I2', url: 'https://www.football-data.co.uk/mmz4281/{}/I2.csv', aliases: ['serie b', 'italian serie b'], format: 'main' },
  { country: 'France', name: 'Ligue 1', code: 'F1', url: 'https://www.football-data.co.uk/mmz4281/{}/F1.csv', aliases: ['ligue 1', 'french ligue 1'], format: 'main' },
  { country: 'France', name: 'Ligue 2', code: 'F2', url: 'https://www.football-data.co.uk/mmz4281/{}/F2.csv', aliases: ['ligue 2', 'french ligue 2'], format: 'main' },
  { country: 'Netherlands', name: 'Eredivisie', code: 'N1', url: 'https://www.football-data.co.uk/mmz4281/{}/N1.csv', aliases: ['eredivisie'], format: 'main' },
  { country: 'Portugal', name: 'Liga Portugal', code: 'P1', url: 'https://www.football-data.co.uk/mmz4281/{}/P1.csv', aliases: ['liga portugal', 'primeira liga', 'liga nos'], format: 'main' },
  { country: 'Turkey', name: 'Super Lig', code: 'T1', url: 'https://www.football-data.co.uk/mmz4281/{}/T1.csv', aliases: ['super lig', 'turkish super lig'], format: 'main' },
  { country: 'Belgium', name: 'Pro League', code: 'B1', url: 'https://www.football-data.co.uk/mmz4281/{}/B1.csv', aliases: ['pro league', 'jupiler pro league', 'jupiler league'], format: 'main' },
  { country: 'Scotland', name: 'Premiership', code: 'SC0', url: 'https://www.football-data.co.uk/mmz4281/{}/SC0.csv', aliases: ['scottish premiership', 'spfl premiership'], format: 'main' },
  { country: 'Scotland', name: 'Championship', code: 'SC1', url: 'https://www.football-data.co.uk/mmz4281/{}/SC1.csv', aliases: ['scottish championship', 'spfl championship'], format: 'main' },
  { country: 'Scotland', name: 'League One', code: 'SC2', url: 'https://www.football-data.co.uk/mmz4281/{}/SC2.csv', aliases: ['scottish league one', 'spfl league 1'], format: 'main' },
  { country: 'Scotland', name: 'League Two', code: 'SC3', url: 'https://www.football-data.co.uk/mmz4281/{}/SC3.csv', aliases: ['scottish league two', 'spfl league 2'], format: 'main' },
  { country: 'Greece', name: 'Super League', code: 'G1', url: 'https://www.football-data.co.uk/mmz4281/{}/G1.csv', aliases: ['greek super league', 'super league greece'], format: 'main' },
];

// Worldwide "extra" leagues (multi-year CSVs at /new/CODE.csv).
const EXTRA_LEAGUES: LeagueConfig[] = [
  { country: 'Argentina', name: 'Liga Profesional', code: 'ARG', url: 'https://www.football-data.co.uk/new/ARG.csv', aliases: ['liga profesional', 'primera division argentina', 'argentine primera', 'argentina', 'argentine'], format: 'extra' },
  { country: 'Austria', name: 'Bundesliga (AUT)', code: 'AUT', url: 'https://www.football-data.co.uk/new/AUT.csv', aliases: ['austrian bundesliga', 'austria bundesliga', 'tipico bundesliga'], format: 'extra' },
  { country: 'Brazil', name: 'Serie A (BRA)', code: 'BRA', url: 'https://www.football-data.co.uk/new/BRA.csv', aliases: ['brasileirao', 'brazil serie a', 'brasileirão', 'brazilian serie a'], format: 'extra' },
  { country: 'China', name: 'Super League (CHN)', code: 'CHN', url: 'https://www.football-data.co.uk/new/CHN.csv', aliases: ['chinese super league', 'china super league', 'csl'], format: 'extra' },
  { country: 'Denmark', name: 'Superliga', code: 'DNK', url: 'https://www.football-data.co.uk/new/DNK.csv', aliases: ['danish superliga', 'superliga'], format: 'extra' },
  { country: 'Finland', name: 'Veikkausliiga', code: 'FIN', url: 'https://www.football-data.co.uk/new/FIN.csv', aliases: ['veikkausliiga', 'finnish veikkausliiga'], format: 'extra' },
  { country: 'Ireland', name: 'Premier Division', code: 'IRL', url: 'https://www.football-data.co.uk/new/IRL.csv', aliases: ['irish premier division', 'league of ireland'], format: 'extra' },
  { country: 'Japan', name: 'J League', code: 'JPN', url: 'https://www.football-data.co.uk/new/JPN.csv', aliases: ['j league', 'j1 league', 'jleague', 'japan j league'], format: 'extra' },
  { country: 'Mexico', name: 'Liga MX', code: 'MEX', url: 'https://www.football-data.co.uk/new/MEX.csv', aliases: ['liga mx', 'mexican liga mx', 'liga bbva mx'], format: 'extra' },
  { country: 'Norway', name: 'Eliteserien', code: 'NOR', url: 'https://www.football-data.co.uk/new/NOR.csv', aliases: ['eliteserien', 'norwegian eliteserien'], format: 'extra' },
  { country: 'Poland', name: 'Ekstraklasa', code: 'POL', url: 'https://www.football-data.co.uk/new/POL.csv', aliases: ['ekstraklasa', 'polish ekstraklasa'], format: 'extra' },
  { country: 'Romania', name: 'Liga I', code: 'ROU', url: 'https://www.football-data.co.uk/new/ROU.csv', aliases: ['liga i', 'romanian liga 1', 'superliga romania'], format: 'extra' },
  { country: 'Russia', name: 'Premier League (RUS)', code: 'RUS', url: 'https://www.football-data.co.uk/new/RUS.csv', aliases: ['russian premier league', 'rpl'], format: 'extra' },
  { country: 'Sweden', name: 'Allsvenskan', code: 'SWE', url: 'https://www.football-data.co.uk/new/SWE.csv', aliases: ['allsvenskan', 'swedish allsvenskan'], format: 'extra' },
  { country: 'Switzerland', name: 'Super League (SWZ)', code: 'SWZ', url: 'https://www.football-data.co.uk/new/SWZ.csv', aliases: ['swiss super league', 'super league switzerland', 'credit suisse super league'], format: 'extra' },
  { country: 'USA', name: 'MLS', code: 'USA', url: 'https://www.football-data.co.uk/new/USA.csv', aliases: ['mls', 'major league soccer', 'us mls'], format: 'extra' },
];

const LEAGUES: LeagueConfig[] = [...MAIN_LEAGUES, ...EXTRA_LEAGUES];

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
  over15Pct: number;
  under15Pct: number;
  over25Pct: number;
  under25Pct: number;
  btsPct: number;
  confidence: number; // 0-100, based on sample size
}

// ── CSV Parser ─────────────────────────────────────────────

/** Parser for the "main" /mmz4281/{season}/CODE.csv format — single-season,
 *  uses HomeTeam/AwayTeam/FTHG/FTAG columns. */
function parseMainCSV(csv: string): MatchRow[] {
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

/** Parser for the "extra" /new/CODE.csv format — multi-year, uses
 *  Home/Away/HG/AG and a Season column we filter on. We keep only the
 *  most recent N seasons present in the file so the team-form averages
 *  stay relevant (cross-season squads are similar enough). */
function parseExtraCSV(csv: string, recentSeasons = 2): MatchRow[] {
  const lines = csv.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];

  const header = lines[0]!.split(',').map((h) => h.trim().replace(/^﻿/, ''));
  const homeIdx = header.findIndex((h) => h === 'Home' || h === 'HomeTeam');
  const awayIdx = header.findIndex((h) => h === 'Away' || h === 'AwayTeam');
  const hgIdx = header.findIndex((h) => h === 'HG' || h === 'FTHG');
  const agIdx = header.findIndex((h) => h === 'AG' || h === 'FTAG');
  const seasonIdx = header.findIndex((h) => h === 'Season');

  if (homeIdx < 0 || awayIdx < 0 || hgIdx < 0 || agIdx < 0) return [];

  // First pass — collect distinct seasons.
  const seasons = new Set<string>();
  if (seasonIdx >= 0) {
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i]!.split(',');
      const s = (cols[seasonIdx] || '').trim();
      if (s) seasons.add(s);
    }
  }
  const sortedSeasons = [...seasons].sort();
  const keep = new Set(sortedSeasons.slice(-recentSeasons));

  const matches: MatchRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(',');
    if (seasonIdx >= 0) {
      const s = (cols[seasonIdx] || '').trim();
      if (s && keep.size > 0 && !keep.has(s)) continue;
    }
    const homeGoals = parseInt(cols[hgIdx] || '', 10);
    const awayGoals = parseInt(cols[agIdx] || '', 10);
    if (isNaN(homeGoals) || isNaN(awayGoals)) continue;
    const home = (cols[homeIdx] || '').trim();
    const away = (cols[awayIdx] || '').trim();
    if (!home || !away) continue;
    matches.push({ homeTeam: home, awayTeam: away, homeGoals, awayGoals });
  }
  return matches;
}

function parseCSV(csv: string, format: 'main' | 'extra'): MatchRow[] {
  return format === 'extra' ? parseExtraCSV(csv) : parseMainCSV(csv);
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

  // Main format has {} placeholder for season; extras use a fixed URL.
  const url = league.format === 'extra'
    ? league.url
    : league.url.replace('{}', currentSeasonCode());

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return cached || null;
    const csv = await res.text();
    const matches = parseCSV(csv, league.format);
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
  let over15 = 0;
  let over25 = 0;
  let bts = 0;

  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = poissonPmf(h, expHome) * poissonPmf(a, expAway);
      if (h > a) homePct += p;
      else if (h === a) drawPct += p;
      else awayPct += p;

      if (h + a > 1) over15 += p; // strictly > 1.5
      if (h + a > 2) over25 += p; // strictly > 2.5
      if (h > 0 && a > 0) bts += p;
    }
  }

  return {
    homePct: Math.round(homePct * 1000) / 10,
    drawPct: Math.round(drawPct * 1000) / 10,
    awayPct: Math.round(awayPct * 1000) / 10,
    over15Pct: Math.round(over15 * 1000) / 10,
    under15Pct: Math.round((1 - over15) * 1000) / 10,
    over25Pct: Math.round(over25 * 1000) / 10,
    under25Pct: Math.round((1 - over25) * 1000) / 10,
    btsPct: Math.round(bts * 1000) / 10,
  };
}

// ── Team Name Matching ─────────────────────────────────────

function norm(s: string): string {
  const base = s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  // Strip club-suffix tokens \u2014 but only if the result still has content.
  // Otherwise short names like "AIK" would normalize to empty and become
  // wildcard substrings (.includes("") is always true).
  const stripped = base
    .replace(/\b(fc|sc|cf|ac|as|ss|us|cd|ca|rc|sd|rcd|ud|fk|bk|if|aik|hd)\b/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  return stripped.length >= 3 ? stripped : base;
}

/** 0-100 match-quality score. 100 = exact, \u226545 considered a match. */
function matchScore(query: string, candidate: string): number {
  const a = norm(query);
  const b = norm(candidate);
  if (!a || !b || a.length < 2 || b.length < 2) return 0;
  if (a === b) return 100;

  const ta = new Set(a.split(/\s+/).filter(t => t.length >= 3));
  const tb = new Set(b.split(/\s+/).filter(t => t.length >= 3));

  if (ta.size === 0 || tb.size === 0) {
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    if (shorter.length >= 3 && longer.includes(shorter)) {
      const ratio = shorter.length / longer.length;
      return Math.round(60 * ratio + 20);
    }
    return 0;
  }

  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;

  if (intersection === 0) {
    if (a.length >= 4 && b.length >= 4) {
      if (b.includes(a)) return Math.round(40 * (a.length / b.length) + 20);
      if (a.includes(b)) return Math.round(40 * (b.length / a.length) + 20);
    }
    return 0;
  }

  const union = ta.size + tb.size - intersection;
  const jaccard = intersection / union;
  let score = Math.round(jaccard * 80);

  if (a.includes(b) || b.includes(a)) score += 15;

  const fa = a.split(/\s+/)[0]!;
  const fb = b.split(/\s+/)[0]!;
  if (fa.length >= 3 && fa === fb) score += 5;

  return Math.min(99, score);
}

/** Best-scoring key from an iterable, or null if none clears threshold. */
function bestKey(query: string, keys: Iterable<string>, threshold = 45): { key: string; score: number } | null {
  let best: { key: string; score: number } | null = null;
  for (const k of keys) {
    const s = matchScore(query, k);
    if (s >= threshold && (!best || s > best.score)) best = { key: k, score: s };
  }
  return best;
}

function teamMatch(query: string, candidate: string, threshold = 45): boolean {
  return matchScore(query, candidate) >= threshold;
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
  let leagueConfig: LeagueConfig | null = null;
  let data: LeagueData | null = null;

  if (league) leagueConfig = findLeagueByName(league);

  // No hint — score every cached league by combined match quality and
  // pick the best. This avoids "Internacional" matching "Inter" in Italy
  // when the better match exists in Brazil's Serie A.
  if (!leagueConfig) {
    let bestScore = 0;
    for (const l of LEAGUES) {
      const d = leagueCache.get(l.code);
      if (!d) continue;
      const homeBest = bestKey(homeTeam, d.homeTeams.keys());
      const awayBest = bestKey(awayTeam, d.awayTeams.keys());
      if (!homeBest && !awayBest) continue;
      // Require BOTH to be present at meaningful quality — falling back
      // to a league where only one team is found gives garbage form
      // averages on the missing side.
      const combined = (homeBest?.score ?? 0) + (awayBest?.score ?? 0);
      if (homeBest && awayBest && combined > bestScore) {
        bestScore = combined;
        leagueConfig = l;
        data = d;
      }
    }
  }

  if (!leagueConfig) return null;
  if (!data) data = await fetchLeagueData(leagueConfig);
  if (!data) return null;

  const homeKey = bestKey(homeTeam, data.homeTeams.keys())?.key
    ?? bestKey(homeTeam, data.awayTeams.keys())?.key;
  const awayKey = bestKey(awayTeam, data.awayTeams.keys())?.key
    ?? bestKey(awayTeam, data.homeTeams.keys())?.key;
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

// ── Form + H2H accessors ───────────────────────────────────

export interface TeamFormDetail {
  team: string;
  league: string;
  /** Combined home + away W/D/L from this team's perspective. */
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  /** Average per game. */
  avgFor: number;
  avgAgainst: number;
  /** Points per game (3W + 1D). */
  ppg: number;
  /** Home-game split. */
  home: { played: number; wins: number; draws: number; losses: number; goalsFor: number; goalsAgainst: number };
  /** Away-game split. */
  away: { played: number; wins: number; draws: number; losses: number; goalsFor: number; goalsAgainst: number };
  /** Last N results, newest first: 'W' | 'D' | 'L'. */
  recentForm: string[];
  /** Strength indices used by the Poisson model. */
  homeAttackIndex: number;
  homeDefenseIndex: number;
  awayAttackIndex: number;
  awayDefenseIndex: number;
}

export interface H2HDetail {
  played: number;
  homeWins: number;
  draws: number;
  awayWins: number;
  avgGoals: number;
  recent: Array<{ home: string; away: string; homeGoals: number; awayGoals: number }>;
}

function findCachedLeague(team: string, leagueHint?: string): { config: LeagueConfig; data: LeagueData } | null {
  if (leagueHint) {
    const lc = findLeagueByName(leagueHint);
    if (lc) {
      const d = leagueCache.get(lc.code);
      if (d) return { config: lc, data: d };
    }
  }
  // Score every cached league, return the one with the strongest match.
  let bestScore = 0;
  let bestRet: { config: LeagueConfig; data: LeagueData } | null = null;
  for (const lc of LEAGUES) {
    const d = leagueCache.get(lc.code);
    if (!d) continue;
    const fromHome = bestKey(team, d.homeTeams.keys());
    const fromAway = bestKey(team, d.awayTeams.keys());
    const score = Math.max(fromHome?.score ?? 0, fromAway?.score ?? 0);
    if (score > bestScore) {
      bestScore = score;
      bestRet = { config: lc, data: d };
    }
  }
  return bestRet;
}

/**
 * Get full per-team form from the cached league data. Reads the raw match
 * list so we can compute splits + recent-N form, not just the aggregate
 * counts the model uses internally.
 */
export async function getTeamFormDetail(team: string, leagueHint?: string, recentN = 5): Promise<TeamFormDetail | null> {
  // Make sure data is loaded for the league.
  if (leagueHint) {
    const lc = findLeagueByName(leagueHint);
    if (lc && !leagueCache.get(lc.code)) await fetchLeagueData(lc);
  } else {
    await Promise.allSettled(LEAGUES.map(l => fetchLeagueData(l)));
  }

  const found = findCachedLeague(team, leagueHint);
  if (!found) return null;
  const { config, data } = found;

  // Resolve canonical team name — best-scoring key wins.
  const homeKey = bestKey(team, data.homeTeams.keys())?.key;
  const awayKey = bestKey(team, data.awayTeams.keys())?.key;
  const canonical = homeKey || awayKey;
  if (!canonical) return null;

  // Walk the match list (in CSV order — earliest first) and split.
  const home = { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0 };
  const away = { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0 };
  const allResults: Array<{ result: 'W' | 'D' | 'L'; idx: number }> = [];

  for (let i = 0; i < data.matches.length; i++) {
    const m = data.matches[i]!;
    if (teamMatch(team, m.homeTeam)) {
      home.played++;
      home.goalsFor += m.homeGoals;
      home.goalsAgainst += m.awayGoals;
      const r: 'W' | 'D' | 'L' = m.homeGoals > m.awayGoals ? 'W' : m.homeGoals < m.awayGoals ? 'L' : 'D';
      home[r === 'W' ? 'wins' : r === 'D' ? 'draws' : 'losses']++;
      allResults.push({ result: r, idx: i });
    } else if (teamMatch(team, m.awayTeam)) {
      away.played++;
      away.goalsFor += m.awayGoals;
      away.goalsAgainst += m.homeGoals;
      const r: 'W' | 'D' | 'L' = m.awayGoals > m.homeGoals ? 'W' : m.awayGoals < m.homeGoals ? 'L' : 'D';
      away[r === 'W' ? 'wins' : r === 'D' ? 'draws' : 'losses']++;
      allResults.push({ result: r, idx: i });
    }
  }

  const played = home.played + away.played;
  if (played === 0) return null;
  const wins = home.wins + away.wins;
  const draws = home.draws + away.draws;
  const losses = home.losses + away.losses;
  const goalsFor = home.goalsFor + away.goalsFor;
  const goalsAgainst = home.goalsAgainst + away.goalsAgainst;

  // Recent N (newest first — by CSV index).
  allResults.sort((a, b) => b.idx - a.idx);
  const recentForm = allResults.slice(0, recentN).map(r => r.result);

  // Strength indices straight from the Poisson model's accumulators.
  const hs = data.homeTeams.get(canonical);
  const as_ = data.awayTeams.get(canonical);
  const homeAttackIndex = hs && data.avgHomeGoals > 0 ? hs.avgFor / data.avgHomeGoals : 1;
  const homeDefenseIndex = hs && data.avgAwayGoals > 0 ? hs.avgAgainst / data.avgAwayGoals : 1;
  const awayAttackIndex = as_ && data.avgAwayGoals > 0 ? as_.avgFor / data.avgAwayGoals : 1;
  const awayDefenseIndex = as_ && data.avgHomeGoals > 0 ? as_.avgAgainst / data.avgHomeGoals : 1;

  return {
    team: canonical,
    league: config.name,
    played,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    avgFor: goalsFor / played,
    avgAgainst: goalsAgainst / played,
    ppg: (wins * 3 + draws) / played,
    home,
    away,
    recentForm,
    homeAttackIndex,
    homeDefenseIndex,
    awayAttackIndex,
    awayDefenseIndex,
  };
}

/**
 * Head-to-head between two teams in any league we cover. Returns the
 * full historical (current-season) record and last few meetings.
 */
export async function getH2HDetail(homeTeam: string, awayTeam: string, leagueHint?: string, recentN = 5): Promise<H2HDetail | null> {
  if (leagueHint) {
    const lc = findLeagueByName(leagueHint);
    if (lc && !leagueCache.get(lc.code)) await fetchLeagueData(lc);
  } else {
    await Promise.allSettled(LEAGUES.map(l => fetchLeagueData(l)));
  }

  // Find the league that contains BOTH teams with the strongest combined match.
  let data: LeagueData | null = null;
  let bestCombined = 0;
  for (const lc of LEAGUES) {
    const d = leagueCache.get(lc.code);
    if (!d) continue;
    const allKeys = new Set([...d.homeTeams.keys(), ...d.awayTeams.keys()]);
    const homeBest = bestKey(homeTeam, allKeys);
    const awayBest = bestKey(awayTeam, allKeys);
    if (!homeBest || !awayBest) continue;
    const combined = homeBest.score + awayBest.score;
    if (combined > bestCombined) { bestCombined = combined; data = d; }
  }
  if (!data) return null;

  const h2hMatches: typeof data.matches = [];
  for (const m of data.matches) {
    const isAB = teamMatch(homeTeam, m.homeTeam) && teamMatch(awayTeam, m.awayTeam);
    const isBA = teamMatch(awayTeam, m.homeTeam) && teamMatch(homeTeam, m.awayTeam);
    if (isAB || isBA) h2hMatches.push(m);
  }
  if (h2hMatches.length === 0) return { played: 0, homeWins: 0, draws: 0, awayWins: 0, avgGoals: 0, recent: [] };

  // Tally from the requested home/away viewpoint.
  let homeWins = 0, draws = 0, awayWins = 0;
  let totalGoals = 0;
  for (const m of h2hMatches) {
    totalGoals += m.homeGoals + m.awayGoals;
    const homePerspective = teamMatch(homeTeam, m.homeTeam);
    if (m.homeGoals === m.awayGoals) draws++;
    else if ((homePerspective && m.homeGoals > m.awayGoals) || (!homePerspective && m.awayGoals > m.homeGoals)) {
      homeWins++;
    } else {
      awayWins++;
    }
  }
  // CSV order is chronological earliest-first; reverse for "recent first."
  const recent = h2hMatches.slice(-recentN).reverse().map(m => ({
    home: m.homeTeam,
    away: m.awayTeam,
    homeGoals: m.homeGoals,
    awayGoals: m.awayGoals,
  }));

  return {
    played: h2hMatches.length,
    homeWins,
    draws,
    awayWins,
    avgGoals: totalGoals / h2hMatches.length,
    recent,
  };
}

/** League-wide averages (home goals + away goals) — useful context for the UI. */
export async function getLeagueAverages(leagueHint?: string): Promise<{ league: string; avgHomeGoals: number; avgAwayGoals: number; matches: number } | null> {
  if (leagueHint) {
    const lc = findLeagueByName(leagueHint);
    if (!lc) return null;
    const d = leagueCache.get(lc.code) || await fetchLeagueData(lc);
    if (!d) return null;
    return { league: lc.name, avgHomeGoals: d.avgHomeGoals, avgAwayGoals: d.avgAwayGoals, matches: d.matches.length };
  }
  return null;
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

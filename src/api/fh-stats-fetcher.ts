/**
 * First-Half Statistics Fetcher (CURRENT SEASON 2025-26)
 *
 * Primary source: football-data.co.uk CSV files
 *   - Current season half-time scores for 16 leagues
 *   - Real bookmaker Asian Handicap odds for validation
 *   - Updated weekly
 *
 * Fallback: openfootball GitHub (current season JSON with HT scores)
 *
 * Leagues covered:
 *   E0=EPL, E1=Championship, E2=League One,
 *   SP1=La Liga, SP2=La Liga 2,
 *   D1=Bundesliga, D2=2.Bundesliga,
 *   I1=Serie A, I2=Serie B,
 *   F1=Ligue 1, F2=Ligue 2,
 *   N1=Eredivisie, B1=Pro League,
 *   P1=Liga Portugal, T1=Super Lig, G1=Super League
 */

import { logger } from '../utils/logger.js';

export interface TeamFHStats {
  name: string;
  league: string;
  fhScoredAvg: number;
  fhConcededAvg: number;
  fhScoredHome: number;
  fhScoredAway: number;
  fhConcededHome: number;
  fhConcededAway: number;
  gamesPlayed: number;
  form: string;
  cleanSheetsFH: number;
  scoredFirstHalf: number;
  // Bookmaker validation data
  avgAHLine: number | null;    // average Asian Handicap line when at home
  avgAHOdds: number | null;    // average AH odds
}

interface CsvRow {
  HomeTeam: string;
  AwayTeam: string;
  FTHG: string;
  FTAG: string;
  FTR: string;
  HTHG: string;
  HTAG: string;
  Date: string;
  AHh?: string;
  B365AHH?: string;
  B365AHA?: string;
}

// Cache
let statsCache: Map<string, TeamFHStats> | null = null;
let statsCacheTime = 0;
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

const LEAGUES: { id: string; label: string }[] = [
  { id: 'E0', label: 'Premier League' },
  { id: 'E1', label: 'Championship' },
  { id: 'SP1', label: 'La Liga' },
  { id: 'SP2', label: 'La Liga 2' },
  { id: 'D1', label: 'Bundesliga' },
  { id: 'D2', label: '2. Bundesliga' },
  { id: 'I1', label: 'Serie A' },
  { id: 'I2', label: 'Serie B' },
  { id: 'F1', label: 'Ligue 1' },
  { id: 'F2', label: 'Ligue 2' },
  { id: 'N1', label: 'Eredivisie' },
  { id: 'B1', label: 'Pro League' },
  { id: 'P1', label: 'Liga Portugal' },
  { id: 'T1', label: 'Super Lig' },
  { id: 'G1', label: 'Super League Greece' },
];

const CSV_BASE = 'https://www.football-data.co.uk/mmz4281/2526';

// Also try openfootball for current season
const OPENFOOTBALL_LEAGUES: { id: string; label: string }[] = [
  { id: 'en.1', label: 'Premier League' },
  { id: 'es.1', label: 'La Liga' },
  { id: 'de.1', label: 'Bundesliga' },
  { id: 'it.1', label: 'Serie A' },
  { id: 'fr.1', label: 'Ligue 1' },
];
const OPENFOOTBALL_BASE = 'https://raw.githubusercontent.com/openfootball/football.json/master/2025-26';

/** Parse a CSV string into an array of objects */
function parseCsv(text: string): CsvRow[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];

  // Remove BOM if present
  let headerLine = lines[0]!;
  if (headerLine.charCodeAt(0) === 0xFEFF) headerLine = headerLine.slice(1);

  const headers = headerLine.split(',');
  const rows: CsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i]!.split(',');
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = values[j] || '';
    }
    rows.push(row as unknown as CsvRow);
  }
  return rows;
}

async function fetchLeagueCsv(leagueId: string): Promise<CsvRow[]> {
  try {
    const res = await fetch(`${CSV_BASE}/${leagueId}.csv`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const text = await res.text();
    return parseCsv(text);
  } catch {
    return [];
  }
}

async function fetchOpenfootballLeague(leagueId: string): Promise<CsvRow[]> {
  try {
    const res = await fetch(`${OPENFOOTBALL_BASE}/${leagueId}.json`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json() as {
      matches: Array<{
        team1: string;
        team2: string;
        date: string;
        score?: { ht?: [number, number]; ft?: [number, number] };
      }>;
    };

    // Convert to CSV-like format
    return (data.matches || [])
      .filter(m => m.score?.ht && m.score?.ft)
      .map(m => ({
        HomeTeam: m.team1,
        AwayTeam: m.team2,
        FTHG: String(m.score!.ft![0]),
        FTAG: String(m.score!.ft![1]),
        FTR: m.score!.ft![0] > m.score!.ft![1] ? 'H' : m.score!.ft![0] < m.score!.ft![1] ? 'A' : 'D',
        HTHG: String(m.score!.ht![0]),
        HTAG: String(m.score!.ht![1]),
        Date: m.date,
      }));
  } catch {
    return [];
  }
}

interface TeamAccumulator {
  fhScoredHome: number[];
  fhScoredAway: number[];
  fhConcededHome: number[];
  fhConcededAway: number[];
  results: string[]; // full-time results ordered by date
  ahLines: number[]; // Asian Handicap lines when at home
  ahOdds: number[];
}

function calculateStats(rows: CsvRow[], leagueLabel: string): Map<string, TeamFHStats> {
  const teams: Record<string, TeamAccumulator> = {};

  for (const r of rows) {
    if (!r.HTHG || !r.HTAG || r.HTHG === '' || r.HTAG === '') continue;
    const hthg = parseInt(r.HTHG);
    const htag = parseInt(r.HTAG);
    if (isNaN(hthg) || isNaN(htag)) continue;

    const home = r.HomeTeam;
    const away = r.AwayTeam;
    if (!home || !away) continue;

    // Initialize team accumulators
    for (const t of [home, away]) {
      if (!teams[t]) {
        teams[t] = {
          fhScoredHome: [], fhScoredAway: [],
          fhConcededHome: [], fhConcededAway: [],
          results: [], ahLines: [], ahOdds: [],
        };
      }
    }

    // Home team stats
    teams[home]!.fhScoredHome.push(hthg);
    teams[home]!.fhConcededHome.push(htag);

    // Away team stats
    teams[away]!.fhScoredAway.push(htag);
    teams[away]!.fhConcededAway.push(hthg);

    // Full-time results for form
    const ftr = r.FTR;
    if (ftr === 'H') {
      teams[home]!.results.push('W');
      teams[away]!.results.push('L');
    } else if (ftr === 'A') {
      teams[home]!.results.push('L');
      teams[away]!.results.push('W');
    } else {
      teams[home]!.results.push('D');
      teams[away]!.results.push('D');
    }

    // Asian handicap data
    if (r.AHh && r.B365AHH) {
      const ahLine = parseFloat(r.AHh);
      const ahOdds = parseFloat(r.B365AHH);
      if (!isNaN(ahLine) && !isNaN(ahOdds)) {
        teams[home]!.ahLines.push(ahLine);
        teams[home]!.ahOdds.push(ahOdds);
      }
    }
  }

  const stats = new Map<string, TeamFHStats>();
  const avg = (arr: number[]) => arr.length > 0
    ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100
    : 0;

  for (const [name, t] of Object.entries(teams)) {
    const allScored = [...t.fhScoredHome, ...t.fhScoredAway];
    const allConceded = [...t.fhConcededHome, ...t.fhConcededAway];
    const cleanSheets = allConceded.filter(g => g === 0).length;
    const scoredFH = allScored.filter(g => g > 0).length;
    const total = allScored.length;

    if (total < 3) continue; // Need at least 3 games

    stats.set(name.toLowerCase(), {
      name,
      league: leagueLabel,
      fhScoredAvg: avg(allScored),
      fhConcededAvg: avg(allConceded),
      fhScoredHome: avg(t.fhScoredHome),
      fhScoredAway: avg(t.fhScoredAway),
      fhConcededHome: avg(t.fhConcededHome),
      fhConcededAway: avg(t.fhConcededAway),
      gamesPlayed: total,
      form: t.results.slice(-5).join(''),
      cleanSheetsFH: total > 0 ? Math.round((cleanSheets / total) * 100) : 0,
      scoredFirstHalf: total > 0 ? Math.round((scoredFH / total) * 100) : 0,
      avgAHLine: t.ahLines.length > 0 ? avg(t.ahLines) : null,
      avgAHOdds: t.ahOdds.length > 0 ? avg(t.ahOdds) : null,
    });
  }

  return stats;
}

/**
 * Get all team first-half statistics from 16 leagues (current 2025-26 season).
 * Primary: football-data.co.uk CSV (has AH odds too)
 * Fallback: openfootball GitHub JSON
 */
export async function getAllTeamFHStats(): Promise<Map<string, TeamFHStats>> {
  if (statsCache && Date.now() - statsCacheTime < CACHE_TTL) {
    return statsCache;
  }

  const allStats = new Map<string, TeamFHStats>();

  // Fetch all CSV leagues in parallel
  const csvResults = await Promise.allSettled(
    LEAGUES.map(async (league) => {
      const rows = await fetchLeagueCsv(league.id);
      return { label: league.label, rows };
    }),
  );

  let csvTeams = 0;
  for (const result of csvResults) {
    if (result.status !== 'fulfilled' || result.value.rows.length === 0) continue;
    const leagueStats = calculateStats(result.value.rows, result.value.label);
    for (const [key, stats] of leagueStats) {
      allStats.set(key, stats);
      csvTeams++;
    }
  }

  // Also fetch openfootball as supplement (different team name formats)
  const ofResults = await Promise.allSettled(
    OPENFOOTBALL_LEAGUES.map(async (league) => {
      const rows = await fetchOpenfootballLeague(league.id);
      return { label: league.label + ' (OF)', rows };
    }),
  );

  let ofTeams = 0;
  for (const result of ofResults) {
    if (result.status !== 'fulfilled' || result.value.rows.length === 0) continue;
    const leagueStats = calculateStats(result.value.rows, result.value.label);
    for (const [key, stats] of leagueStats) {
      // Only add if we don't already have this team from CSV
      if (!allStats.has(key)) {
        allStats.set(key, stats);
        ofTeams++;
      }
    }
  }

  if (allStats.size > 0) {
    statsCache = allStats;
    statsCacheTime = Date.now();
    logger.info(
      { totalTeams: allStats.size, csvTeams, ofTeams },
      'FH stats cache refreshed (2025-26 season)',
    );
  }

  return allStats;
}

/**
 * Fuzzy match a team name from our DB to the stats dataset.
 */
export function findTeamFHStats(
  teamName: string,
  allStats: Map<string, TeamFHStats>,
): TeamFHStats | null {
  const norm = teamName.toLowerCase().trim();

  // Direct match
  if (allStats.has(norm)) return allStats.get(norm)!;

  // Common suffixes/prefixes to strip
  const variations = [
    norm,
    norm.replace(/ fc$/, ''),
    norm.replace(/^fc /, ''),
    norm.replace(/ cf$/, ''),
    norm.replace(/ sc$/, ''),
    norm.replace(/ afc$/, ''),
  ];

  for (const v of variations) {
    if (allStats.has(v)) return allStats.get(v)!;
  }

  // Substring matching — require 6+ chars to avoid false positives
  for (const [key, stats] of allStats) {
    const keyClean = key.replace(/ fc$/, '').replace(/^fc /, '').trim();
    const normClean = norm.replace(/ fc$/, '').replace(/^fc /, '').trim();

    if (normClean.length >= 6 && keyClean.length >= 6) {
      if (keyClean === normClean) return stats;
      const shorter = normClean.length < keyClean.length ? normClean : keyClean;
      const longer = normClean.length >= keyClean.length ? normClean : keyClean;
      if (shorter.length >= 6 && longer.includes(shorter)) return stats;
    }
  }

  // Strict word overlap — distinctive words only (5+ chars, no generic terms)
  const generic = new Set(['united', 'city', 'sport', 'club', 'real', 'racing', 'athletic', 'royal']);
  const normWords = norm.split(/\s+/).filter(w => w.length >= 5 && !generic.has(w));
  if (normWords.length >= 1) {
    let bestMatch: TeamFHStats | null = null;
    let bestOverlap = 0;
    for (const [key, stats] of allStats) {
      const keyWords = key.split(/\s+/).filter(w => w.length >= 4);
      const overlap = normWords.filter(w => keyWords.some(kw => kw === w)).length;
      if (overlap > bestOverlap && overlap >= 1) {
        bestOverlap = overlap;
        bestMatch = stats;
      }
    }
    if (bestMatch) return bestMatch;
  }

  return null;
}

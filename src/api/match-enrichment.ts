/**
 * Match Enrichment Layer
 *
 * Fetches additional free data to improve handicap predictions:
 * 1. Real bookmaker AH odds from football-data.co.uk fixtures.csv
 * 2. Referee FH goal stats from historical CSV data
 * 3. Shots/cards/fouls per team from CSV (attacking intensity)
 * 4. Weather from Open-Meteo API (free, no key)
 *
 * All data sources are free with no API key required.
 */

import { logger } from '../utils/logger.js';

// ===== TYPES =====

export interface FixtureOdds {
  homeTeam: string;
  awayTeam: string;
  date: string;
  ahLine: number;        // Asian Handicap line (e.g. -1.5)
  ahOddsHome: number;    // Bet365 AH odds for home
  ahOddsAway: number;    // Bet365 AH odds for away
  b365Home: number;      // Bet365 1X2 home odds
  b365Draw: number;
  b365Away: number;
  ouLine25Home: number;  // Over 2.5 odds
  ouLine25Away: number;  // Under 2.5 odds
  referee: string;
}

export interface RefereeStats {
  name: string;
  games: number;
  avgFHGoals: number;    // average first-half goals per game
  avgFTGoals: number;    // average full-time goals per game
  avgCards: number;       // average cards per game
  avgFouls: number;       // average fouls per game
  fhGoalRate: number;    // relative to league average (1.0 = average)
}

export interface TeamIntensity {
  name: string;
  avgShots: number;      // total shots per game
  avgShotsTarget: number; // shots on target per game
  avgCorners: number;
  avgFouls: number;
  avgCards: number;
}

export interface WeatherData {
  temp: number;
  rain: number;          // mm/hr
  windSpeed: number;     // km/h
  description: string;
}

// ===== CACHES =====

let fixturesCache: FixtureOdds[] | null = null;
let fixturesCacheTime = 0;
let refereeCache: Map<string, RefereeStats> | null = null;
let refereeCacheTime = 0;
let intensityCache: Map<string, TeamIntensity> | null = null;
let intensityCacheTime = 0;
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

// ===== CSV PARSING =====

function parseCsvLine(line: string): string[] {
  return line.split(',');
}

function parseCsvText(text: string): Record<string, string>[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  let header = lines[0]!;
  if (header.charCodeAt(0) === 0xFEFF) header = header.slice(1);
  const cols = header.split(',');
  return lines.slice(1).map(line => {
    const vals = parseCsvLine(line);
    const obj: Record<string, string> = {};
    cols.forEach((col, i) => { obj[col] = vals[i] || ''; });
    return obj;
  });
}

// ===== FIXTURES WITH ODDS =====

export async function getUpcomingFixtureOdds(): Promise<FixtureOdds[]> {
  if (fixturesCache && Date.now() - fixturesCacheTime < CACHE_TTL) {
    return fixturesCache;
  }

  try {
    const res = await fetch('https://www.football-data.co.uk/fixtures.csv', {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const text = await res.text();
    const rows = parseCsvText(text);

    const fixtures: FixtureOdds[] = [];
    for (const r of rows) {
      if (!r.HomeTeam || !r.AwayTeam) continue;
      fixtures.push({
        homeTeam: r.HomeTeam,
        awayTeam: r.AwayTeam,
        date: r.Date || '',
        ahLine: parseFloat(r.AHh || '') || 0,
        ahOddsHome: parseFloat(r.B365AHH || '') || 0,
        ahOddsAway: parseFloat(r.B365AHA || '') || 0,
        b365Home: parseFloat(r.B365H || '') || 0,
        b365Draw: parseFloat(r.B365D || '') || 0,
        b365Away: parseFloat(r.B365A || '') || 0,
        ouLine25Home: parseFloat(r['B365>2.5'] || '') || 0,
        ouLine25Away: parseFloat(r['B365<2.5'] || '') || 0,
        referee: r.Referee || '',
      });
    }

    fixturesCache = fixtures;
    fixturesCacheTime = Date.now();
    logger.info({ fixtures: fixtures.length }, 'Loaded upcoming fixture odds');
    return fixtures;
  } catch {
    return fixturesCache || [];
  }
}

/**
 * Find fixture odds for a specific match by fuzzy team name matching.
 */
export function findFixtureOdds(
  homeTeam: string,
  awayTeam: string,
  fixtures: FixtureOdds[],
): FixtureOdds | null {
  const normH = homeTeam.toLowerCase().replace(/ fc$/, '').trim();
  const normA = awayTeam.toLowerCase().replace(/ fc$/, '').trim();

  for (const f of fixtures) {
    const fH = f.homeTeam.toLowerCase().replace(/ fc$/, '').trim();
    const fA = f.awayTeam.toLowerCase().replace(/ fc$/, '').trim();

    // Exact or substring match
    if ((fH === normH || fH.includes(normH) || normH.includes(fH)) &&
        (fA === normA || fA.includes(normA) || normA.includes(fA))) {
      return f;
    }
  }
  return null;
}

// ===== REFEREE STATS =====

export async function getRefereeStats(): Promise<Map<string, RefereeStats>> {
  if (refereeCache && Date.now() - refereeCacheTime < CACHE_TTL) {
    return refereeCache;
  }

  const map = new Map<string, RefereeStats>();

  // Fetch multiple leagues for referee coverage
  const leagues = ['E0', 'SP1', 'D1', 'I1', 'F1', 'E1', 'N1'];
  const results = await Promise.allSettled(
    leagues.map(async (id) => {
      const res = await fetch(`https://www.football-data.co.uk/mmz4281/2526/${id}.csv`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return [];
      return parseCsvText(await res.text());
    }),
  );

  const refs: Record<string, { games: number; fhGoals: number; ftGoals: number; cards: number; fouls: number }> = {};
  let totalGames = 0;
  let totalFHGoals = 0;

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const r of result.value) {
      const ref = r.Referee;
      if (!ref || !r.HTHG || !r.HTAG) continue;

      if (!refs[ref]) refs[ref] = { games: 0, fhGoals: 0, ftGoals: 0, cards: 0, fouls: 0 };
      refs[ref]!.games++;
      const fhGoals = (parseInt(r.HTHG || '0') || 0) + (parseInt(r.HTAG || '0') || 0);
      refs[ref]!.fhGoals += fhGoals;
      refs[ref]!.ftGoals += (parseInt(r.FTHG || '0') || 0) + (parseInt(r.FTAG || '0') || 0);
      refs[ref]!.cards += (parseInt(r.HY || '0') || 0) + (parseInt(r.AY || '0') || 0);
      refs[ref]!.fouls += (parseInt(r.HF || '0') || 0) + (parseInt(r.AF || '0') || 0);

      totalGames++;
      totalFHGoals += fhGoals;
    }
  }

  const leagueAvgFH = totalGames > 0 ? totalFHGoals / totalGames : 1.1;

  for (const [name, d] of Object.entries(refs)) {
    if (d.games < 3) continue;
    const avgFH = d.fhGoals / d.games;
    map.set(name.toLowerCase(), {
      name,
      games: d.games,
      avgFHGoals: Math.round(avgFH * 100) / 100,
      avgFTGoals: Math.round((d.ftGoals / d.games) * 100) / 100,
      avgCards: Math.round((d.cards / d.games) * 10) / 10,
      avgFouls: Math.round((d.fouls / d.games) * 10) / 10,
      fhGoalRate: Math.round((avgFH / leagueAvgFH) * 100) / 100,
    });
  }

  refereeCache = map;
  refereeCacheTime = Date.now();
  logger.info({ referees: map.size }, 'Loaded referee FH stats');
  return map;
}

// ===== WEATHER =====

// Stadium coordinates for major teams (can expand)
const STADIUM_COORDS: Record<string, [number, number]> = {
  liverpool: [53.43, -2.96], arsenal: [51.555, -0.108], chelsea: [51.482, -0.191],
  'man city': [53.483, -2.200], 'man united': [53.463, -2.291], tottenham: [51.604, -0.066],
  'west ham': [51.539, 0.017], newcastle: [54.975, -1.622], everton: [53.439, -2.966],
  'aston villa': [52.509, -1.885], barcelona: [41.381, 2.123], 'real madrid': [40.453, -3.688],
  'bayern munich': [48.219, 11.625], juventus: [45.110, 7.641], 'ac milan': [45.478, 9.124],
  psg: [48.842, 2.253], lyon: [45.765, 4.982], marseille: [43.270, 5.396],
  freiburg: [48.022, 7.895], dortmund: [51.493, 7.452],
};

export async function getMatchWeather(homeTeam: string, matchDate: string): Promise<WeatherData | null> {
  const teamKey = homeTeam.toLowerCase();
  let coords: [number, number] | undefined;

  for (const [key, val] of Object.entries(STADIUM_COORDS)) {
    if (teamKey.includes(key) || key.includes(teamKey)) {
      coords = val;
      break;
    }
  }

  if (!coords) return null;

  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${coords[0]}&longitude=${coords[1]}&hourly=temperature_2m,rain,wind_speed_10m&forecast_days=3`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;

    const data = await res.json() as {
      hourly: { temperature_2m: number[]; rain: number[]; wind_speed_10m: number[] };
    };

    // Use afternoon readings (index 15 = 3PM) as match-time estimate
    const idx = 15;
    const temp = data.hourly.temperature_2m[idx] ?? 15;
    const rain = data.hourly.rain[idx] ?? 0;
    const wind = data.hourly.wind_speed_10m[idx] ?? 10;

    let desc = 'Clear';
    if (rain > 2) desc = 'Heavy rain';
    else if (rain > 0.5) desc = 'Light rain';
    if (wind > 40) desc += ', very windy';
    else if (wind > 25) desc += ', windy';
    if (temp < 5) desc += ', cold';

    return {
      temp: Math.round(temp * 10) / 10,
      rain: Math.round(rain * 10) / 10,
      windSpeed: Math.round(wind),
      description: desc,
    };
  } catch {
    return null;
  }
}

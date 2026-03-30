import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VflStoreSchema } from './types.js';
import type { VflStore, WeekResults, LeagueData } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'vfl-results.json');

let store: VflStore = { leagues: [] };

export async function initStore(): Promise<void> {
  try {
    const raw = await readFile(STORE_PATH, 'utf-8');
    const parsed = VflStoreSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      store = parsed.data;
    } else {
      console.warn('VFL store validation failed, starting fresh:', parsed.error.message);
      store = { leagues: [] };
    }
  } catch {
    store = { leagues: [] };
  }
}

async function flush(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = STORE_PATH + '.tmp';
  await writeFile(tmp, JSON.stringify(store, null, 2), 'utf-8');
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

export function getStore(): VflStore {
  return store;
}

export function getLeague(leagueId: string): LeagueData | undefined {
  return store.leagues.find(l => l.league === leagueId);
}

export function getLeagueList(): Array<{ league: string; weekCount: number; createdAt: string }> {
  return store.leagues.map(l => ({
    league: l.league,
    weekCount: l.weeks.length,
    createdAt: l.createdAt,
  }));
}

export async function addWeekResults(results: WeekResults): Promise<void> {
  let league = store.leagues.find(l => l.league === results.league);
  if (!league) {
    league = { league: results.league, weeks: [], createdAt: new Date().toISOString() };
    store.leagues.push(league);
  }

  // Replace existing week if re-submitted
  const existingIdx = league.weeks.findIndex(w => w.week === results.week);
  const weekData = {
    week: results.week,
    matches: results.matches.map(m => ({
      home: m.home, away: m.away, homeScore: m.homeScore, awayScore: m.awayScore,
    })),
  };

  if (existingIdx >= 0) {
    league.weeks[existingIdx] = weekData;
  } else {
    league.weeks.push(weekData);
    league.weeks.sort((a, b) => a.week - b.week);
  }

  await flush();
}

export async function deleteWeek(leagueId: string, week: number): Promise<boolean> {
  const league = store.leagues.find(l => l.league === leagueId);
  if (!league) return false;

  const idx = league.weeks.findIndex(w => w.week === week);
  if (idx < 0) return false;

  league.weeks.splice(idx, 1);
  await flush();
  return true;
}

export async function deleteLeague(leagueId: string): Promise<boolean> {
  const idx = store.leagues.findIndex(l => l.league === leagueId);
  if (idx < 0) return false;

  store.leagues.splice(idx, 1);
  await flush();
  return true;
}

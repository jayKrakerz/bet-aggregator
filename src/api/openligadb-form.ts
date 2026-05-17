/**
 * OpenLigaDB form scraper — German football redundancy.
 *
 * Open public REST API (no auth, no rate limit, JSON) covering the
 * complete German football pyramid: Bundesliga 1/2/3 + DFB-Pokal.
 * Adds value over our football-data.co.uk CSVs in two ways:
 *
 *   - 3. Liga (bl3) is the only free-data source for German tier 3.
 *   - DFB-Pokal is the only free-data source for the German cup.
 *
 * Endpoint: https://api.openligadb.de/getmatchdata/{league}/{season}
 *   where league ∈ {bl1, bl2, bl3, dfb} and season is the start-year
 *   (2024 = 2024/25 season).
 *
 * Each call returns the entire season's matches. We cache 6h per
 * league+season and build a per-team match index in memory.
 */

import { logger } from '../utils/logger.js';

const BASE = 'https://api.openligadb.de';
const FETCH_TIMEOUT = 12_000;
const CACHE_TTL = 6 * 60 * 60 * 1000;
const RECENT_LIMIT = 12;

const LEAGUES = [
  { code: 'bl1', name: '1. Bundesliga', tier: 1 },
  { code: 'bl2', name: '2. Bundesliga', tier: 2 },
  { code: 'bl3', name: '3. Liga', tier: 3 },
  { code: 'dfb', name: 'DFB-Pokal', tier: 0 }, // cup, not a league
];

// ── Types ────────────────────────────────────────────────

interface RawMatch {
  matchID: number;
  matchDateTime: string;
  matchDateTimeUTC?: string;
  leagueName: string;
  leagueShortcut: string;
  leagueSeason: number;
  team1: { teamId: number; teamName: string };
  team2: { teamId: number; teamName: string };
  matchIsFinished: boolean;
  matchResults: Array<{ resultName?: string; resultTypeID?: number; pointsTeam1?: number; pointsTeam2?: number }>;
}

interface OldMatch {
  date: string;
  competition: string;
  homeId: number;
  awayId: number;
  homeName: string;
  awayName: string;
  homeGoals: number;
  awayGoals: number;
}

export interface OpenLigaDbTeamForm {
  teamId: number;
  teamName: string;
  league: string;
  country: string;            // always "Germany"
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  homeSplit: { played: number; wins: number; draws: number; losses: number; goalsFor: number; goalsAgainst: number };
  awaySplit: { played: number; wins: number; draws: number; losses: number; goalsFor: number; goalsAgainst: number };
  recentForm: string[];
  avgGoalsForHome: number;
  avgGoalsAgainstHome: number;
  avgGoalsForAway: number;
  avgGoalsAgainstAway: number;
  homeUnbeatenStreak: number;
  momentumStreak: number;
}

export interface OpenLigaDbLookup {
  homeForm: OpenLigaDbTeamForm;
  awayForm: OpenLigaDbTeamForm;
  sameLeague: boolean;
  league: string;
  expHomeGoals: number;
  expAwayGoals: number;
}

// ── State ────────────────────────────────────────────────

interface SeasonCache {
  fetchedAt: number;
  matches: OldMatch[];
  /** Per-team match index: teamId → list of matches sorted newest first. */
  byTeam: Map<number, OldMatch[]>;
  /** Name → teamId for fuzzy lookups. */
  nameToId: Map<string, number>;
}

const seasonCache = new Map<string, SeasonCache>();
const inflight = new Map<string, Promise<SeasonCache | null>>();

function normName(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function currentSeason(): number {
  // German football season runs Aug–May. Before August → previous start-year.
  const now = new Date();
  return now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
}

// ── Fetch + parse ───────────────────────────────────────

async function fetchSeason(leagueCode: string, season: number): Promise<SeasonCache | null> {
  const key = `${leagueCode}:${season}`;
  const cached = seasonCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached;

  const existing = inflight.get(key);
  if (existing) return existing;

  const p = (async () => {
    try {
      const url = `${BASE}/getmatchdata/${leagueCode}/${season}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      if (!res.ok) return null;
      const raw = (await res.json()) as RawMatch[];
      if (!Array.isArray(raw)) return null;

      const matches: OldMatch[] = [];
      const byTeam = new Map<number, OldMatch[]>();
      const nameToId = new Map<string, number>();

      for (const m of raw) {
        if (!m.matchIsFinished) continue;
        const final = m.matchResults?.find(r => r.resultTypeID === 2);
        if (!final || final.pointsTeam1 == null || final.pointsTeam2 == null) continue;

        const om: OldMatch = {
          date: (m.matchDateTime || m.matchDateTimeUTC || '').slice(0, 10),
          competition: m.leagueName,
          homeId: m.team1.teamId,
          awayId: m.team2.teamId,
          homeName: m.team1.teamName,
          awayName: m.team2.teamName,
          homeGoals: final.pointsTeam1,
          awayGoals: final.pointsTeam2,
        };
        matches.push(om);

        for (const [id, name] of [[om.homeId, om.homeName], [om.awayId, om.awayName]] as Array<[number, string]>) {
          const arr = byTeam.get(id) ?? [];
          arr.push(om);
          byTeam.set(id, arr);
          if (!nameToId.has(normName(name))) nameToId.set(normName(name), id);
        }
      }

      // Sort each team's matches newest-first.
      for (const arr of byTeam.values()) arr.sort((a, b) => b.date.localeCompare(a.date));

      const out: SeasonCache = { fetchedAt: Date.now(), matches, byTeam, nameToId };
      seasonCache.set(key, out);
      return out;
    } catch (err) {
      logger.warn({ err, leagueCode, season }, 'openligadb: fetch failed');
      return null;
    }
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

// ── Team lookup ──────────────────────────────────────────

interface ResolvedTeam {
  teamId: number;
  teamName: string;
  leagueCode: string;
  leagueName: string;
}

function fuzzyFind(query: string, nameToId: Map<string, number>): { id: number; key: string } | null {
  const target = normName(query);
  if (!target) return null;
  // Exact normalised match first.
  const exact = nameToId.get(target);
  if (exact != null) return { id: exact, key: target };

  // Token-subset match — "Bayern Munich" should hit "FC Bayern München".
  const targetTokens = new Set(target.split(' ').filter(t => t.length >= 3));
  let best: { id: number; key: string; score: number } | null = null;
  for (const [key, id] of nameToId) {
    const keyTokens = new Set(key.split(' ').filter(t => t.length >= 3));
    let overlap = 0;
    for (const t of targetTokens) if (keyTokens.has(t)) overlap++;
    if (overlap === 0 && !key.includes(target) && !target.includes(key)) continue;
    let score = 0;
    if (key === target) score = 100;
    else if (key.includes(target) || target.includes(key)) {
      const shorter = Math.min(key.length, target.length);
      const longer = Math.max(key.length, target.length);
      score = 60 * (shorter / longer);
    } else if (overlap > 0) {
      const union = targetTokens.size + keyTokens.size - overlap;
      score = (overlap / union) * 85;
    }
    if (score >= 50 && (!best || score > best.score)) best = { id, key, score };
  }
  return best ? { id: best.id, key: best.key } : null;
}

async function resolveTeam(name: string): Promise<{ team: ResolvedTeam; matches: OldMatch[] } | null> {
  // Try current + previous season across all leagues.
  const season = currentSeason();
  for (const season_ of [season, season - 1]) {
    for (const lg of LEAGUES) {
      const cache = await fetchSeason(lg.code, season_);
      if (!cache) continue;
      const hit = fuzzyFind(name, cache.nameToId);
      if (!hit) continue;
      const matches = cache.byTeam.get(hit.id) ?? [];
      if (matches.length === 0) continue;
      return {
        team: {
          teamId: hit.id,
          teamName: matches[0]!.homeId === hit.id ? matches[0]!.homeName : matches[0]!.awayName,
          leagueCode: lg.code,
          leagueName: lg.name,
        },
        matches: matches.slice(0, RECENT_LIMIT),
      };
    }
  }
  return null;
}

// ── Form computation ────────────────────────────────────

function emptySplit() {
  return { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0 };
}

function buildForm(team: ResolvedTeam, matches: OldMatch[]): OpenLigaDbTeamForm {
  const home = emptySplit();
  const away = emptySplit();
  const recents: Array<'W' | 'D' | 'L'> = [];

  for (const m of matches) {
    const isHome = m.homeId === team.teamId;
    const gf = isHome ? m.homeGoals : m.awayGoals;
    const ga = isHome ? m.awayGoals : m.homeGoals;
    const r: 'W' | 'D' | 'L' = gf > ga ? 'W' : gf < ga ? 'L' : 'D';
    recents.push(r);
    const split = isHome ? home : away;
    split.played++;
    split.goalsFor += gf;
    split.goalsAgainst += ga;
    if (r === 'W') split.wins++;
    else if (r === 'D') split.draws++;
    else split.losses++;
  }

  const played = home.played + away.played;
  const wins = home.wins + away.wins;
  const draws = home.draws + away.draws;
  const losses = home.losses + away.losses;
  const goalsFor = home.goalsFor + away.goalsFor;
  const goalsAgainst = home.goalsAgainst + away.goalsAgainst;
  const avg = (n: number, d: number) => (d > 0 ? n / d : 0);

  // Home Fortress streak: consecutive home games without a loss.
  let homeUnbeatenStreak = 0;
  for (const m of matches.filter(x => x.homeId === team.teamId)) {
    if (m.homeGoals >= m.awayGoals) homeUnbeatenStreak++;
    else break;
  }

  // Signed momentum: consecutive W (positive) or L (negative) from the start.
  let momentumStreak = 0;
  if (recents.length > 0) {
    const first = recents[0]!;
    if (first === 'W' || first === 'L') {
      for (const r of recents) {
        if (r === first) momentumStreak += first === 'W' ? 1 : -1;
        else break;
      }
    }
  }

  return {
    teamId: team.teamId,
    teamName: team.teamName,
    league: team.leagueName,
    country: 'Germany',
    played, wins, draws, losses,
    goalsFor, goalsAgainst,
    homeSplit: home, awaySplit: away,
    recentForm: recents.slice(0, 5),
    avgGoalsForHome: avg(home.goalsFor, home.played),
    avgGoalsAgainstHome: avg(home.goalsAgainst, home.played),
    avgGoalsForAway: avg(away.goalsFor, away.played),
    avgGoalsAgainstAway: avg(away.goalsAgainst, away.played),
    homeUnbeatenStreak,
    momentumStreak,
  };
}

// ── Public lookup ────────────────────────────────────────

export async function lookupViaOpenLigaDb(home: string, away: string): Promise<OpenLigaDbLookup | null> {
  const [h, a] = await Promise.all([resolveTeam(home), resolveTeam(away)]);
  if (!h || !a) return null;

  const homeForm = buildForm(h.team, h.matches);
  const awayForm = buildForm(a.team, a.matches);

  const homeScoring = homeForm.avgGoalsForHome || (homeForm.played > 0 ? homeForm.goalsFor / homeForm.played : 1.4);
  const awayConceding = awayForm.avgGoalsAgainstAway || (awayForm.played > 0 ? awayForm.goalsAgainst / awayForm.played : 1.3);
  const awayScoring = awayForm.avgGoalsForAway || (awayForm.played > 0 ? awayForm.goalsFor / awayForm.played : 1.1);
  const homeConceding = homeForm.avgGoalsAgainstHome || (homeForm.played > 0 ? homeForm.goalsAgainst / homeForm.played : 1.1);

  const expHomeGoals = Math.max(0.15, Math.min(5, Math.sqrt(homeScoring * awayConceding)));
  const expAwayGoals = Math.max(0.15, Math.min(5, Math.sqrt(awayScoring * homeConceding)));

  const sameLeague = h.team.leagueCode === a.team.leagueCode;
  const label = sameLeague
    ? `Germany · ${h.team.leagueName}`
    : `Germany · ${h.team.leagueName} / Germany · ${a.team.leagueName}`;

  return {
    homeForm, awayForm,
    sameLeague,
    league: label,
    expHomeGoals,
    expAwayGoals,
  };
}

export function getOpenLigaDbStats(): { seasonsCached: number; teamsIndexed: number } {
  let teams = 0;
  for (const s of seasonCache.values()) teams += s.byTeam.size;
  return { seasonsCached: seasonCache.size, teamsIndexed: teams };
}

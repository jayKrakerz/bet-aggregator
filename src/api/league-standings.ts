/**
 * League Standings — thin ESPN /standings wrapper.
 *
 * Fetches the live league table for each ESPN-indexed league we already
 * know about (eng.1, esp.1, …) and exposes a per-team lookup that returns
 * { rank, gamesPlayed, totalTeams, points }. Used by the Importance Index
 * to read late-season motivation.
 *
 * Cache: 1 h per league. ESPN's standings only refresh on match settlement.
 */

import { logger } from '../utils/logger.js';
import { preloadEspnTeams, findEspnTeamCandidates } from './espn-form.js';

const ESPN_STANDINGS_BASE = 'https://site.api.espn.com/apis/v2/sports/soccer';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 8000;
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface TeamStanding {
  teamId: string;
  teamName: string;
  leagueSlug: string;
  leagueName: string;
  /** Position in the table (1 = top). */
  rank: number;
  gamesPlayed: number;
  totalTeams: number;
  points: number;
  /** Season length estimate based on table size — 2 × (N − 1). */
  seasonLength: number;
  matchesRemaining: number;
}

interface RawStandingsEntry {
  team: { id: string; displayName: string };
  note?: { rank?: number };
  stats?: Array<{ name: string; value?: number }>;
}

interface RawStandingsResp {
  name?: string;
  children?: Array<{
    name?: string;
    standings?: { entries?: RawStandingsEntry[] };
  }>;
}

interface CachedLeague {
  leagueSlug: string;
  leagueName: string;
  entries: TeamStanding[];
  fetchedAt: number;
}

const cache = new Map<string, CachedLeague>();
const inflight = new Map<string, Promise<CachedLeague | null>>();

async function fetchJson(url: string): Promise<RawStandingsResp | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return null;
    return (await res.json()) as RawStandingsResp;
  } catch {
    return null;
  }
}

function statVal(entry: RawStandingsEntry, name: string): number {
  const s = entry.stats?.find(x => x.name === name);
  return s?.value ?? 0;
}

function currentSeasonForSlug(_slug: string): number {
  // ESPN uses start-year for European seasons (2025 = 2025/26), single
  // calendar year for South America/Africa/Asia. Try start-year first;
  // if empty, lookupLeagueStandings retries with previous year.
  return new Date().getFullYear();
}

async function fetchLeagueStandings(leagueSlug: string): Promise<CachedLeague | null> {
  const cached = cache.get(leagueSlug);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

  const existing = inflight.get(leagueSlug);
  if (existing) return existing;

  const p = (async () => {
    const yearNow = currentSeasonForSlug(leagueSlug);
    // Try current season first, then previous (covers leagues that
    // haven't kicked off the new season yet).
    for (const season of [yearNow, yearNow - 1]) {
      const url = `${ESPN_STANDINGS_BASE}/${leagueSlug}/standings?season=${season}`;
      const data = await fetchJson(url);
      const entries = data?.children?.[0]?.standings?.entries ?? [];
      if (entries.length === 0) continue;

      const totalTeams = entries.length;
      const seasonLength = Math.max(0, 2 * (totalTeams - 1));
      const leagueName = data?.children?.[0]?.name || data?.name || leagueSlug;

      // ESPN populates `note.rank` only for teams in CL/EL/relegation
      // zones; mid-table entries have no note. Entries are ordered by rank
      // already, so fall back to (index + 1) when note.rank is missing.
      const standings: TeamStanding[] = entries.map((e, idx) => {
        const noteRank = e.note?.rank ?? 0;
        const rank = noteRank > 0 ? noteRank : idx + 1;
        const gp = statVal(e, 'gamesPlayed');
        return {
          teamId: e.team.id,
          teamName: e.team.displayName,
          leagueSlug,
          leagueName,
          rank,
          gamesPlayed: gp,
          totalTeams,
          points: statVal(e, 'points'),
          seasonLength,
          matchesRemaining: Math.max(0, seasonLength - gp),
        };
      });

      const out: CachedLeague = {
        leagueSlug,
        leagueName,
        entries: standings,
        fetchedAt: Date.now(),
      };
      cache.set(leagueSlug, out);
      return out;
    }
    return null;
  })().catch(err => {
    logger.warn({ err, leagueSlug }, 'league-standings: fetch failed');
    return null;
  }).finally(() => {
    inflight.delete(leagueSlug);
  });

  inflight.set(leagueSlug, p);
  return p;
}

/**
 * Look up a team's standing. Resolves the team's ESPN league via the
 * already-loaded team index, then fetches that league's standings.
 * Returns null when the team isn't in any ESPN-indexed league.
 */
export async function getTeamStanding(team: string): Promise<TeamStanding | null> {
  await preloadEspnTeams();
  const candidates = findEspnTeamCandidates(team);
  if (candidates.length === 0) return null;

  // Try every candidate league in order — first hit wins.
  for (const cand of candidates) {
    const league = await fetchLeagueStandings(cand.leagueSlug);
    if (!league) continue;
    const entry = league.entries.find(e => e.teamId === cand.teamId);
    if (entry) return entry;
  }
  return null;
}

/** Diagnostics. */
export function getStandingsStats(): { leaguesCached: number; teamsCached: number } {
  let teams = 0;
  for (const l of cache.values()) teams += l.entries.length;
  return { leaguesCached: cache.size, teamsCached: teams };
}

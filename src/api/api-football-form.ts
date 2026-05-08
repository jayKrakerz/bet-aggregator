/**
 * API-Football Form Fallback
 *
 * Used by ou-lookup when the local CSV-Poisson can't find both teams.
 * Pulls per-team season stats from API-Football (1300+ leagues) and
 * returns expected goals + form summary in the same shape ou-lookup
 * uses internally.
 *
 * Cost discipline (free tier = 100 req/day):
 *   - Cold lookup = 4 calls (2 search + 2 stats)
 *   - All cached = 0 calls
 *   - Per-day counter refuses new calls when within 5% of the daily cap
 *
 * Requires FOOTBALL_API_KEY env var (free signup at api-football.com).
 */

import { logger } from '../utils/logger.js';

const API_BASE = 'https://v3.football.api-sports.io';
// Search/stats results are stable enough to hold for 24h.
const CACHE_TTL = 24 * 60 * 60 * 1000;
// Free tier ceiling. Override with FOOTBALL_API_DAILY_CAP if you upgrade.
const DAILY_CAP_DEFAULT = 100;

// ── Quota tracking ────────────────────────────────────────

interface QuotaState { day: string; used: number }
let quota: QuotaState = { day: today(), used: 0 };

function today(): string { return new Date().toISOString().slice(0, 10); }

function dailyCap(): number {
  const env = process.env.FOOTBALL_API_DAILY_CAP;
  return env ? Math.max(10, parseInt(env, 10) || DAILY_CAP_DEFAULT) : DAILY_CAP_DEFAULT;
}

function tickQuota(): void {
  const t = today();
  if (quota.day !== t) quota = { day: t, used: 0 };
  quota.used++;
}

function quotaRemaining(): number {
  const t = today();
  if (quota.day !== t) return dailyCap();
  return Math.max(0, dailyCap() - quota.used);
}

export function getApiFootballQuota(): { day: string; used: number; cap: number; remaining: number } {
  return { day: quota.day, used: quota.used, cap: dailyCap(), remaining: quotaRemaining() };
}

// ── HTTP layer (mirrors football-enrichment's dual-attempt) ──

function getApiKey(): string | null {
  return process.env.FOOTBALL_API_KEY || null;
}

export function hasApiFootballKey(): boolean {
  return !!getApiKey();
}

async function apiFetch<T>(endpoint: string): Promise<T | null> {
  const key = getApiKey();
  if (!key) return null;
  // Soft-stop near the cap so we leave headroom for other modules
  // (football-enrichment.ts also burns quota).
  if (quotaRemaining() <= Math.ceil(dailyCap() * 0.05)) {
    logger.warn({ remaining: quotaRemaining() }, 'API-Football near daily cap — skipping call');
    return null;
  }

  const attempts: Array<{ url: string; headers: Record<string, string> }> = [
    { url: `${API_BASE}${endpoint}`, headers: { 'x-apisports-key': key } },
    { url: `https://api-football-v1.p.rapidapi.com/v3${endpoint}`, headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'api-football-v1.p.rapidapi.com' } },
  ];

  for (const a of attempts) {
    try {
      tickQuota();
      const res = await fetch(a.url, { headers: a.headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const json = await res.json() as { response?: T; errors?: Record<string, string>; message?: string };
      if (json.message) continue;
      if (json.errors && Object.keys(json.errors).length > 0) continue;
      if (json.response) return json.response;
    } catch {
      continue;
    }
  }
  return null;
}

// ── API shapes ────────────────────────────────────────────

interface ApiTeam {
  team: { id: number; name: string; country: string; founded: number | null };
}
interface ApiTeamLeague {
  league: { id: number; season: number; name: string; country: string };
}
interface ApiTeamStats {
  league: { id: number; season: number; name: string; country: string };
  team: { id: number; name: string };
  form: string | null;
  fixtures: {
    played: { home: number; away: number; total: number };
    wins: { home: number; away: number; total: number };
    draws: { home: number; away: number; total: number };
    loses: { home: number; away: number; total: number };
  };
  goals: {
    for: { total: { home: number; away: number; total: number }; average: { home: string; away: string; total: string } };
    against: { total: { home: number; away: number; total: number }; average: { home: string; away: string; total: string } };
  };
}

// ── Caches (in-memory; survive within a server session) ──

const teamSearchCache = new Map<string, { id: number; name: string; country: string } | null>();
const teamLeagueCache = new Map<number, { id: number; season: number; name: string; country: string } | null>();
const teamStatsCache = new Map<string, { stats: ApiTeamStats; ts: number } | null>();

// ── Public types ──────────────────────────────────────────

export interface ApiFootballForm {
  teamId: number;
  teamName: string;
  league: string;
  country: string;
  season: number;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  /** League-relative averages used for Poisson lambdas. */
  avgGoalsForHome: number;
  avgGoalsAgainstHome: number;
  avgGoalsForAway: number;
  avgGoalsAgainstAway: number;
  /** Last ~5 results in WDL form. */
  recentForm: string[];
  homeSplit: { played: number; wins: number; draws: number; losses: number };
  awaySplit: { played: number; wins: number; draws: number; losses: number };
}

export interface ApiFootballLookup {
  homeForm: ApiFootballForm;
  awayForm: ApiFootballForm;
  /** Same league? Best signal — same-league lambdas are directly comparable. */
  sameLeague: boolean;
  /** Lambdas computed from per-team home/away splits with league-average normalization. */
  expHomeGoals: number;
  expAwayGoals: number;
}

// ── Lookup functions ──────────────────────────────────────

async function searchTeam(name: string): Promise<{ id: number; name: string; country: string } | null> {
  const key = name.toLowerCase().trim();
  if (teamSearchCache.has(key)) return teamSearchCache.get(key) ?? null;
  const res = await apiFetch<ApiTeam[]>(`/teams?search=${encodeURIComponent(name)}`);
  if (!res || res.length === 0) {
    teamSearchCache.set(key, null);
    return null;
  }
  // First result is the best string-match per API-Football's search.
  const best = { id: res[0]!.team.id, name: res[0]!.team.name, country: res[0]!.team.country };
  teamSearchCache.set(key, best);
  return best;
}

async function findCurrentLeague(teamId: number): Promise<{ id: number; season: number; name: string; country: string } | null> {
  if (teamLeagueCache.has(teamId)) return teamLeagueCache.get(teamId) ?? null;
  const res = await apiFetch<ApiTeamLeague[]>(`/leagues?team=${teamId}&current=true`);
  if (!res || res.length === 0) {
    teamLeagueCache.set(teamId, null);
    return null;
  }
  // Prefer league competitions (id < 1000-ish) over cups, but the team's
  // primary league usually appears first.
  const lg = res[0]!.league;
  const out = { id: lg.id, season: lg.season, name: lg.name, country: lg.country };
  teamLeagueCache.set(teamId, out);
  return out;
}

async function fetchTeamStats(teamId: number, leagueId: number, season: number): Promise<ApiTeamStats | null> {
  const key = `${teamId}:${leagueId}:${season}`;
  const cached = teamStatsCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.stats;
  const res = await apiFetch<ApiTeamStats>(`/teams/statistics?team=${teamId}&league=${leagueId}&season=${season}`);
  if (!res) {
    teamStatsCache.set(key, null);
    return null;
  }
  teamStatsCache.set(key, { stats: res, ts: Date.now() });
  return res;
}

function statsToForm(stats: ApiTeamStats): ApiFootballForm {
  const f = stats.fixtures;
  const g = stats.goals;
  // form is e.g. "WWLDW..." — keep last 5.
  const formStr = (stats.form || '').replace(/[^WDL]/g, '');
  const recentForm = formStr.split('').slice(-5).reverse();
  return {
    teamId: stats.team.id,
    teamName: stats.team.name,
    league: stats.league.name,
    country: stats.league.country,
    season: stats.league.season,
    played: f.played.total,
    wins: f.wins.total,
    draws: f.draws.total,
    losses: f.loses.total,
    goalsFor: g.for.total.total,
    goalsAgainst: g.against.total.total,
    avgGoalsForHome: parseFloat(g.for.average.home || '0') || 0,
    avgGoalsAgainstHome: parseFloat(g.against.average.home || '0') || 0,
    avgGoalsForAway: parseFloat(g.for.average.away || '0') || 0,
    avgGoalsAgainstAway: parseFloat(g.against.average.away || '0') || 0,
    recentForm,
    homeSplit: { played: f.played.home, wins: f.wins.home, draws: f.draws.home, losses: f.loses.home },
    awaySplit: { played: f.played.away, wins: f.wins.away, draws: f.draws.away, losses: f.loses.away },
  };
}

/**
 * Look up both teams via API-Football and compose Poisson lambdas.
 * Returns null when:
 *   - API key not set
 *   - Either team can't be found via search
 *   - Either team has no current-season stats yet (preseason teams)
 *   - Daily quota exhausted
 */
export async function lookupViaApiFootball(homeTeam: string, awayTeam: string): Promise<ApiFootballLookup | null> {
  if (!hasApiFootballKey()) return null;

  const [home, away] = await Promise.all([searchTeam(homeTeam), searchTeam(awayTeam)]);
  if (!home || !away) {
    logger.info({ home: home?.name, away: away?.name, q: { homeTeam, awayTeam } }, 'API-Football: team search miss');
    return null;
  }

  const [homeLeague, awayLeague] = await Promise.all([findCurrentLeague(home.id), findCurrentLeague(away.id)]);
  if (!homeLeague || !awayLeague) {
    logger.info({ home: home.name, away: away.name }, 'API-Football: league lookup miss');
    return null;
  }

  const [homeStats, awayStats] = await Promise.all([
    fetchTeamStats(home.id, homeLeague.id, homeLeague.season),
    fetchTeamStats(away.id, awayLeague.id, awayLeague.season),
  ]);
  if (!homeStats || !awayStats) {
    logger.info({ home: home.name, away: away.name }, 'API-Football: stats lookup miss');
    return null;
  }

  const homeForm = statsToForm(homeStats);
  const awayForm = statsToForm(awayStats);

  // Lambdas: home team's avg-scored-at-home × away team's avg-conceded-away.
  // When stats are missing (early-season fixtures), fall back to the team's
  // overall average for that side.
  const overallHomeAvg = homeForm.played > 0 ? homeForm.goalsFor / homeForm.played : 1.4;
  const overallAwayAvg = awayForm.played > 0 ? awayForm.goalsFor / awayForm.played : 1.1;

  const homeScoringRate = homeForm.avgGoalsForHome || overallHomeAvg;
  const awayConcedeRate = awayForm.avgGoalsAgainstAway || (awayForm.played > 0 ? awayForm.goalsAgainst / awayForm.played : 1.3);
  const awayScoringRate = awayForm.avgGoalsForAway || overallAwayAvg;
  const homeConcedeRate = homeForm.avgGoalsAgainstHome || (homeForm.played > 0 ? homeForm.goalsAgainst / homeForm.played : 1.1);

  // Blend each side's attack against the opponent's defense (geometric mean).
  // Pure (attack × defense / leagueAvg) needs league averages we don't have
  // here cheaply, so we use the geometric mean of the two — robust across
  // leagues without an extra API call.
  const expHomeGoals = Math.sqrt(Math.max(0.1, homeScoringRate) * Math.max(0.1, awayConcedeRate));
  const expAwayGoals = Math.sqrt(Math.max(0.1, awayScoringRate) * Math.max(0.1, homeConcedeRate));

  return {
    homeForm,
    awayForm,
    sameLeague: homeLeague.id === awayLeague.id,
    expHomeGoals: Math.max(0.15, Math.min(5, expHomeGoals)),
    expAwayGoals: Math.max(0.15, Math.min(5, expAwayGoals)),
  };
}

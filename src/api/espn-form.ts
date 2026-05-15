/**
 * ESPN Free Form-Data Fallback
 *
 * ESPN's public soccer API exposes ~18 leagues that football-data.co.uk
 * doesn't cover — Honduras, Bolivia, Peru, Chile, Venezuela, Ecuador,
 * Colombia, Paraguay, Uruguay, Nigeria, Ghana, South Africa, Saudi,
 * India, Australia, Eredivisie 2 (RKC Waalwijk + Willem II!), and major
 * cup competitions (Champions League, Copa Libertadores, etc.).
 *
 * No auth, no Cloudflare, no quota. Same fetch path our existing
 * fotmob-enrichment / elo-predictor modules use.
 *
 * Strategy:
 *   1. At preload, fetch /teams for each known league → build a flat
 *      name-keyed index { canonicalName → [{ teamId, leagueSlug }] }.
 *   2. On lookup, find both teams in the index. Prefer the league that
 *      contains BOTH teams; fall back to "first league per team" if not.
 *   3. Per-team /schedule?season=YYYY for current + previous season →
 *      derive home/away avg-goals-for/against → Poisson lambdas.
 */

import { logger } from '../utils/logger.js';

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TEAM_INDEX_TTL = 24 * 60 * 60 * 1000;
const SCHEDULE_TTL = 6 * 60 * 60 * 1000;

// ── League list ──────────────────────────────────────────

interface EspnLeague { slug: string; name: string; country: string }

const ESPN_LEAGUES: EspnLeague[] = [
  // South America (mostly NOT covered by football-data.co.uk)
  { slug: 'hon.1', name: 'Liga Nacional', country: 'Honduras' },
  { slug: 'bol.1', name: 'División Profesional', country: 'Bolivia' },
  { slug: 'per.1', name: 'Liga 1', country: 'Peru' },
  { slug: 'chi.1', name: 'Primera División', country: 'Chile' },
  { slug: 'ven.1', name: 'Primera División', country: 'Venezuela' },
  { slug: 'ecu.1', name: 'Serie A', country: 'Ecuador' },
  { slug: 'col.1', name: 'Categoría Primera A', country: 'Colombia' },
  { slug: 'par.1', name: 'Primera División', country: 'Paraguay' },
  { slug: 'uru.1', name: 'Primera División', country: 'Uruguay' },
  // Africa (important for Sportybet's user base)
  { slug: 'nga.1', name: 'NPFL', country: 'Nigeria' },
  { slug: 'gha.1', name: 'Premier League', country: 'Ghana' },
  { slug: 'rsa.1', name: 'Premiership', country: 'South Africa' },
  // Asia / Oceania
  { slug: 'ksa.1', name: 'Pro League', country: 'Saudi Arabia' },
  { slug: 'ind.1', name: 'Indian Super League', country: 'India' },
  { slug: 'aus.1', name: 'A-League', country: 'Australia' },
  // Europe — lower divisions football-data doesn't have
  { slug: 'ned.2', name: 'Eerste Divisie', country: 'Netherlands' },
  // Major cup competitions (different team rosters than league entries)
  { slug: 'uefa.champions', name: 'Champions League', country: 'Europe' },
  { slug: 'uefa.europa', name: 'Europa League', country: 'Europe' },
  { slug: 'conmebol.libertadores', name: 'Copa Libertadores', country: 'South America' },
  { slug: 'conmebol.america', name: 'Copa América', country: 'South America' },
  { slug: 'concacaf.champions', name: 'Concacaf Champions Cup', country: 'CONCACAF' },
];

// ── Types ────────────────────────────────────────────────

interface EspnTeamRef {
  teamId: string;
  teamName: string;
  leagueSlug: string;
  leagueName: string;
  leagueCountry: string;
}

interface EspnEventOutcome {
  date: string;
  homeId: string;
  awayId: string;
  homeName: string;
  awayName: string;
  homeGoals: number;
  awayGoals: number;
}

export interface EspnTeamForm {
  teamId: string;
  teamName: string;
  league: string;
  country: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  homeSplit: { played: number; wins: number; draws: number; losses: number; goalsFor: number; goalsAgainst: number };
  awaySplit: { played: number; wins: number; draws: number; losses: number; goalsFor: number; goalsAgainst: number };
  recentForm: string[];
  /** Avg goals scored when playing at home. */
  avgGoalsForHome: number;
  /** Avg goals conceded when playing at home. */
  avgGoalsAgainstHome: number;
  avgGoalsForAway: number;
  avgGoalsAgainstAway: number;
  /** Consecutive home matches without a loss (W or D), most recent backward. */
  homeUnbeatenStreak: number;
  /** Signed recent momentum across all venues (+N wins / -N losses). */
  momentumStreak: number;
}

export interface EspnLookup {
  homeForm: EspnTeamForm;
  awayForm: EspnTeamForm;
  /** Same league? Same-league lambdas are directly comparable. */
  sameLeague: boolean;
  league: string;
  expHomeGoals: number;
  expAwayGoals: number;
}

// ── HTTP ─────────────────────────────────────────────────

async function fetchJson<T>(url: string, timeoutMs = 8000): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

// ── Team index ───────────────────────────────────────────

const teamIndex = new Map<string, EspnTeamRef[]>();
let indexLoadedAt = 0;
let indexInflight: Promise<void> | null = null;

function normName(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

interface RawTeamsResp {
  sports?: Array<{ leagues?: Array<{ teams?: Array<{ team: { id: string; displayName: string; shortDisplayName?: string; abbreviation?: string } }> }> }>;
}

async function fetchTeamsForLeague(league: EspnLeague): Promise<EspnTeamRef[]> {
  const url = `${ESPN_BASE}/${league.slug}/teams?limit=50`;
  const data = await fetchJson<RawTeamsResp>(url);
  if (!data) return [];
  const teams = data.sports?.[0]?.leagues?.[0]?.teams ?? [];
  return teams.map(t => ({
    teamId: t.team.id,
    teamName: t.team.displayName,
    leagueSlug: league.slug,
    leagueName: league.name,
    leagueCountry: league.country,
  }));
}

function indexAdd(name: string, ref: EspnTeamRef) {
  const key = normName(name);
  if (!key) return;
  const arr = teamIndex.get(key) ?? [];
  // Avoid dupes per (teamId, leagueSlug).
  if (!arr.some(r => r.teamId === ref.teamId && r.leagueSlug === ref.leagueSlug)) {
    arr.push(ref);
    teamIndex.set(key, arr);
  }
}

export async function preloadEspnTeams(force = false): Promise<{ leagues: number; teams: number }> {
  if (!force && Date.now() - indexLoadedAt < TEAM_INDEX_TTL && teamIndex.size > 0) {
    return { leagues: ESPN_LEAGUES.length, teams: teamIndex.size };
  }
  if (indexInflight) { await indexInflight; return { leagues: ESPN_LEAGUES.length, teams: teamIndex.size }; }

  indexInflight = (async () => {
    teamIndex.clear();
    const results = await Promise.allSettled(ESPN_LEAGUES.map(l => fetchTeamsForLeague(l)));
    let loadedLeagues = 0;
    let totalTeams = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status !== 'fulfilled') continue;
      const refs = r.value;
      if (refs.length === 0) continue;
      loadedLeagues++;
      for (const ref of refs) {
        totalTeams++;
        indexAdd(ref.teamName, ref);
      }
    }
    indexLoadedAt = Date.now();
    logger.info({ loadedLeagues, totalTeams, indexedNames: teamIndex.size }, 'ESPN team index loaded');
  })();

  await indexInflight;
  indexInflight = null;
  return { leagues: ESPN_LEAGUES.length, teams: teamIndex.size };
}

function findTeamCandidates(query: string): EspnTeamRef[] {
  const target = normName(query);
  if (!target) return [];

  // 1. Exact normalized match.
  const exact = teamIndex.get(target);
  if (exact) return exact;

  // 2. Substring + token-overlap fallback.
  const targetTokens = new Set(target.split(/\s+/).filter(t => t.length >= 3));
  let best: { ref: EspnTeamRef; score: number }[] = [];
  for (const [key, refs] of teamIndex) {
    if (key === target) continue;
    let score = 0;
    if (key.includes(target) || target.includes(key)) {
      const shorter = Math.min(key.length, target.length);
      const longer = Math.max(key.length, target.length);
      score = 60 * (shorter / longer);
    } else {
      const keyTokens = new Set(key.split(/\s+/).filter(t => t.length >= 3));
      if (targetTokens.size === 0 || keyTokens.size === 0) continue;
      let inter = 0;
      for (const t of targetTokens) if (keyTokens.has(t)) inter++;
      if (inter === 0) continue;
      const union = targetTokens.size + keyTokens.size - inter;
      score = (inter / union) * 80;
    }
    if (score >= 45) {
      for (const r of refs) best.push({ ref: r, score });
    }
  }
  best.sort((a, b) => b.score - a.score);
  return best.slice(0, 6).map(b => b.ref);
}

// ── Schedule fetch + form computation ────────────────────

interface RawScheduleResp {
  events?: Array<{
    date?: string;
    competitions?: Array<{
      competitors?: Array<{
        homeAway?: 'home' | 'away';
        team?: { id: string; displayName: string };
        score?: string | { displayValue?: string; value?: number };
      }>;
    }>;
  }>;
}

const scheduleCache = new Map<string, { ts: number; events: EspnEventOutcome[] }>();

function parseScore(s: unknown): number | null {
  if (s == null) return null;
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  if (typeof s === 'string') {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof s === 'object') {
    const obj = s as { displayValue?: unknown; value?: unknown };
    if (obj.displayValue != null) return parseScore(obj.displayValue);
    if (obj.value != null) return parseScore(obj.value);
  }
  return null;
}

async function fetchTeamSchedule(teamId: string, leagueSlug: string, season: number): Promise<EspnEventOutcome[]> {
  const cacheKey = `${leagueSlug}:${teamId}:${season}`;
  const cached = scheduleCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SCHEDULE_TTL) return cached.events;

  const url = `${ESPN_BASE}/${leagueSlug}/teams/${teamId}/schedule?season=${season}`;
  const data = await fetchJson<RawScheduleResp>(url);
  const out: EspnEventOutcome[] = [];
  for (const ev of data?.events ?? []) {
    const comp = ev.competitions?.[0];
    if (!comp || !comp.competitors || comp.competitors.length < 2) continue;
    const home = comp.competitors.find(c => c.homeAway === 'home') ?? comp.competitors[0]!;
    const away = comp.competitors.find(c => c.homeAway === 'away') ?? comp.competitors[1]!;
    const hg = parseScore(home.score);
    const ag = parseScore(away.score);
    if (hg === null || ag === null) continue;
    out.push({
      date: ev.date ?? '',
      homeId: home.team?.id ?? '',
      awayId: away.team?.id ?? '',
      homeName: home.team?.displayName ?? '',
      awayName: away.team?.displayName ?? '',
      homeGoals: hg,
      awayGoals: ag,
    });
  }
  scheduleCache.set(cacheKey, { ts: Date.now(), events: out });
  return out;
}

function emptySplit() {
  return { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0 };
}

// Exponential decay for ESPN season-long schedules. A 60-day-old match
// weighs 1/e ≈ 0.37; a year-old match weighs ≈ 0.0025. The recency bias
// is what we want — last week's form predicts next week better than
// last September's.
const ESPN_FORM_TAU_DAYS = 60;

function decayWeight(date: string, now = Date.now()): number {
  if (!date) return 0.5;
  const t = Date.parse(date);
  if (!Number.isFinite(t)) return 0.5;
  const ageDays = Math.max(0, (now - t) / 86_400_000);
  return Math.exp(-ageDays / ESPN_FORM_TAU_DAYS);
}

function buildForm(team: EspnTeamRef, events: EspnEventOutcome[]): EspnTeamForm {
  const home = emptySplit();
  const away = emptySplit();
  const wHome = { gf: 0, ga: 0, weight: 0 };
  const wAway = { gf: 0, ga: 0, weight: 0 };
  const recents: Array<{ result: 'W' | 'D' | 'L'; date: string }> = [];
  const now = Date.now();

  for (const ev of events) {
    const w = decayWeight(ev.date, now);
    if (ev.homeId === team.teamId) {
      home.played++;
      home.goalsFor += ev.homeGoals;
      home.goalsAgainst += ev.awayGoals;
      const r: 'W' | 'D' | 'L' = ev.homeGoals > ev.awayGoals ? 'W' : ev.homeGoals < ev.awayGoals ? 'L' : 'D';
      home[r === 'W' ? 'wins' : r === 'D' ? 'draws' : 'losses']++;
      wHome.gf += ev.homeGoals * w;
      wHome.ga += ev.awayGoals * w;
      wHome.weight += w;
      recents.push({ result: r, date: ev.date });
    } else if (ev.awayId === team.teamId) {
      away.played++;
      away.goalsFor += ev.awayGoals;
      away.goalsAgainst += ev.homeGoals;
      const r: 'W' | 'D' | 'L' = ev.awayGoals > ev.homeGoals ? 'W' : ev.awayGoals < ev.homeGoals ? 'L' : 'D';
      away[r === 'W' ? 'wins' : r === 'D' ? 'draws' : 'losses']++;
      wAway.gf += ev.awayGoals * w;
      wAway.ga += ev.homeGoals * w;
      wAway.weight += w;
      recents.push({ result: r, date: ev.date });
    }
  }

  recents.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const recentForm = recents.slice(0, 5).map(r => r.result);

  // Home Fortress streak: scan team's HOME events (only) in descending date.
  const homeEventsDesc = events
    .filter(ev => ev.homeId === team.teamId)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  let homeUnbeatenStreak = 0;
  for (const ev of homeEventsDesc) {
    if (ev.homeGoals >= ev.awayGoals) homeUnbeatenStreak++;
    else break;
  }

  // Momentum streak across all venues.
  let momentumStreak = 0;
  if (recents.length > 0) {
    const first = recents[0]!.result;
    if (first === 'W' || first === 'L') {
      for (const r of recents) {
        if (r.result !== first) break;
        momentumStreak += first === 'W' ? 1 : -1;
      }
    }
  }

  const played = home.played + away.played;
  const goalsFor = home.goalsFor + away.goalsFor;
  const goalsAgainst = home.goalsAgainst + away.goalsAgainst;

  return {
    teamId: team.teamId,
    teamName: team.teamName,
    league: team.leagueName,
    country: team.leagueCountry,
    played,
    wins: home.wins + away.wins,
    draws: home.draws + away.draws,
    losses: home.losses + away.losses,
    goalsFor,
    goalsAgainst,
    homeSplit: home,
    awaySplit: away,
    recentForm,
    avgGoalsForHome: wHome.weight > 0 ? wHome.gf / wHome.weight : 0,
    avgGoalsAgainstHome: wHome.weight > 0 ? wHome.ga / wHome.weight : 0,
    avgGoalsForAway: wAway.weight > 0 ? wAway.gf / wAway.weight : 0,
    avgGoalsAgainstAway: wAway.weight > 0 ? wAway.ga / wAway.weight : 0,
    homeUnbeatenStreak,
    momentumStreak,
  };
}

// ── Public lookup ────────────────────────────────────────

function currentSeasonForLeague(_slug: string): number {
  // ESPN uses end-year for European leagues (so 2025 = 2024-25 season).
  // South American leagues use single calendar year. To stay simple we
  // return the current calendar year; pulling current+previous covers
  // both conventions.
  return new Date().getFullYear();
}

export async function lookupViaEspn(homeTeam: string, awayTeam: string): Promise<EspnLookup | null> {
  await preloadEspnTeams();

  const homeRefs = findTeamCandidates(homeTeam);
  const awayRefs = findTeamCandidates(awayTeam);
  if (homeRefs.length === 0 || awayRefs.length === 0) {
    logger.info({ home: homeTeam, away: awayTeam, hHits: homeRefs.length, aHits: awayRefs.length }, 'ESPN lookup: no team match');
    return null;
  }

  // Pick the (homeRef, awayRef) pair that share a league. If none share,
  // fall back to first-of-each (cross-league lambdas — flagged).
  let chosenHome = homeRefs[0]!;
  let chosenAway = awayRefs[0]!;
  let sameLeague = false;
  outer: for (const h of homeRefs) {
    for (const a of awayRefs) {
      if (h.leagueSlug === a.leagueSlug) {
        chosenHome = h;
        chosenAway = a;
        sameLeague = true;
        break outer;
      }
    }
  }

  // Pull current + previous season schedules for both teams.
  const yearNow = currentSeasonForLeague(chosenHome.leagueSlug);
  const [hCur, hPrev, aCur, aPrev] = await Promise.all([
    fetchTeamSchedule(chosenHome.teamId, chosenHome.leagueSlug, yearNow),
    fetchTeamSchedule(chosenHome.teamId, chosenHome.leagueSlug, yearNow - 1),
    fetchTeamSchedule(chosenAway.teamId, chosenAway.leagueSlug, yearNow),
    fetchTeamSchedule(chosenAway.teamId, chosenAway.leagueSlug, yearNow - 1),
  ]);

  const homeEvents = [...hCur, ...hPrev];
  const awayEvents = [...aCur, ...aPrev];
  if (homeEvents.length === 0 || awayEvents.length === 0) {
    logger.info({ home: chosenHome.teamName, away: chosenAway.teamName }, 'ESPN lookup: empty schedules');
    return null;
  }

  const homeForm = buildForm(chosenHome, homeEvents);
  const awayForm = buildForm(chosenAway, awayEvents);

  // Lambdas: home's home-scoring rate × away's away-conceding rate (geom mean).
  // Falls back to overall rate when home/away split is empty (tiny samples).
  const homeScoring = homeForm.avgGoalsForHome || (homeForm.played > 0 ? homeForm.goalsFor / homeForm.played : 1.4);
  const awayConceding = awayForm.avgGoalsAgainstAway || (awayForm.played > 0 ? awayForm.goalsAgainst / awayForm.played : 1.3);
  const awayScoring = awayForm.avgGoalsForAway || (awayForm.played > 0 ? awayForm.goalsFor / awayForm.played : 1.1);
  const homeConceding = homeForm.avgGoalsAgainstHome || (homeForm.played > 0 ? homeForm.goalsAgainst / homeForm.played : 1.1);

  const expHomeGoals = Math.max(0.15, Math.min(5, Math.sqrt(homeScoring * awayConceding)));
  const expAwayGoals = Math.max(0.15, Math.min(5, Math.sqrt(awayScoring * homeConceding)));

  return {
    homeForm,
    awayForm,
    sameLeague,
    league: sameLeague ? chosenHome.leagueName : `${chosenHome.leagueName} / ${chosenAway.leagueName}`,
    expHomeGoals,
    expAwayGoals,
  };
}

/** Diagnostics for the dashboard / health check. */
export function getEspnIndexStats(): { leaguesConfigured: number; teamsIndexed: number; loadedAtIso: string | null } {
  return {
    leaguesConfigured: ESPN_LEAGUES.length,
    teamsIndexed: teamIndex.size,
    loadedAtIso: indexLoadedAt > 0 ? new Date(indexLoadedAt).toISOString() : null,
  };
}

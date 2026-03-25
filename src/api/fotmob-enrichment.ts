/**
 * Football Match Enrichment via ESPN + TheSportsDB (no API key required)
 *
 * ESPN: scoreboard, standings, team schedules (form derivation), match stats
 * TheSportsDB: standings with form strings, H2H history, team last 5
 *
 * Used as primary enrichment source — no API key needed.
 */

import { logger } from '../utils/logger.js';
import type { MatchEnrichment } from './football-enrichment.js';

const ESPN_BASE = 'https://site.api.espn.com/apis';
const TSDB_BASE = 'https://www.thesportsdb.com/api/v1/json/3';
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const REQUEST_TIMEOUT = 10_000;

// ESPN league slugs
const ESPN_LEAGUES = ['eng.1', 'eng.2', 'esp.1', 'ger.1', 'ita.1', 'fra.1', 'uefa.champions', 'usa.1', 'ned.1', 'por.1'];

// TheSportsDB league IDs for form/standings
const TSDB_LEAGUES: Record<string, number> = {
  'eng.1': 4328, 'eng.2': 4329, 'esp.1': 4335, 'ger.1': 4331,
  'ita.1': 4332, 'fra.1': 4334, 'usa.1': 4346, 'ned.1': 4337, 'por.1': 4344,
};

// ===== CACHES =====
const enrichCache = new Map<string, { data: MatchEnrichment; ts: number }>();
const standingsCache = new Map<string, { data: StandingsEntry[]; ts: number }>();
const scheduleCache = new Map<string, { data: ScheduleResult[]; ts: number }>();
const scoreBoardCache = new Map<string, { data: ESPNEvent[]; ts: number }>();
const tsdbStandingsCache = new Map<number, { data: TSDBStanding[]; ts: number }>();
const h2hCache = new Map<string, { data: H2HResult; ts: number }>();

// ===== TYPES =====

interface ESPNEvent {
  id: string;
  name: string; // "Arsenal at Chelsea"
  date: string;
  competitions: Array<{
    competitors: Array<{
      id: string;
      homeAway: 'home' | 'away';
      team: { id: string; displayName: string; shortDisplayName: string; abbreviation: string };
      score?: { value: number };
      winner?: boolean;
    }>;
  }>;
  league?: string; // We add this for tracking
}

interface StandingsEntry {
  teamId: string;
  teamName: string;
  rank: number;
  gamesPlayed: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
}

interface ScheduleResult {
  opponentName: string;
  homeAway: 'home' | 'away';
  teamScore: number;
  oppScore: number;
  winner: boolean | null; // null = draw
  date: string;
}

interface TSDBStanding {
  teamName: string;
  form: string; // "WWWWD"
  rank: number;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
}

interface H2HResult {
  homeWins: number;
  awayWins: number;
  draws: number;
  matches: Array<{ homeTeam: string; awayTeam: string; homeScore: number; awayScore: number; date: string }>;
}

// ===== FETCH HELPERS =====

async function fetchJSON<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BetAggregator/1.0)' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.startsWith('<')) return null; // HTML response = blocked
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ===== NAME MATCHING =====

function normName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*(fc|sc|cf|afc|srl|hd|ac|as|ss|us|rc)\s*$/i, '')
    .replace(/^\s*(fc|sc|cf|afc|ac|as|rc)\s+/i, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function nameMatch(a: string, b: string): boolean {
  const na = normName(a);
  const nb = normName(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const fa = na.split(/\s+/)[0]!;
  const fb = nb.split(/\s+/)[0]!;
  if (fa.length >= 4 && fa === fb) return true;
  return false;
}

// ===== ESPN: SCOREBOARD (find match) =====

async function getESPNScoreboard(league: string, dateStr: string): Promise<ESPNEvent[]> {
  const key = `${league}:${dateStr}`;
  const cached = scoreBoardCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const formatted = dateStr.replace(/-/g, '');
  const data = await fetchJSON<{ events?: ESPNEvent[] }>(
    `${ESPN_BASE}/site/v2/sports/soccer/${league}/scoreboard?dates=${formatted}`,
  );
  const events = (data?.events || []).map(e => ({ ...e, league }));
  scoreBoardCache.set(key, { data: events, ts: Date.now() });
  return events;
}

async function findESPNMatch(homeTeam: string, awayTeam: string, matchDate: string | null): Promise<{ event: ESPNEvent; league: string } | null> {
  const dateStr = matchDate || new Date().toISOString().split('T')[0]!;

  // Search across all leagues for this date
  const allEvents = await Promise.all(
    ESPN_LEAGUES.map(async league => {
      const events = await getESPNScoreboard(league, dateStr);
      return events.map(e => ({ event: e, league }));
    }),
  );

  for (const leagueEvents of allEvents) {
    for (const { event, league } of leagueEvents) {
      const comp = event.competitions?.[0];
      if (!comp) continue;
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) continue;
      if (nameMatch(homeTeam, home.team.displayName) && nameMatch(awayTeam, away.team.displayName)) {
        return { event, league };
      }
      if (nameMatch(homeTeam, away.team.displayName) && nameMatch(awayTeam, home.team.displayName)) {
        return { event, league };
      }
    }
  }

  // Try adjacent dates
  const d = new Date(dateStr + 'T12:00:00Z');
  for (const offset of [-1, 1]) {
    const adj = new Date(d.getTime() + offset * 86400000);
    const adjStr = adj.toISOString().split('T')[0]!;
    const adjEvents = await Promise.all(
      ESPN_LEAGUES.map(async league => {
        const events = await getESPNScoreboard(league, adjStr);
        return events.map(e => ({ event: e, league }));
      }),
    );
    for (const leagueEvents of adjEvents) {
      for (const { event, league } of leagueEvents) {
        const comp = event.competitions?.[0];
        if (!comp) continue;
        const home = comp.competitors?.find(c => c.homeAway === 'home');
        const away = comp.competitors?.find(c => c.homeAway === 'away');
        if (!home || !away) continue;
        if (nameMatch(homeTeam, home.team.displayName) && nameMatch(awayTeam, away.team.displayName)) {
          return { event, league };
        }
      }
    }
  }

  return null;
}

// ===== ESPN: STANDINGS =====

async function getESPNStandings(league: string): Promise<StandingsEntry[]> {
  const cached = standingsCache.get(league);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const data = await fetchJSON<{
    children?: Array<{
      standings?: {
        entries?: Array<{
          team?: { id: string; displayName: string };
          stats?: Array<{ name: string; value: number }>;
        }>;
      };
    }>;
  }>(`${ESPN_BASE}/v2/sports/soccer/${league}/standings`);

  const entries: StandingsEntry[] = [];
  const standings = data?.children?.[0]?.standings?.entries;
  if (standings) {
    for (let i = 0; i < standings.length; i++) {
      const e = standings[i]!;
      const stats = new Map(e.stats?.map(s => [s.name, s.value]));
      entries.push({
        teamId: e.team?.id || '',
        teamName: e.team?.displayName || '',
        rank: i + 1,
        gamesPlayed: stats.get('gamesPlayed') || 0,
        wins: stats.get('wins') || 0,
        draws: stats.get('ties') || 0,
        losses: stats.get('losses') || 0,
        goalsFor: stats.get('pointsFor') || 0,
        goalsAgainst: stats.get('pointsAgainst') || 0,
        points: stats.get('points') || 0,
      });
    }
  }

  standingsCache.set(league, { data: entries, ts: Date.now() });
  return entries;
}

// ===== ESPN: TEAM SCHEDULE (for form) =====

async function getTeamSchedule(league: string, teamId: string): Promise<ScheduleResult[]> {
  const key = `${league}:${teamId}`;
  const cached = scheduleCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const data = await fetchJSON<{
    events?: Array<{
      competitions?: Array<{
        competitors?: Array<{
          id: string;
          homeAway: string;
          team: { displayName: string };
          score?: { value: number };
          winner?: boolean;
        }>;
        status?: { type?: { completed?: boolean } };
      }>;
    }>;
  }>(`${ESPN_BASE}/site/v2/sports/soccer/${league}/teams/${teamId}/schedule`);

  const results: ScheduleResult[] = [];
  for (const event of data?.events || []) {
    const comp = event.competitions?.[0];
    if (!comp?.status?.type?.completed) continue;
    const team = comp.competitors?.find(c => c.id === teamId);
    const opp = comp.competitors?.find(c => c.id !== teamId);
    if (!team || !opp) continue;
    results.push({
      opponentName: opp.team.displayName,
      homeAway: team.homeAway as 'home' | 'away',
      teamScore: team.score?.value || 0,
      oppScore: opp.score?.value || 0,
      winner: team.winner === true ? true : opp.winner === true ? false : null,
      date: '',
    });
  }

  scheduleCache.set(key, { data: results, ts: Date.now() });
  return results;
}

function deriveForm(schedule: ScheduleResult[], count = 5): string {
  return schedule.slice(-count).map(r =>
    r.winner === true ? 'W' : r.winner === false ? 'L' : 'D',
  ).join('');
}

// ===== THESPORTSDB: STANDINGS (for form strings) =====

async function getTSDBStandings(leagueId: number): Promise<TSDBStanding[]> {
  const cached = tsdbStandingsCache.get(leagueId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const data = await fetchJSON<{
    table?: Array<{
      strTeam: string;
      strForm: string;
      intRank: string;
      intPlayed: string;
      intWin: string;
      intDraw: string;
      intLoss: string;
      intGoalsFor: string;
      intGoalsAgainst: string;
    }>;
  }>(`${TSDB_BASE}/lookuptable.php?l=${leagueId}&s=2025-2026`);

  const standings: TSDBStanding[] = (data?.table || []).map(t => ({
    teamName: t.strTeam,
    form: t.strForm || '',
    rank: parseInt(t.intRank) || 0,
    played: parseInt(t.intPlayed) || 0,
    wins: parseInt(t.intWin) || 0,
    draws: parseInt(t.intDraw) || 0,
    losses: parseInt(t.intLoss) || 0,
    goalsFor: parseInt(t.intGoalsFor) || 0,
    goalsAgainst: parseInt(t.intGoalsAgainst) || 0,
  }));

  tsdbStandingsCache.set(leagueId, { data: standings, ts: Date.now() });
  return standings;
}

// ===== THESPORTSDB: H2H =====

async function getH2H(homeTeam: string, awayTeam: string): Promise<H2HResult> {
  const key = `${normName(homeTeam)}:${normName(awayTeam)}`;
  const cached = h2hCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const result: H2HResult = { homeWins: 0, awayWins: 0, draws: 0, matches: [] };

  // Try both orderings
  for (const query of [`${homeTeam}_vs_${awayTeam}`, `${awayTeam}_vs_${homeTeam}`]) {
    const data = await fetchJSON<{
      event?: Array<{
        strHomeTeam: string;
        strAwayTeam: string;
        intHomeScore: string;
        intAwayScore: string;
        dateEvent: string;
      }>;
    }>(`${TSDB_BASE}/searchevents.php?e=${encodeURIComponent(query)}`);

    if (data?.event) {
      for (const e of data.event) {
        const hs = parseInt(e.intHomeScore);
        const as = parseInt(e.intAwayScore);
        if (isNaN(hs) || isNaN(as)) continue;
        result.matches.push({
          homeTeam: e.strHomeTeam,
          awayTeam: e.strAwayTeam,
          homeScore: hs,
          awayScore: as,
          date: e.dateEvent,
        });
      }
    }
  }

  // Deduplicate by date
  const seen = new Set<string>();
  result.matches = result.matches.filter(m => {
    const k = `${m.date}:${m.homeTeam}:${m.awayTeam}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Count wins relative to the requested home team
  for (const m of result.matches) {
    const isHome = nameMatch(homeTeam, m.homeTeam);
    if (m.homeScore > m.awayScore) {
      if (isHome) result.homeWins++;
      else result.awayWins++;
    } else if (m.awayScore > m.homeScore) {
      if (isHome) result.awayWins++;
      else result.homeWins++;
    } else {
      result.draws++;
    }
  }

  h2hCache.set(key, { data: result, ts: Date.now() });
  return result;
}

// ===== ESPN INJURIES (from team news + roster) =====

interface InjuryInfo {
  home: Array<{ name: string; position: string; status: string }>;
  away: Array<{ name: string; position: string; status: string }>;
  severity: 'none' | 'low' | 'medium' | 'high';
}

const injuryCache = new Map<string, { data: InjuryInfo; ts: number }>();

async function fetchInjuries(league: string, homeTeamId: string, awayTeamId: string): Promise<InjuryInfo> {
  const key = `${league}:${homeTeamId}:${awayTeamId}`;
  const cached = injuryCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const result: InjuryInfo = { home: [], away: [], severity: 'none' };

  // Fetch team news for both teams — injury reports appear here
  const [homeNews, awayNews] = await Promise.all([
    fetchJSON<{ articles?: Array<{ headline: string; description?: string }> }>(
      `${ESPN_BASE}/site/v2/sports/soccer/${league}/teams/${homeTeamId}/news`,
    ),
    fetchJSON<{ articles?: Array<{ headline: string; description?: string }> }>(
      `${ESPN_BASE}/site/v2/sports/soccer/${league}/teams/${awayTeamId}/news`,
    ),
  ]);

  // Parse injury keywords from headlines
  const injuryKeywords = /injur|ruled out|miss|sidelined|suspend|banned|absent|doubt|hamstring|knee|ankle|muscle|broken|fracture|torn|acl|mcl/i;

  for (const article of homeNews?.articles || []) {
    if (injuryKeywords.test(article.headline)) {
      result.home.push({ name: article.headline, position: '', status: 'out' });
    }
  }
  for (const article of awayNews?.articles || []) {
    if (injuryKeywords.test(article.headline)) {
      result.away.push({ name: article.headline, position: '', status: 'out' });
    }
  }

  const totalAlerts = result.home.length + result.away.length;
  if (totalAlerts >= 4) result.severity = 'high';
  else if (totalAlerts >= 2) result.severity = 'medium';
  else if (totalAlerts >= 1) result.severity = 'low';

  injuryCache.set(key, { data: result, ts: Date.now() });
  return result;
}

// ===== MAIN ENRICHMENT =====

export async function fotmobEnrichMatch(
  homeTeam: string,
  awayTeam: string,
  matchDate: string | null,
): Promise<MatchEnrichment | null> {
  const cacheKey = `${normName(homeTeam)}:${normName(awayTeam)}:${matchDate || 'today'}`;
  const cached = enrichCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  // 1. Find the match on ESPN
  const found = await findESPNMatch(homeTeam, awayTeam, matchDate);
  if (!found) return null;

  const { event, league } = found;
  const comp = event.competitions[0]!;
  const homeComp = comp.competitors.find(c => c.homeAway === 'home')!;
  const awayComp = comp.competitors.find(c => c.homeAway === 'away')!;

  // 2. Fetch standings, schedules, H2H in parallel
  const tsdbLeagueId = TSDB_LEAGUES[league];
  const [standings, homeSchedule, awaySchedule, h2h, tsdbStandings, injuries] = await Promise.all([
    getESPNStandings(league),
    getTeamSchedule(league, homeComp.team.id),
    getTeamSchedule(league, awayComp.team.id),
    getH2H(homeTeam, awayTeam),
    tsdbLeagueId ? getTSDBStandings(tsdbLeagueId) : Promise.resolve([]),
    fetchInjuries(league, homeComp.team.id, awayComp.team.id),
  ]);

  // 3. Get form — prefer TheSportsDB (has ready form strings), fallback to ESPN schedule
  let homeForm = '';
  let awayForm = '';
  if (tsdbStandings.length > 0) {
    const homeTSDB = tsdbStandings.find(t => nameMatch(homeTeam, t.teamName));
    const awayTSDB = tsdbStandings.find(t => nameMatch(awayTeam, t.teamName));
    homeForm = homeTSDB?.form || '';
    awayForm = awayTSDB?.form || '';
  }
  if (!homeForm) homeForm = deriveForm(homeSchedule);
  if (!awayForm) awayForm = deriveForm(awaySchedule);

  // 4. League positions and goals from ESPN standings
  const homeStanding = standings.find(s => nameMatch(homeTeam, s.teamName) || s.teamId === homeComp.team.id);
  const awayStanding = standings.find(s => nameMatch(awayTeam, s.teamName) || s.teamId === awayComp.team.id);
  const homeGF = homeStanding && homeStanding.gamesPlayed > 0 ? Math.round((homeStanding.goalsFor / homeStanding.gamesPlayed) * 100) / 100 : 0;
  const homeGA = homeStanding && homeStanding.gamesPlayed > 0 ? Math.round((homeStanding.goalsAgainst / homeStanding.gamesPlayed) * 100) / 100 : 0;
  const awayGF = awayStanding && awayStanding.gamesPlayed > 0 ? Math.round((awayStanding.goalsFor / awayStanding.gamesPlayed) * 100) / 100 : 0;
  const awayGA = awayStanding && awayStanding.gamesPlayed > 0 ? Math.round((awayStanding.goalsAgainst / awayStanding.gamesPlayed) * 100) / 100 : 0;

  // 5. Estimate win percentages from form + H2H
  const homeFormScore = formToScore(homeForm);
  const awayFormScore = formToScore(awayForm);
  const totalFormScore = homeFormScore + awayFormScore || 1;
  const h2hTotal = h2h.homeWins + h2h.awayWins + h2h.draws || 1;
  const homeWinPct = Math.round((homeFormScore / totalFormScore) * 70 + (h2h.homeWins / h2hTotal) * 30);
  const awayWinPct = Math.round((awayFormScore / totalFormScore) * 70 + (h2h.awayWins / h2hTotal) * 30);
  const drawPct = Math.max(0, 100 - homeWinPct - awayWinPct);

  // 6. Goals prediction
  const expectedGoals = (homeGF + awayGA) / 2 + (awayGF + homeGA) / 2;
  const goalsOver25Pct = expectedGoals > 2.5 ? Math.min(80, Math.round(expectedGoals * 25)) : Math.max(20, Math.round(expectedGoals * 20));

  // 7. Advice
  let advice = '';
  if (homeWinPct > awayWinPct + 15) advice = `Home win: ${homeComp.team.displayName}`;
  else if (awayWinPct > homeWinPct + 15) advice = `Away win: ${awayComp.team.displayName}`;
  else advice = `Close match — Double chance recommended`;

  const enrichment: MatchEnrichment = {
    fixtureId: parseInt(event.id) || 0,
    homeForm,
    awayForm,
    homeWinPct,
    drawPct,
    awayWinPct,
    goalsOver25Pct,
    goalsUnder25Pct: 100 - goalsOver25Pct,
    advice,
    homeLeaguePos: homeStanding?.rank ?? null,
    awayLeaguePos: awayStanding?.rank ?? null,
    homeGoalsFor: homeGF,
    homeGoalsAgainst: homeGA,
    awayGoalsFor: awayGF,
    awayGoalsAgainst: awayGA,
    h2hHomeWins: h2h.homeWins,
    h2hAwayWins: h2h.awayWins,
    h2hDraws: h2h.draws,
  };

  // Add injury data if available
  if (injuries && injuries.severity !== 'none') {
    enrichment.injuries = injuries;
  }

  enrichCache.set(cacheKey, { data: enrichment, ts: Date.now() });
  return enrichment;
}

function formToScore(form: string): number {
  let score = 0;
  for (const c of form) {
    if (c === 'W') score += 3;
    else if (c === 'D') score += 1;
  }
  return score;
}

/**
 * Batch-enrich multiple matches via ESPN + TheSportsDB.
 */
export async function fotmobEnrichMatches(
  matches: Array<{ homeTeam: string; awayTeam: string; matchDate: string | null; eventId: string }>,
): Promise<Map<string, MatchEnrichment>> {
  const results = new Map<string, MatchEnrichment>();

  // Process in batches of 5
  for (let i = 0; i < matches.length; i += 5) {
    const batch = matches.slice(i, i + 5);
    const enrichments = await Promise.allSettled(
      batch.map(m => fotmobEnrichMatch(m.homeTeam, m.awayTeam, m.matchDate)),
    );

    for (let j = 0; j < batch.length; j++) {
      const r = enrichments[j]!;
      if (r.status === 'fulfilled' && r.value) {
        results.set(batch[j]!.eventId, r.value);
      }
    }
  }

  logger.info({ requested: matches.length, enriched: results.size }, 'ESPN+TheSportsDB enrichment complete');
  return results;
}

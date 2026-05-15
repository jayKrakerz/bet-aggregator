/**
 * flashscore.mobi Form Fallback
 *
 * Third fallback after CSV-Poisson + ESPN + api-football. flashscore.mobi
 * (the legacy mobile site) serves every league flashscore tracks as plain
 * HTML with no Cloudflare — including niche markets like Chilean Primera
 * División Women, Argentine Primera A Women, Australian state leagues,
 * Bhutan Premier, etc. Coverage where the other three sources give up.
 *
 * Strategy:
 *   1. Periodically (every 60 min) scrape `/?d=-N&s=1` for N=0..-14. Each
 *      page is ~200KB of HTML containing every match on that day, grouped
 *      by `<h4>COUNTRY: League</h4>` headers.
 *   2. Parse finished matches only (`class="fin"`). Build an in-memory
 *      team→matches index keyed by normalized name.
 *   3. On lookup, find both teams. Compute home/away avg-goals-for/against
 *      → Poisson lambdas, same shape as the ESPN adapter.
 */

import { logger } from '../utils/logger.js';

const BASE = 'https://www.flashscore.mobi';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Mobile/15E148 Safari/604.1';
const DAYS_BACK = 30;
const INDEX_TTL = 60 * 60 * 1000;        // 1h
const FETCH_TIMEOUT = 12_000;
const GENERIC_HOME_LAMBDA = 1.55;
const GENERIC_AWAY_LAMBDA = 1.20;
// Time-decay weighting (xg_lambda pattern from bot-main FootStats):
// matches in the last RECENT_DAYS count RECENT_WEIGHT× toward the goal-rate
// average, older matches count 1×. Stops a 30-day-old result from anchoring
// a team's lambda when their form has clearly shifted since.
const RECENT_DAYS = 14;
const RECENT_WEIGHT = 2.0;

// ── Types ────────────────────────────────────────────────

interface FsMatch {
  date: string;            // YYYY-MM-DD (best effort from offset)
  matchId: string;
  league: string;          // "CHILE: Primera Division Women"
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
}

export interface FlashscoreTeamForm {
  teamName: string;
  league: string;          // dominant league across the team's matches
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
  avgGoalsForHome: number;
  avgGoalsAgainstHome: number;
  avgGoalsForAway: number;
  avgGoalsAgainstAway: number;
}

export interface FlashscoreLookup {
  /** Null when this side fell through to the league/generic prior. */
  homeForm: FlashscoreTeamForm | null;
  awayForm: FlashscoreTeamForm | null;
  sameLeague: boolean;
  league: string;
  expHomeGoals: number;
  expAwayGoals: number;
  /** Which side was filled in from a prior, if any. */
  partial: 'none' | 'home' | 'away';
  /** Human-readable note when the result is partial. */
  partialReason: string | null;
}

// ── HTTP ─────────────────────────────────────────────────

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ── Name normalization ──────────────────────────────────

function normName(s: string): string {
  let v = (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Women's-team variants: flashscore.mobi labels women's teams as
  // "Curicó Unido W". Our input may say "Women", "Femenino", "Femenil",
  // "(W)", or "WSL" — collapse them all to a trailing " w" token so the
  // index matches.
  v = v.replace(/\b(women|womens|femeni(?:no|na|nas|nos|l)|female|feminine|w fc|wfc)\b/g, ' w');
  // Strip common club-form noise tokens.
  v = v.replace(/\b(fc|cf|sc|ac|afc|cd|cs|club|deportivo|deportes)\b/g, ' ');
  v = v.replace(/\s+/g, ' ').trim();
  return v;
}

// ── HTML parsing ─────────────────────────────────────────

interface ParsedDayMatch {
  league: string;
  home: string;
  away: string;
  matchId: string;
  scoreStr: string;
  status: 'fin' | 'live' | 'sched';
}

/**
 * flashscore.mobi structure:
 *   <h4>COUNTRY: League <a ...>Standings</a></h4>
 *   <span>21:00</span>Home Team - Away Team <a href="/match/XXX/..." class="fin">2:1</a><br />
 *   <span>21:00</span>Home2 - Away2 <a ...>...</a><br />
 *   ...
 *   <h4>NEXT COUNTRY: League ...</h4>
 *
 * We split by `<h4>` headers, then scan each block for `<a class="fin">`.
 */
function parseDay(html: string): ParsedDayMatch[] {
  const out: ParsedDayMatch[] = [];

  // Split on <h4> boundaries. The first chunk before any <h4> is the page
  // chrome (header / nav / scripts) — discard.
  const chunks = html.split(/<h4>/);
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    // Extract the league text up to the first <a or </h4>.
    const headerEnd = chunk.search(/<a|<\/h4>/);
    if (headerEnd < 0) continue;
    const league = chunk.slice(0, headerEnd).trim().replace(/\s+/g, ' ');
    if (!league.includes(':')) continue;          // not a "COUNTRY: League" header
    const body = chunk.slice(chunk.indexOf('</h4>') + 5);

    // Match-row regex. Tolerates extra whitespace and Unicode in team names.
    const rowRe = /<span>\s*([^<]+?)\s*<\/span>\s*([^<]+?)\s*<a href="\/match\/([A-Za-z0-9]+)\/[^"]*"\s+class="(fin|live|sched)">\s*([^<]+?)\s*<\/a>/g;

    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(body)) !== null) {
      const teamsBlob = m[2] ?? '';
      const matchId = m[3] ?? '';
      const status = (m[4] ?? 'fin') as 'fin' | 'live' | 'sched';
      const scoreStr = (m[5] ?? '').trim();

      // teamsBlob is "Home Name - Away Name". Split on " - " with surrounding
      // spaces. Some team names contain hyphens, so split on the LAST " - "
      // before the </span> end. flashscore renders a regular hyphen between
      // teams, but some teams legitimately contain " - " in their name — we
      // rely on the fact that the separator is bracketed by spaces.
      const sepIdx = teamsBlob.lastIndexOf(' - ');
      if (sepIdx < 0) continue;
      const home = teamsBlob.slice(0, sepIdx).trim();
      const away = teamsBlob.slice(sepIdx + 3).trim();
      if (!home || !away) continue;

      out.push({ league, home, away, matchId, scoreStr, status });
    }
  }
  return out;
}

function isoDateForOffset(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

// ── Index ────────────────────────────────────────────────

interface TeamIndexEntry {
  /** Display name (first encountered casing). */
  name: string;
  matches: FsMatch[];
}

const teamIndex = new Map<string, TeamIndexEntry>();
/** Per-league avg goals — used as a prior when one side isn't found. */
interface LeagueStats { matches: number; totalHomeGoals: number; totalAwayGoals: number }
const leagueStats = new Map<string, LeagueStats>();
let indexLoadedAt = 0;
let indexInflight: Promise<void> | null = null;

function indexAddMatch(rawHome: string, rawAway: string, match: FsMatch) {
  const hKey = normName(rawHome);
  const aKey = normName(rawAway);
  if (hKey) {
    const e = teamIndex.get(hKey) ?? { name: rawHome, matches: [] };
    e.matches.push(match);
    teamIndex.set(hKey, e);
  }
  if (aKey) {
    const e = teamIndex.get(aKey) ?? { name: rawAway, matches: [] };
    e.matches.push(match);
    teamIndex.set(aKey, e);
  }
}

export async function preloadFlashscore(force = false): Promise<{ days: number; teams: number; matches: number }> {
  if (!force && Date.now() - indexLoadedAt < INDEX_TTL && teamIndex.size > 0) {
    return { days: DAYS_BACK, teams: teamIndex.size, matches: countMatches() };
  }
  if (indexInflight) { await indexInflight; return { days: DAYS_BACK, teams: teamIndex.size, matches: countMatches() }; }

  indexInflight = (async () => {
    teamIndex.clear();
    leagueStats.clear();
    let totalMatches = 0;
    let loadedDays = 0;
    const offsets: number[] = [];
    for (let i = 0; i <= DAYS_BACK; i++) offsets.push(-i);

    const results = await Promise.allSettled(
      offsets.map(async (o) => {
        const html = await fetchText(`${BASE}/?d=${o}&s=1`);
        if (!html) return { offset: o, matches: [] as ParsedDayMatch[] };
        return { offset: o, matches: parseDay(html) };
      }),
    );

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      loadedDays++;
      const date = isoDateForOffset(r.value.offset);
      for (const p of r.value.matches) {
        if (p.status !== 'fin') continue;
        const [hg, ag] = p.scoreStr.split(':').map(s => parseInt(s.trim(), 10));
        if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
        const fs: FsMatch = {
          date,
          matchId: p.matchId,
          league: p.league,
          home: p.home,
          away: p.away,
          homeGoals: hg!,
          awayGoals: ag!,
        };
        indexAddMatch(p.home, p.away, fs);
        // Per-league goal averages (used as priors for one-sided lookups).
        const ls = leagueStats.get(p.league) ?? { matches: 0, totalHomeGoals: 0, totalAwayGoals: 0 };
        ls.matches++;
        ls.totalHomeGoals += hg!;
        ls.totalAwayGoals += ag!;
        leagueStats.set(p.league, ls);
        totalMatches++;
      }
    }

    indexLoadedAt = Date.now();
    logger.info(
      { loadedDays, totalMatches, indexedTeams: teamIndex.size, indexedLeagues: leagueStats.size },
      'flashscore.mobi index loaded',
    );
  })();

  await indexInflight;
  indexInflight = null;
  return { days: DAYS_BACK, teams: teamIndex.size, matches: countMatches() };
}

function countMatches(): number {
  // Each finished match is counted twice in the team index (home + away).
  let n = 0;
  for (const v of teamIndex.values()) n += v.matches.length;
  return Math.round(n / 2);
}

// ── Team lookup ──────────────────────────────────────────

function findTeam(query: string): TeamIndexEntry | null {
  const target = normName(query);
  if (!target) return null;

  // Exact match.
  const exact = teamIndex.get(target);
  if (exact) return exact;

  // Multi-strategy fuzzy match. South American teams often carry city
  // suffixes ("12 de Junio de Villa Hayes" but flashscore indexes them
  // as "12 de Junio"), so pure token-Jaccard against full strings misses.
  const targetTokens = new Set(target.split(/\s+/).filter(t => t.length >= 3 || /^\d+$/.test(t)));
  let best: { key: string; entry: TeamIndexEntry; score: number } | null = null;

  for (const [key, entry] of teamIndex) {
    let score = 0;
    const keyTokens = new Set(key.split(/\s+/).filter(t => t.length >= 3 || /^\d+$/.test(t)));

    if (key === target) {
      score = 100;
    } else if (keyTokens.size >= 1 && targetTokens.size >= keyTokens.size && allIn(keyTokens, targetTokens)) {
      // Every meaningful key token appears in the query — high confidence
      // even when the query is much longer ("12 de junio" ⊂ "12 de junio
      // de villa hayes"). Penalize lightly for the extra noise in query.
      score = 78 - Math.min(targetTokens.size - keyTokens.size, 4) * 3;
    } else if (targetTokens.size >= 1 && allIn(targetTokens, keyTokens)) {
      // Reverse — every meaningful query token appears in the key.
      score = 72 - Math.min(keyTokens.size - targetTokens.size, 4) * 3;
    } else if (key.includes(target) || target.includes(key)) {
      // Whole-string substring (handles single-token teams like "Paro").
      const shorter = Math.min(key.length, target.length);
      const longer = Math.max(key.length, target.length);
      score = 55 * (shorter / longer) + 25;
    } else if (targetTokens.size > 0 && keyTokens.size > 0) {
      let inter = 0;
      for (const t of targetTokens) if (keyTokens.has(t)) inter++;
      if (inter === 0) continue;
      const union = targetTokens.size + keyTokens.size - inter;
      score = (inter / union) * 80;
    } else {
      continue;
    }

    // Tie-break: more matches indexed = more confident the team is real.
    score += Math.min(entry.matches.length, 10) * 0.4;

    if (score >= 50 && (!best || score > best.score)) {
      best = { key, entry, score };
    }
  }
  return best?.entry ?? null;
}

function allIn(needle: Set<string>, haystack: Set<string>): boolean {
  for (const t of needle) if (!haystack.has(t)) return false;
  return true;
}

function emptySplit() {
  return { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0 };
}

/** Weight a match by how recent it is. Step function: ≤14 days = 2.0, else 1.0. */
function matchWeight(matchDate: string, now = Date.now()): number {
  if (!matchDate) return 1.0;
  const t = Date.parse(matchDate);
  if (!Number.isFinite(t)) return 1.0;
  const ageDays = (now - t) / 86_400_000;
  return ageDays <= RECENT_DAYS ? RECENT_WEIGHT : 1.0;
}

function buildForm(teamName: string, entry: TeamIndexEntry): FlashscoreTeamForm {
  const home = emptySplit();
  const away = emptySplit();
  // Weighted sums used for goal-rate averages (lambda inputs). Counts above
  // stay integer so the UI's "Last 30d: 6 GP · 9 GF" line remains honest.
  const wHome = { gf: 0, ga: 0, weight: 0 };
  const wAway = { gf: 0, ga: 0, weight: 0 };
  const recents: Array<{ result: 'W' | 'D' | 'L'; date: string }> = [];
  const leagueCounts = new Map<string, number>();
  const now = Date.now();

  const tNorm = normName(teamName);
  for (const m of entry.matches) {
    const hNorm = normName(m.home);
    const isHome = hNorm === tNorm;
    leagueCounts.set(m.league, (leagueCounts.get(m.league) ?? 0) + 1);
    const w = matchWeight(m.date, now);

    if (isHome) {
      home.played++;
      home.goalsFor += m.homeGoals;
      home.goalsAgainst += m.awayGoals;
      const r: 'W' | 'D' | 'L' = m.homeGoals > m.awayGoals ? 'W' : m.homeGoals < m.awayGoals ? 'L' : 'D';
      home[r === 'W' ? 'wins' : r === 'D' ? 'draws' : 'losses']++;
      wHome.gf += m.homeGoals * w;
      wHome.ga += m.awayGoals * w;
      wHome.weight += w;
      recents.push({ result: r, date: m.date });
    } else {
      // Treat anything not exact-home-match as away.
      away.played++;
      away.goalsFor += m.awayGoals;
      away.goalsAgainst += m.homeGoals;
      const r: 'W' | 'D' | 'L' = m.awayGoals > m.homeGoals ? 'W' : m.awayGoals < m.homeGoals ? 'L' : 'D';
      away[r === 'W' ? 'wins' : r === 'D' ? 'draws' : 'losses']++;
      wAway.gf += m.awayGoals * w;
      wAway.ga += m.homeGoals * w;
      wAway.weight += w;
      recents.push({ result: r, date: m.date });
    }
  }

  recents.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const recentForm = recents.slice(0, 5).map(r => r.result);

  // Dominant league = most-played for this team within the window.
  let dominantLeague = entry.matches[0]?.league ?? '';
  let bestCount = 0;
  for (const [lg, c] of leagueCounts) {
    if (c > bestCount) { bestCount = c; dominantLeague = lg; }
  }
  const [country, leagueName] = splitLeagueHeader(dominantLeague);

  return {
    teamName: entry.name,
    league: leagueName,
    country,
    played: home.played + away.played,
    wins: home.wins + away.wins,
    draws: home.draws + away.draws,
    losses: home.losses + away.losses,
    goalsFor: home.goalsFor + away.goalsFor,
    goalsAgainst: home.goalsAgainst + away.goalsAgainst,
    homeSplit: home,
    awaySplit: away,
    recentForm,
    avgGoalsForHome: wHome.weight > 0 ? wHome.gf / wHome.weight : 0,
    avgGoalsAgainstHome: wHome.weight > 0 ? wHome.ga / wHome.weight : 0,
    avgGoalsForAway: wAway.weight > 0 ? wAway.gf / wAway.weight : 0,
    avgGoalsAgainstAway: wAway.weight > 0 ? wAway.ga / wAway.weight : 0,
  };
}

function splitLeagueHeader(header: string): [country: string, league: string] {
  const i = header.indexOf(':');
  if (i < 0) return ['', header];
  const country = header.slice(0, i).trim();
  const rest = header.slice(i + 1).trim();
  // Strip trailing "Standings" / play-off suffixes — best-effort.
  return [country, rest];
}

// ── Public API ───────────────────────────────────────────

/** Recover league avgs for the "missing side" of a one-sided lookup. Falls
 *  back to the generic football prior if the matched team's league is empty. */
function leagueAvgFor(leagueHeader: string | null | undefined): { homeAvg: number; awayAvg: number; from: 'league' | 'generic'; league: string | null } {
  if (leagueHeader) {
    // Try the exact dominant league first, then any with the same country prefix.
    const exact = leagueStats.get(leagueHeader);
    if (exact && exact.matches >= 3) {
      return {
        homeAvg: exact.totalHomeGoals / exact.matches,
        awayAvg: exact.totalAwayGoals / exact.matches,
        from: 'league',
        league: leagueHeader,
      };
    }
  }
  return { homeAvg: GENERIC_HOME_LAMBDA, awayAvg: GENERIC_AWAY_LAMBDA, from: 'generic', league: null };
}

export async function lookupViaFlashscore(home: string, away: string): Promise<FlashscoreLookup | null> {
  await preloadFlashscore();

  const hEntry = findTeam(home);
  const aEntry = findTeam(away);
  if (!hEntry && !aEntry) {
    logger.info({ home, away }, 'flashscore.mobi: neither team found');
    return null;
  }

  const homeForm = hEntry && hEntry.matches.length > 0 ? buildForm(home, hEntry) : null;
  const awayForm = aEntry && aEntry.matches.length > 0 ? buildForm(away, aEntry) : null;

  // Both null after build (entries existed but had no usable matches).
  if (!homeForm && !awayForm) return null;

  // Decide partial flag.
  const partial: 'none' | 'home' | 'away' =
    homeForm && awayForm ? 'none' : !homeForm ? 'home' : 'away';

  // Pick the dominant league: prefer the matched team's; if both matched and
  // they share, that's a clean same-league result.
  const matchedLeagueHeader =
    (homeForm && awayForm && headerFromForm(homeForm) === headerFromForm(awayForm))
      ? headerFromForm(homeForm)
      : (homeForm ? headerFromForm(homeForm) : awayForm ? headerFromForm(awayForm) : null);

  // For each side, derive scoring + conceding rates. Missing side uses the
  // matched team's league average.
  const prior = leagueAvgFor(matchedLeagueHeader);

  const homeScoring = homeForm
    ? (homeForm.avgGoalsForHome || (homeForm.played > 0 ? homeForm.goalsFor / homeForm.played : prior.homeAvg))
    : prior.homeAvg;
  const homeConceding = homeForm
    ? (homeForm.avgGoalsAgainstHome || (homeForm.played > 0 ? homeForm.goalsAgainst / homeForm.played : prior.awayAvg))
    : prior.awayAvg;
  const awayScoring = awayForm
    ? (awayForm.avgGoalsForAway || (awayForm.played > 0 ? awayForm.goalsFor / awayForm.played : prior.awayAvg))
    : prior.awayAvg;
  const awayConceding = awayForm
    ? (awayForm.avgGoalsAgainstAway || (awayForm.played > 0 ? awayForm.goalsAgainst / awayForm.played : prior.homeAvg))
    : prior.homeAvg;

  const expHomeGoals = Math.max(0.15, Math.min(5, Math.sqrt(homeScoring * awayConceding)));
  const expAwayGoals = Math.max(0.15, Math.min(5, Math.sqrt(awayScoring * homeConceding)));

  // Same-league flag is only meaningful when both sides matched.
  const sameLeague = !!(homeForm && awayForm && homeForm.league === awayForm.league && homeForm.country === awayForm.country);

  let leagueLabel: string;
  if (homeForm && awayForm) {
    leagueLabel = sameLeague
      ? `${homeForm.country} · ${homeForm.league}`
      : `${homeForm.country} · ${homeForm.league} / ${awayForm.country} · ${awayForm.league}`;
  } else if (homeForm) {
    leagueLabel = `${homeForm.country} · ${homeForm.league}`;
  } else if (awayForm) {
    leagueLabel = `${awayForm.country} · ${awayForm.league}`;
  } else {
    leagueLabel = '';
  }

  let partialReason: string | null = null;
  if (partial === 'home') {
    partialReason = `Home team not found in flashscore window — used ${prior.from === 'league' ? prior.league + ' average' : 'generic football prior'} for the home side.`;
  } else if (partial === 'away') {
    partialReason = `Away team not found in flashscore window — used ${prior.from === 'league' ? prior.league + ' average' : 'generic football prior'} for the away side.`;
  }

  return {
    homeForm,
    awayForm,
    sameLeague,
    league: leagueLabel,
    expHomeGoals,
    expAwayGoals,
    partial,
    partialReason,
  };
}

function headerFromForm(f: FlashscoreTeamForm): string {
  return f.country ? `${f.country}: ${f.league}` : f.league;
}

export function getFlashscoreIndexStats(): { daysWindow: number; teamsIndexed: number; matchesIndexed: number; loadedAtIso: string | null } {
  return {
    daysWindow: DAYS_BACK,
    teamsIndexed: teamIndex.size,
    matchesIndexed: countMatches(),
    loadedAtIso: indexLoadedAt > 0 ? new Date(indexLoadedAt).toISOString() : null,
  };
}

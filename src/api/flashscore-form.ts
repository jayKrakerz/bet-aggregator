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
const DAYS_BACK = 14;
const INDEX_TTL = 60 * 60 * 1000;        // 1h
const FETCH_TIMEOUT = 12_000;

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
  homeForm: FlashscoreTeamForm;
  awayForm: FlashscoreTeamForm;
  sameLeague: boolean;
  league: string;
  expHomeGoals: number;
  expAwayGoals: number;
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
        totalMatches++;
      }
    }

    indexLoadedAt = Date.now();
    logger.info(
      { loadedDays, totalMatches, indexedTeams: teamIndex.size },
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

  // Substring / token-overlap fallback. Same scoring rules as espn-form.ts.
  const targetTokens = new Set(target.split(/\s+/).filter(t => t.length >= 3));
  let best: { key: string; entry: TeamIndexEntry; score: number } | null = null;
  for (const [key, entry] of teamIndex) {
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
    // Tie-break: more matches indexed = more confident the team is real.
    score += Math.min(entry.matches.length, 10) * 0.5;
    if (score >= 45 && (!best || score > best.score)) best = { key, entry, score };
  }
  return best?.entry ?? null;
}

function emptySplit() {
  return { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0 };
}

function buildForm(teamName: string, entry: TeamIndexEntry): FlashscoreTeamForm {
  const home = emptySplit();
  const away = emptySplit();
  const recents: Array<{ result: 'W' | 'D' | 'L'; date: string }> = [];
  const leagueCounts = new Map<string, number>();

  const tNorm = normName(teamName);
  for (const m of entry.matches) {
    const hNorm = normName(m.home);
    const isHome = hNorm === tNorm;
    leagueCounts.set(m.league, (leagueCounts.get(m.league) ?? 0) + 1);

    if (isHome) {
      home.played++;
      home.goalsFor += m.homeGoals;
      home.goalsAgainst += m.awayGoals;
      const r: 'W' | 'D' | 'L' = m.homeGoals > m.awayGoals ? 'W' : m.homeGoals < m.awayGoals ? 'L' : 'D';
      home[r === 'W' ? 'wins' : r === 'D' ? 'draws' : 'losses']++;
      recents.push({ result: r, date: m.date });
    } else {
      // Treat anything not exact-home-match as away.
      away.played++;
      away.goalsFor += m.awayGoals;
      away.goalsAgainst += m.homeGoals;
      const r: 'W' | 'D' | 'L' = m.awayGoals > m.homeGoals ? 'W' : m.awayGoals < m.homeGoals ? 'L' : 'D';
      away[r === 'W' ? 'wins' : r === 'D' ? 'draws' : 'losses']++;
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
    avgGoalsForHome: home.played > 0 ? home.goalsFor / home.played : 0,
    avgGoalsAgainstHome: home.played > 0 ? home.goalsAgainst / home.played : 0,
    avgGoalsForAway: away.played > 0 ? away.goalsFor / away.played : 0,
    avgGoalsAgainstAway: away.played > 0 ? away.goalsAgainst / away.played : 0,
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

export async function lookupViaFlashscore(home: string, away: string): Promise<FlashscoreLookup | null> {
  await preloadFlashscore();

  const hEntry = findTeam(home);
  const aEntry = findTeam(away);
  if (!hEntry || !aEntry) {
    logger.info({ home, away, hHit: !!hEntry, aHit: !!aEntry }, 'flashscore.mobi: team not found');
    return null;
  }

  // Need at least a couple of finished matches per side for a useful lambda.
  if (hEntry.matches.length === 0 || aEntry.matches.length === 0) return null;

  const homeForm = buildForm(home, hEntry);
  const awayForm = buildForm(away, aEntry);

  // Same dominant league?
  const sameLeague = !!homeForm.league && homeForm.league === awayForm.league && homeForm.country === awayForm.country;

  // Poisson lambdas: geom mean of home-scoring × away-conceding, capped at
  // 0.15..5 goals.
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
    league: sameLeague
      ? `${homeForm.country} · ${homeForm.league}`
      : `${homeForm.country} · ${homeForm.league} / ${awayForm.country} · ${awayForm.league}`,
    expHomeGoals,
    expAwayGoals,
  };
}

export function getFlashscoreIndexStats(): { daysWindow: number; teamsIndexed: number; matchesIndexed: number; loadedAtIso: string | null } {
  return {
    daysWindow: DAYS_BACK,
    teamsIndexed: teamIndex.size,
    matchesIndexed: countMatches(),
    loadedAtIso: indexLoadedAt > 0 ? new Date(indexLoadedAt).toISOString() : null,
  };
}

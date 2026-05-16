/**
 * Onefootball Free Form-Data Fallback
 *
 * Onefootball publishes per-team fixture pages as server-side-rendered
 * Next.js apps. The `/en/team/{slug}-{id}/results` URL ships every recent
 * finished match inside the `__NEXT_DATA__` script tag — no auth, no
 * Cloudflare, no rate-limit headers in practice. We use it as a fallback
 * before flashscore.mobi because Onefootball's coverage is broader (mid-
 * tier African / Asian / South American leagues that ESPN misses) and
 * the data is structured JSON, not HTML soup.
 *
 * Strategy:
 *   1. /v2/en/search?q={name} returns up to ~10 team matches as JSON.
 *      Fuzzy-rank by token overlap with the user's input.
 *   2. Per candidate team, fetch /en/team/{slug}-{id}/results and parse
 *      the __NEXT_DATA__ JSON for `matchCardsListsAppender.lists`. Each
 *      match card carries homeTeam.score, awayTeam.score, kickoff,
 *      competitionName.
 *   3. Compute home/away splits the same way flashscore-form does so the
 *      downstream Poisson math is comparable across sources.
 *
 * Quirks:
 *   - Team page sometimes contains future fixtures even on /results; we
 *     keep only entries with numeric scores.
 *   - Onefootball team `id` is from search; the slug is in the returned
 *     `url` (e.g. "/en/team/arsenal-2" → slug="arsenal", id=2).
 */

import { logger } from '../utils/logger.js';

const SEARCH_BASE = 'https://search-api.onefootball.com/v2/en/search';
const PAGE_BASE = 'https://onefootball.com/en/team';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 10_000;
const CACHE_TTL = 6 * 60 * 60 * 1000;     // team-results cache: 6h
const SEARCH_TTL = 24 * 60 * 60 * 1000;   // search cache: 24h
const RECENT_LIMIT = 12;

// ── Types ────────────────────────────────────────────────

interface OfTeamRef {
  id: number;
  name: string;
  country: string;
  slug: string;
}

interface OfMatch {
  date: string;            // ISO YYYY-MM-DD (kickoff date)
  competition: string;
  homeName: string;
  awayName: string;
  homeGoals: number;
  awayGoals: number;
  isHome: boolean;         // ref team played at home this match
}

export interface OnefootballTeamForm {
  teamId: number;
  teamName: string;
  league: string;          // dominant competition across matches
  country: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  homeSplit: { played: number; wins: number; draws: number; losses: number; goalsFor: number; goalsAgainst: number };
  awaySplit: { played: number; wins: number; draws: number; losses: number; goalsFor: number; goalsAgainst: number };
  recentForm: string[];    // newest first, W/D/L
  avgGoalsForHome: number;
  avgGoalsAgainstHome: number;
  avgGoalsForAway: number;
  avgGoalsAgainstAway: number;
  homeUnbeatenStreak: number;
  momentumStreak: number;
}

export interface OnefootballLookup {
  homeForm: OnefootballTeamForm;
  awayForm: OnefootballTeamForm;
  sameLeague: boolean;
  league: string;
  expHomeGoals: number;
  expAwayGoals: number;
}

// ── HTTP helpers ─────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      // The /results page can be 200KB+; allow generous redirect follow.
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ── Search ───────────────────────────────────────────────

interface RawSearchResp {
  teams?: Array<{
    id: number;
    name: string;
    country?: { name?: string };
    url?: string;       // e.g. "/en/team/arsenal-2"
  }>;
}

const searchCache = new Map<string, { ts: number; refs: OfTeamRef[] }>();

function parseTeamUrl(url: string | undefined, fallbackId: number): string {
  // /en/team/<slug>-<id> → slug.
  if (!url) return String(fallbackId);
  const m = url.match(/\/team\/([^/]+?)-(\d+)\/?$/);
  return m ? m[1]! : String(fallbackId);
}

function normName(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchTeams(query: string): Promise<OfTeamRef[]> {
  const key = normName(query);
  if (!key) return [];
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.ts < SEARCH_TTL) return cached.refs;

  const url = `${SEARCH_BASE}?q=${encodeURIComponent(query)}`;
  const data = await fetchJson<RawSearchResp>(url);
  if (!data || !Array.isArray(data.teams)) {
    searchCache.set(key, { ts: Date.now(), refs: [] });
    return [];
  }
  const refs: OfTeamRef[] = data.teams
    .filter(t => typeof t.id === 'number' && t.name)
    .map(t => ({
      id: t.id,
      name: t.name,
      country: t.country?.name || '',
      slug: parseTeamUrl(t.url, t.id),
    }));
  searchCache.set(key, { ts: Date.now(), refs });
  return refs;
}

function fuzzyRank(query: string, refs: OfTeamRef[]): OfTeamRef[] {
  const target = normName(query);
  const tt = new Set(target.split(' ').filter(t => t.length >= 3));
  return refs
    .map(ref => {
      const k = normName(ref.name);
      let score = 0;
      if (k === target) score = 100;
      else if (k.includes(target) || target.includes(k)) {
        const shorter = Math.min(k.length, target.length);
        const longer = Math.max(k.length, target.length);
        score = 60 * (shorter / longer);
      } else {
        const kt = new Set(k.split(' ').filter(t => t.length >= 3));
        let overlap = 0;
        for (const t of tt) if (kt.has(t)) overlap++;
        if (overlap > 0) {
          const union = tt.size + kt.size - overlap;
          score = (overlap / union) * 80;
        }
      }
      return { ref, score };
    })
    .filter(r => r.score >= 45)
    .sort((a, b) => b.score - a.score)
    .map(r => r.ref);
}

// ── Team results page ───────────────────────────────────

const resultsCache = new Map<number, { ts: number; matches: OfMatch[]; canonicalName: string }>();

interface NextMatchCard {
  matchId?: string;
  competitionName?: string;
  kickoff?: string;
  period?: number;
  homeTeam?: { name?: string; score?: string };
  awayTeam?: { name?: string; score?: string };
}

interface NextDataShape {
  props?: {
    pageProps?: {
      containers?: unknown;
    };
  };
}

function extractNextData(html: string): NextDataShape | null {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!);
  } catch {
    return null;
  }
}

function walkForMatchCards(obj: unknown, out: NextMatchCard[]): void {
  if (Array.isArray(obj)) {
    for (const v of obj) walkForMatchCards(v, out);
  } else if (obj && typeof obj === 'object') {
    const rec = obj as Record<string, unknown>;
    const ct = rec.contentType as Record<string, unknown> | undefined;
    if (ct && ct.$case === 'matchCardsListsAppender') {
      const inner = ct.matchCardsListsAppender as { lists?: Array<{ matchCards?: NextMatchCard[] }> } | undefined;
      if (inner?.lists) {
        for (const lst of inner.lists) {
          if (Array.isArray(lst.matchCards)) out.push(...lst.matchCards);
        }
      }
    }
    for (const v of Object.values(rec)) walkForMatchCards(v, out);
  }
}

async function fetchTeamResults(ref: OfTeamRef): Promise<{ matches: OfMatch[]; canonicalName: string } | null> {
  const cached = resultsCache.get(ref.id);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached;

  const url = `${PAGE_BASE}/${encodeURIComponent(ref.slug)}-${ref.id}/results`;
  const html = await fetchText(url);
  if (!html) return null;

  const next = extractNextData(html);
  if (!next) return null;

  const cards: NextMatchCard[] = [];
  walkForMatchCards(next.props?.pageProps?.containers, cards);
  if (cards.length === 0) return null;

  const targetKey = normName(ref.name);
  const matches: OfMatch[] = [];
  for (const c of cards) {
    const h = c.homeTeam?.name?.trim();
    const a = c.awayTeam?.name?.trim();
    const hs = parseInt(c.homeTeam?.score ?? '', 10);
    const as_ = parseInt(c.awayTeam?.score ?? '', 10);
    if (!h || !a || !Number.isFinite(hs) || !Number.isFinite(as_)) continue;
    const date = (c.kickoff ?? '').slice(0, 10);
    const isHome = normName(h) === targetKey;
    const isAway = normName(a) === targetKey;
    if (!isHome && !isAway) continue; // sanity check — ref must be one of the two sides
    matches.push({
      date,
      competition: c.competitionName ?? '',
      homeName: h,
      awayName: a,
      homeGoals: hs,
      awayGoals: as_,
      isHome,
    });
  }
  matches.sort((x, y) => y.date.localeCompare(x.date));
  const trimmed = matches.slice(0, RECENT_LIMIT);
  const out = { matches: trimmed, canonicalName: ref.name };
  resultsCache.set(ref.id, { ts: Date.now(), ...out });
  return out;
}

// ── Form computation ────────────────────────────────────

function emptySplit() {
  return { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0 };
}

function buildForm(ref: OfTeamRef, matches: OfMatch[]): OnefootballTeamForm {
  const home = emptySplit();
  const away = emptySplit();
  const recents: Array<'W' | 'D' | 'L'> = [];
  const compTally = new Map<string, number>();

  for (const m of matches) {
    compTally.set(m.competition, (compTally.get(m.competition) ?? 0) + 1);
    const gf = m.isHome ? m.homeGoals : m.awayGoals;
    const ga = m.isHome ? m.awayGoals : m.homeGoals;
    const r: 'W' | 'D' | 'L' = gf > ga ? 'W' : gf < ga ? 'L' : 'D';
    recents.push(r);
    const split = m.isHome ? home : away;
    split.played++;
    split.goalsFor += gf;
    split.goalsAgainst += ga;
    if (r === 'W') split.wins++;
    else if (r === 'D') split.draws++;
    else split.losses++;
  }

  // Dominant competition = most-frequent across this team's matches.
  let league = ref.name + ' (n/a)';
  let best = 0;
  for (const [comp, n] of compTally) {
    if (n > best && comp) { best = n; league = comp; }
  }

  const played = home.played + away.played;
  const wins = home.wins + away.wins;
  const draws = home.draws + away.draws;
  const losses = home.losses + away.losses;
  const goalsFor = home.goalsFor + away.goalsFor;
  const goalsAgainst = home.goalsAgainst + away.goalsAgainst;

  const avg = (n: number, d: number) => (d > 0 ? n / d : 0);
  const avgGoalsForHome = avg(home.goalsFor, home.played);
  const avgGoalsAgainstHome = avg(home.goalsAgainst, home.played);
  const avgGoalsForAway = avg(away.goalsFor, away.played);
  const avgGoalsAgainstAway = avg(away.goalsAgainst, away.played);

  // Home Fortress: consecutive home games without a loss, newest first.
  let homeUnbeatenStreak = 0;
  const homeMatchesNewestFirst = matches.filter(m => m.isHome);
  for (const m of homeMatchesNewestFirst) {
    const gf = m.homeGoals, ga = m.awayGoals;
    if (gf >= ga) homeUnbeatenStreak++;
    else break;
  }

  // Momentum: signed consecutive W (positive) / L (negative) across all venues.
  let momentumStreak = 0;
  if (recents.length > 0) {
    const first = recents[0]!;
    if (first === 'W' || first === 'L') {
      const target = first;
      for (const r of recents) {
        if (r === target) momentumStreak += target === 'W' ? 1 : -1;
        else break;
      }
    }
  }

  return {
    teamId: ref.id,
    teamName: ref.name,
    league,
    country: ref.country,
    played,
    wins, draws, losses,
    goalsFor, goalsAgainst,
    homeSplit: home,
    awaySplit: away,
    recentForm: recents.slice(0, 5),
    avgGoalsForHome,
    avgGoalsAgainstHome,
    avgGoalsForAway,
    avgGoalsAgainstAway,
    homeUnbeatenStreak,
    momentumStreak,
  };
}

// ── Public lookup ────────────────────────────────────────

const LEAGUE_STOP = new Set([
  'league','leagues','division','divisions','div','liga','ligue','serie',
  'football','soccer','fc','de','del','of','the','and',
]);

function leagueTokens(s: string): Set<string> {
  return new Set(
    (s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 3 && !LEAGUE_STOP.has(t)),
  );
}

function hasTokenOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (b.has(t)) return true;
  return false;
}

async function resolveBest(query: string): Promise<{ ref: OfTeamRef; matches: OfMatch[] } | null> {
  const refs = await searchTeams(query);
  const ranked = fuzzyRank(query, refs);
  // Try top 3 candidates — first one with usable results wins. Onefootball
  // search sometimes returns suggestions that match name but have no
  // recent results (defunct teams, name collisions).
  for (const ref of ranked.slice(0, 3)) {
    const r = await fetchTeamResults(ref);
    if (r && r.matches.length > 0) return { ref, matches: r.matches };
  }
  return null;
}

export async function lookupViaOnefootball(home: string, away: string, leagueHint?: string): Promise<OnefootballLookup | null> {
  const [hRes, aRes] = await Promise.all([resolveBest(home), resolveBest(away)]);
  if (!hRes || !aRes) {
    if (!hRes && !aRes) logger.info({ home, away }, 'onefootball: neither team resolved');
    return null;
  }

  const homeForm = buildForm(hRes.ref, hRes.matches);
  const awayForm = buildForm(aRes.ref, aRes.matches);

  // League-hint gate: same logic as flashscore — if the user gave a hint
  // and neither matched league shares a meaningful token with it, refuse
  // the match so we fall through to the next source instead of returning
  // confident cross-league lambdas.
  if (leagueHint && leagueHint.trim()) {
    const hintTokens = leagueTokens(leagueHint);
    const homeAligns = hasTokenOverlap(hintTokens, leagueTokens(`${homeForm.country} ${homeForm.league}`));
    const awayAligns = hasTokenOverlap(hintTokens, leagueTokens(`${awayForm.country} ${awayForm.league}`));
    if (hintTokens.size > 0 && !homeAligns && !awayAligns) {
      logger.info(
        { home, away, leagueHint, homeLeague: homeForm.league, awayLeague: awayForm.league },
        'onefootball: league-hint gate rejected match',
      );
      return null;
    }
  }

  // Lambdas: home's home-scoring rate × away's away-conceding rate (geom
  // mean), with fall-backs when either split is empty (small samples).
  const homeScoring = homeForm.avgGoalsForHome || (homeForm.played > 0 ? homeForm.goalsFor / homeForm.played : 1.4);
  const awayConceding = awayForm.avgGoalsAgainstAway || (awayForm.played > 0 ? awayForm.goalsAgainst / awayForm.played : 1.3);
  const awayScoring = awayForm.avgGoalsForAway || (awayForm.played > 0 ? awayForm.goalsFor / awayForm.played : 1.1);
  const homeConceding = homeForm.avgGoalsAgainstHome || (homeForm.played > 0 ? homeForm.goalsAgainst / homeForm.played : 1.1);

  const expHomeGoals = Math.max(0.15, Math.min(5, Math.sqrt(homeScoring * awayConceding)));
  const expAwayGoals = Math.max(0.15, Math.min(5, Math.sqrt(awayScoring * homeConceding)));

  const sameLeague = homeForm.league === awayForm.league && homeForm.country === awayForm.country;
  const label = sameLeague
    ? `${homeForm.country} · ${homeForm.league}`
    : `${homeForm.country} · ${homeForm.league} / ${awayForm.country} · ${awayForm.league}`;

  return {
    homeForm,
    awayForm,
    sameLeague,
    league: label,
    expHomeGoals,
    expAwayGoals,
  };
}

/** Diagnostics for the dashboard / health check. */
export function getOnefootballStats(): { searchCacheSize: number; resultsCacheSize: number } {
  return {
    searchCacheSize: searchCache.size,
    resultsCacheSize: resultsCache.size,
  };
}

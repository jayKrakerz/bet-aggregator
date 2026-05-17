/**
 * TheSportsDB cross-reference resolver.
 *
 * Bulk-loads team rosters from TheSportsDB for the 10 leagues their free
 * tier exposes via `search_all_teams.php?l=<league>`. Each team carries
 * cross-source IDs (idESPN, idAPIfootball) plus a comma-separated list
 * of `strTeamAlternate` strings — exactly what we need to fix the "user
 * typed Bayern Munich but the source has FC Bayern München" problem.
 *
 * Coverage on the free tier (key=3):
 *   • English Premier League            (top 10 teams)
 *   • English League Championship       (top 10 teams)
 *   • Scottish Premier League           (top 10 teams)
 *   • German Bundesliga                 (top 10 teams)
 *   • Italian Serie A                   (top 10 teams)
 *   • French Ligue 1                    (top 10 teams)
 *   • Spanish La Liga                   (top 10 teams)
 *   • Greek Superleague Greece          (top 10 teams)
 *   • Dutch Eredivisie                  (top 10 teams)
 *   • Belgian Pro League                (top 10 teams)
 *
 * If THESPORTSDB_KEY is set in env, the Patreon endpoint is used
 * instead, which lifts the per-league cap and unlocks `searchteams.php`.
 *
 * This module does NOT make predictions — it's a metadata layer that
 * lets ou-lookup retry the fallback chain with alternate names when
 * the user's input doesn't match any indexed team.
 */

import { logger } from '../utils/logger.js';

const FETCH_TIMEOUT = 10_000;
const CACHE_TTL = 24 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

function apiKey(): string {
  return (process.env.THESPORTSDB_KEY || '3').trim();
}
function base(): string {
  return `https://www.thesportsdb.com/api/v1/json/${apiKey()}`;
}

const SUPPORTED_LEAGUES = [
  'English Premier League',
  'English League Championship',
  'Scottish Premier League',
  'German Bundesliga',
  'Italian Serie A',
  'French Ligue 1',
  'Spanish La Liga',
  'Greek Superleague Greece',
  'Dutch Eredivisie',
  'Belgian Pro League',
];

// ── Types ────────────────────────────────────────────────

export interface CrossRef {
  /** TheSportsDB's canonical team name. */
  canonicalName: string;
  /** Comma-split alternates from strTeamAlternate, plus the short code. */
  alternateNames: string[];
  country: string;
  league: string;
  sportsDbId: string;
  espnId: string | null;
  apiFootballId: string | null;
}

interface RawTeam {
  idTeam?: string;
  idESPN?: string;
  idAPIfootball?: string;
  strTeam?: string;
  strTeamAlternate?: string;
  strTeamShort?: string;
  strCountry?: string;
  strLeague?: string;
}

interface RawTeamsResp { teams?: RawTeam[] | null }

// ── State ────────────────────────────────────────────────

const nameIndex = new Map<string, CrossRef>(); // normName → CrossRef
let loadedAt = 0;
let loadInflight: Promise<void> | null = null;

function normName(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function buildRef(t: RawTeam): CrossRef | null {
  if (!t.strTeam || !t.idTeam) return null;
  const altRaw = (t.strTeamAlternate || '').split(',').map(s => s.trim()).filter(Boolean);
  const shortCode = (t.strTeamShort || '').trim();
  const alternates = [...new Set([...altRaw, shortCode].filter(s => s && s !== t.strTeam))];
  return {
    canonicalName: t.strTeam,
    alternateNames: alternates,
    country: (t.strCountry || '').trim(),
    league: (t.strLeague || '').trim(),
    sportsDbId: t.idTeam,
    espnId: t.idESPN || null,
    apiFootballId: t.idAPIfootball || null,
  };
}

function indexAdd(ref: CrossRef) {
  // Index by canonical, every alternate, and short code (already in alternates).
  const keys = new Set<string>([normName(ref.canonicalName)]);
  for (const alt of ref.alternateNames) keys.add(normName(alt));
  for (const k of keys) {
    if (!k) continue;
    // First-write wins; canonical entries typically arrive first.
    if (!nameIndex.has(k)) nameIndex.set(k, ref);
  }
}

async function loadIndex(): Promise<void> {
  const results = await Promise.allSettled(
    SUPPORTED_LEAGUES.map(async lg => {
      const url = `${base()}/search_all_teams.php?l=${encodeURIComponent(lg)}`;
      const data = await fetchJson<RawTeamsResp>(url);
      return { league: lg, teams: data?.teams ?? null };
    }),
  );

  let okLeagues = 0;
  let totalTeams = 0;
  nameIndex.clear();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const arr = r.value.teams;
    if (!Array.isArray(arr) || arr.length === 0) continue;
    okLeagues++;
    for (const t of arr) {
      const ref = buildRef(t);
      if (!ref) continue;
      indexAdd(ref);
      totalTeams++;
    }
  }
  loadedAt = Date.now();
  logger.info({ leagues: okLeagues, teams: totalTeams, indexedKeys: nameIndex.size, key: apiKey() === '3' ? 'free-demo' : 'configured' }, 'sportsdb-resolver: index loaded');
}

async function ensureLoaded(): Promise<void> {
  if (nameIndex.size > 0 && Date.now() - loadedAt < CACHE_TTL) return;
  if (loadInflight) { await loadInflight; return; }
  loadInflight = loadIndex().finally(() => { loadInflight = null; });
  await loadInflight;
}

// ── Public API ───────────────────────────────────────────

export async function lookupCrossRef(name: string): Promise<CrossRef | null> {
  await ensureLoaded();
  const target = normName(name);
  if (!target) return null;
  // Exact normalized hit first.
  const exact = nameIndex.get(target);
  if (exact) return exact;
  // Token-subset fuzzy fallback for slight variants ("Bayern Munich" → "Bayern").
  const targetTokens = new Set(target.split(' ').filter(t => t.length >= 3));
  if (targetTokens.size === 0) return null;
  let best: { ref: CrossRef; score: number } | null = null;
  for (const [key, ref] of nameIndex) {
    if (key.includes(target) || target.includes(key)) {
      const shorter = Math.min(key.length, target.length);
      const longer = Math.max(key.length, target.length);
      const score = 60 * (shorter / longer);
      if (score >= 50 && (!best || score > best.score)) best = { ref, score };
      continue;
    }
    const keyTokens = new Set(key.split(' ').filter(t => t.length >= 3));
    if (keyTokens.size === 0) continue;
    let overlap = 0;
    for (const t of targetTokens) if (keyTokens.has(t)) overlap++;
    if (overlap === 0) continue;
    const union = targetTokens.size + keyTokens.size - overlap;
    const score = (overlap / union) * 85;
    if (score >= 55 && (!best || score > best.score)) best = { ref, score };
  }
  return best?.ref ?? null;
}

/**
 * Returns a list of name candidates ordered by quality:
 *   1. canonical name (TheSportsDB's strTeam)
 *   2. each alternate (comma-split strTeamAlternate)
 *   3. short code
 *
 * Always includes the original input as a fallback. Deduped, preserving
 * order. Caller is expected to retry their lookup chain with each
 * candidate when the first one fails.
 */
export async function expandTeamName(input: string): Promise<string[]> {
  const original = (input || '').trim();
  const ref = await lookupCrossRef(input).catch(err => {
    logger.warn({ err, input }, 'sportsdb-resolver: lookup failed');
    return null;
  });
  if (!ref) return [original];
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (s: string) => {
    const t = (s || '').trim();
    if (!t) return;
    const k = normName(t);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  push(ref.canonicalName);
  for (const alt of ref.alternateNames) push(alt);
  push(original);
  return out;
}

export function getCrossRefStats(): { teamsIndexed: number; loadedAtIso: string | null } {
  return {
    teamsIndexed: nameIndex.size,
    loadedAtIso: loadedAt > 0 ? new Date(loadedAt).toISOString() : null,
  };
}

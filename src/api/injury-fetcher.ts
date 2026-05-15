/**
 * Injury / Lineup Fetcher.
 *
 * Two sources, in priority order:
 *   1. FotMob — richer (predicted XI, doubtfuls, ratings). Requires an
 *      X-Mas signature header which FotMob rotates; we read it from the
 *      FOTMOB_XMAS env var. Inactive until that's set, then opportunistic.
 *   2. API-Football — confirmed injuries / suspensions only, but always
 *      works when FOOTBALL_API_KEY is set. Uses the team's current season.
 *
 * Both routes return the same normalized shape. Adjustment math lives in
 * match-predictor — this file only fetches.
 *
 * Each cold lookup costs 1 API-Football call per team (the team search is
 * cached by api-football-form.ts). Cached injuries are reused for 6h since
 * squad availability drifts slowly within a matchweek.
 */

import { logger } from '../utils/logger.js';

const FOTMOB_BASE = 'https://www.fotmob.com/api';
const APIF_BASE = 'https://v3.football.api-sports.io';
const INJURY_TTL_MS = 6 * 60 * 60 * 1000;

export type InjurySource = 'fotmob' | 'api-football' | 'none';

export interface InjuredPlayer {
  name: string;
  position: string | null;
  status: string;      // "Injury", "Suspended", "Doubtful", "Missing", etc.
  reason: string | null;
  /** True when player was a regular starter — drives the lambda adjustment. */
  isKey: boolean;
}

export interface TeamInjuryReport {
  team: string;
  source: InjurySource;
  league: string | null;
  season: number | null;
  injured: InjuredPlayer[];
  /** Number flagged as `isKey` — surfaced separately for fast UI rendering. */
  keyOut: number;
  /** Wall-clock when fetched; UI can show "as of HH:MM". */
  fetchedAt: string;
}

// ── Caches ────────────────────────────────────────────────

const injuryCache = new Map<string, { data: TeamInjuryReport; ts: number }>();

function cacheKey(teamName: string): string {
  return teamName.toLowerCase().trim();
}

// ── FotMob (X-Mas-gated) ──────────────────────────────────

function fotmobXMas(): string | null {
  const v = process.env.FOTMOB_XMAS;
  return v && v.length > 0 ? v : null;
}

async function fotmobSearch(name: string): Promise<number | null> {
  const xmas = fotmobXMas();
  if (!xmas) return null;
  try {
    const url = `${FOTMOB_BASE}/searchapi/suggest?term=${encodeURIComponent(name)}`;
    const res = await fetch(url, {
      headers: { 'X-Mas': xmas, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { suggestions?: Array<{ type?: string; payload?: { id?: number }; options?: Array<{ payload?: { id?: number }; type?: string }> }> };
    const groups = json.suggestions ?? [];
    for (const g of groups) {
      if (g.type === 'teams' && Array.isArray(g.options)) {
        const first = g.options[0];
        if (first?.payload?.id) return first.payload.id;
      }
      if (g.payload?.id) return g.payload.id;
    }
    return null;
  } catch {
    return null;
  }
}

async function fotmobInjuries(teamId: number): Promise<{ injured: InjuredPlayer[]; league: string | null } | null> {
  const xmas = fotmobXMas();
  if (!xmas) return null;
  try {
    const url = `${FOTMOB_BASE}/teams?id=${teamId}`;
    const res = await fetch(url, {
      headers: { 'X-Mas': xmas, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { details?: { name?: string; primaryLeagueName?: string }; squad?: { injured?: unknown[]; suspended?: unknown[] }; overview?: { injuries?: unknown[] } };
    const raw: Array<Record<string, unknown>> = [];
    if (Array.isArray(json.squad?.injured)) raw.push(...(json.squad!.injured as Array<Record<string, unknown>>));
    if (Array.isArray(json.squad?.suspended)) raw.push(...(json.squad!.suspended as Array<Record<string, unknown>>));
    if (Array.isArray(json.overview?.injuries)) raw.push(...(json.overview!.injuries as Array<Record<string, unknown>>));
    const injured: InjuredPlayer[] = raw.map(p => ({
      name: String(p['name'] ?? p['playerName'] ?? 'Unknown'),
      position: typeof p['position'] === 'string' ? (p['position'] as string) : (typeof p['positionDescription'] === 'string' ? (p['positionDescription'] as string) : null),
      status: typeof p['status'] === 'string' ? (p['status'] as string) : 'Injury',
      reason: typeof p['reason'] === 'string' ? (p['reason'] as string) : null,
      isKey: p['isKey'] === true || p['important'] === true || isAttackerPosition(typeof p['position'] === 'string' ? (p['position'] as string) : null),
    }));
    return { injured, league: typeof json.details?.primaryLeagueName === 'string' ? json.details.primaryLeagueName : null };
  } catch {
    return null;
  }
}

// ── API-Football (always works when FOOTBALL_API_KEY is set) ──

interface ApifInjury {
  player: { id: number; name: string; type?: string; reason?: string };
  team: { id: number; name: string };
  fixture?: { id: number; date: string };
  league: { id: number; season: number; name: string };
}

interface ApifTeamSearchResult {
  team: { id: number; name: string; country: string };
}

function apiKey(): string | null {
  return process.env.FOOTBALL_API_KEY || null;
}

async function apifFetch<T>(path: string): Promise<T | null> {
  const key = apiKey();
  if (!key) return null;
  const attempts: Array<{ url: string; headers: Record<string, string> }> = [
    { url: `${APIF_BASE}${path}`, headers: { 'x-apisports-key': key } },
    { url: `https://api-football-v1.p.rapidapi.com/v3${path}`, headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'api-football-v1.p.rapidapi.com' } },
  ];
  for (const a of attempts) {
    try {
      const res = await fetch(a.url, { headers: a.headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const json = (await res.json()) as { response?: T; errors?: unknown };
      if (json.response) return json.response;
    } catch {
      continue;
    }
  }
  return null;
}

async function apifSearchTeam(name: string): Promise<number | null> {
  const res = await apifFetch<ApifTeamSearchResult[]>(`/teams?search=${encodeURIComponent(name)}`);
  const first = res?.[0];
  if (!first) return null;
  return first.team.id;
}

async function apifInjuries(teamId: number): Promise<{ injured: InjuredPlayer[]; league: string | null; season: number | null } | null> {
  const season = new Date().getUTCFullYear();
  // Try current season first, then previous (covers the Aug–May Europe split).
  for (const s of [season, season - 1]) {
    const res = await apifFetch<ApifInjury[]>(`/injuries?team=${teamId}&season=${s}`);
    const first = res?.[0];
    if (!res || !first || res.length === 0) continue;
    const injured: InjuredPlayer[] = res.map(i => ({
      name: i.player.name,
      position: null,
      status: i.player.type ?? 'Injury',
      reason: i.player.reason ?? null,
      isKey: false, // API-Football doesn't expose starter status; heuristic kicks in downstream
    }));
    return { injured, league: first.league.name, season: s };
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────

function isAttackerPosition(pos: string | null): boolean {
  if (!pos) return false;
  const p = pos.toLowerCase();
  return p.includes('forward') || p.includes('striker') || p.includes('winger') || p.startsWith('att') || p === 'fw' || p === 'st' || p === 'lw' || p === 'rw';
}

// Mark obvious starters as "key": at most the top-3 injuries on a team are
// flagged when source has no starter signal. Cheap heuristic for the
// adjustment math — better than blanket-flagging everyone.
function applyKeyHeuristic(injured: InjuredPlayer[]): void {
  let flagged = 0;
  for (const p of injured) {
    if (p.isKey) { flagged++; continue; }
    if (flagged >= 3) break;
    // First few injured players from a team are usually their best — the
    // tail is back-up squad players or youth-side absences.
    p.isKey = true;
    flagged++;
  }
}

// ── Public API ────────────────────────────────────────────

export async function getInjuryReport(teamName: string): Promise<TeamInjuryReport> {
  const k = cacheKey(teamName);
  const cached = injuryCache.get(k);
  if (cached && Date.now() - cached.ts < INJURY_TTL_MS) return cached.data;

  // FotMob first — only fires when FOTMOB_XMAS is set.
  if (fotmobXMas()) {
    try {
      const fmId = await fotmobSearch(teamName);
      if (fmId) {
        const fm = await fotmobInjuries(fmId);
        if (fm && fm.injured.length > 0) {
          const report: TeamInjuryReport = {
            team: teamName,
            source: 'fotmob',
            league: fm.league,
            season: null,
            injured: fm.injured,
            keyOut: fm.injured.filter(p => p.isKey).length,
            fetchedAt: new Date().toISOString(),
          };
          injuryCache.set(k, { data: report, ts: Date.now() });
          return report;
        }
      }
    } catch (err) {
      logger.warn({ err, team: teamName }, 'FotMob injury lookup failed');
    }
  }

  // API-Football fallback.
  if (apiKey()) {
    try {
      const apifId = await apifSearchTeam(teamName);
      if (apifId) {
        const af = await apifInjuries(apifId);
        if (af && af.injured.length > 0) {
          applyKeyHeuristic(af.injured);
          const report: TeamInjuryReport = {
            team: teamName,
            source: 'api-football',
            league: af.league,
            season: af.season,
            injured: af.injured,
            keyOut: af.injured.filter(p => p.isKey).length,
            fetchedAt: new Date().toISOString(),
          };
          injuryCache.set(k, { data: report, ts: Date.now() });
          return report;
        }
      }
    } catch (err) {
      logger.warn({ err, team: teamName }, 'API-Football injury lookup failed');
    }
  }

  // No source returned anything — empty report.
  const empty: TeamInjuryReport = {
    team: teamName,
    source: 'none',
    league: null,
    season: null,
    injured: [],
    keyOut: 0,
    fetchedAt: new Date().toISOString(),
  };
  injuryCache.set(k, { data: empty, ts: Date.now() });
  return empty;
}

export function hasInjurySource(): boolean {
  return !!(fotmobXMas() || apiKey());
}

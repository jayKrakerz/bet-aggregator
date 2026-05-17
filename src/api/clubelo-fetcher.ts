/**
 * ClubElo fetcher — third-party Elo ratings for European clubs.
 *
 * api.clubelo.com is a public CSV endpoint maintained by the ClubElo
 * project. Returns the world rating list as of a given date:
 *
 *   GET http://api.clubelo.com/YYYY-MM-DD
 *
 * Response (CSV, ~35KB, ~630 European clubs):
 *
 *   Rank,Club,Country,Level,Elo,From,To
 *   1,Arsenal,ENG,1,2059.5688,2026-05-11,2026-05-18
 *   2,Bayern,GER,1,2001.6707,2026-05-17,2026-05-30
 *   ...
 *
 * Use cases:
 *   - Sanity-check our internal Elo (elo-predictor.ts) against a battle-
 *     tested public model.
 *   - Provide a starting Elo for teams the internal predictor has seen
 *     too few matches of to be confident.
 *   - Surface a "third-party Elo" line in the 1X2 model-comparison UI.
 *
 * Cache: 12h (Elo doesn't move fast; a single fetch covers all clubs).
 */

import { logger } from '../utils/logger.js';

const BASE = 'http://api.clubelo.com';
const CACHE_TTL = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT = 10_000;

export interface ClubEloEntry {
  rank: number;
  club: string;
  /** 3-letter country code (ENG, GER, ESP, …). */
  country: string;
  /** Domestic tier (1 = top flight, 2 = second tier, …). */
  level: number;
  elo: number;
  from: string;            // ISO date
  to: string;              // ISO date
}

interface Snapshot {
  fetchedAt: number;
  byKey: Map<string, ClubEloEntry>;  // normalised name → entry
  entries: ClubEloEntry[];           // ranked list
}

let snapshot: Snapshot | null = null;
let inflight: Promise<Snapshot | null> | null = null;

function normName(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseCsv(text: string): ClubEloEntry[] {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  // Header is fixed: Rank,Club,Country,Level,Elo,From,To.
  const out: ClubEloEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(',');
    if (cols.length < 7) continue;
    const rank = parseInt(cols[0]!, 10);
    const elo = parseFloat(cols[4]!);
    const level = parseInt(cols[3]!, 10);
    if (!Number.isFinite(elo)) continue;
    out.push({
      rank: Number.isFinite(rank) ? rank : 0,
      club: cols[1]!.trim(),
      country: cols[2]!.trim(),
      level: Number.isFinite(level) ? level : 0,
      elo,
      from: cols[5]!.trim(),
      to: cols[6]!.trim(),
    });
  }
  return out;
}

async function fetchSnapshot(): Promise<Snapshot | null> {
  if (snapshot && Date.now() - snapshot.fetchedAt < CACHE_TTL) return snapshot;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const url = `${BASE}/${todayUTC()}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      if (!res.ok) {
        logger.warn({ status: res.status }, 'clubelo: fetch non-200');
        return null;
      }
      const text = await res.text();
      const entries = parseCsv(text);
      if (entries.length === 0) return null;
      const byKey = new Map<string, ClubEloEntry>();
      for (const e of entries) {
        const key = normName(e.club);
        if (key && !byKey.has(key)) byKey.set(key, e);
      }
      const snap: Snapshot = { fetchedAt: Date.now(), byKey, entries };
      snapshot = snap;
      logger.info({ clubs: entries.length }, 'clubelo: snapshot loaded');
      return snap;
    } catch (err) {
      logger.warn({ err }, 'clubelo: fetch failed');
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// ── Public lookup ────────────────────────────────────────

const NAME_ALIASES: Record<string, string> = {
  // common predictor-input → ClubElo canonical names
  'manchester city': 'Man City',
  'man city': 'Man City',
  'manchester united': 'Man United',
  'manchester utd': 'Man United',
  'man utd': 'Man United',
  'man united': 'Man United',
  'tottenham hotspur': 'Tottenham',
  'spurs': 'Tottenham',
  'newcastle united': 'Newcastle',
  'paris saint-germain': 'Paris SG',
  'paris saint germain': 'Paris SG',
  'psg': 'Paris SG',
  'bayern munich': 'Bayern',
  'fc bayern': 'Bayern',
  'fc bayern munich': 'Bayern',
  'borussia dortmund': 'Dortmund',
  'borussia monchengladbach': 'Gladbach',
  "borussia m'gladbach": 'Gladbach',
  'bayer leverkusen': 'Leverkusen',
  'inter milan': 'Inter',
  'internazionale': 'Inter',
  'ac milan': 'Milan',
  'as roma': 'Roma',
  'ss lazio': 'Lazio',
  'real madrid': 'Real Madrid',
  'fc barcelona': 'Barcelona',
  'atletico madrid': 'Atlético',
  'athletico madrid': 'Atlético',
  'atletico de madrid': 'Atlético',
  'real sociedad': 'Sociedad',
  'athletic bilbao': 'Athletic',
  'real betis': 'Betis',
  'celta vigo': 'Celta',
  'fc porto': 'Porto',
  'sl benfica': 'Benfica',
  'sporting cp': 'Sporting',
  'sporting lisbon': 'Sporting',
};

function lookupKey(name: string): string[] {
  const raw = (name || '').toLowerCase().trim();
  const candidates: string[] = [];
  if (NAME_ALIASES[raw]) candidates.push(normName(NAME_ALIASES[raw]));
  candidates.push(normName(name));
  return candidates;
}

function fuzzyLookup(name: string, snap: Snapshot): ClubEloEntry | null {
  for (const k of lookupKey(name)) {
    const hit = snap.byKey.get(k);
    if (hit) return hit;
  }
  // Token-subset fuzzy fallback — e.g. "Borussia Mönchengladbach" → "Gladbach"
  const target = normName(name);
  if (!target) return null;
  const targetTokens = new Set(target.split(' ').filter(t => t.length >= 3));
  let best: { entry: ClubEloEntry; score: number } | null = null;
  for (const [key, entry] of snap.byKey) {
    if (key.includes(target) || target.includes(key)) {
      const shorter = Math.min(key.length, target.length);
      const longer = Math.max(key.length, target.length);
      const score = 60 * (shorter / longer);
      if (score >= 50 && (!best || score > best.score)) best = { entry, score };
      continue;
    }
    const keyTokens = new Set(key.split(' ').filter(t => t.length >= 3));
    if (targetTokens.size === 0 || keyTokens.size === 0) continue;
    let overlap = 0;
    for (const t of targetTokens) if (keyTokens.has(t)) overlap++;
    if (overlap === 0) continue;
    const union = targetTokens.size + keyTokens.size - overlap;
    const score = (overlap / union) * 90;
    if (score >= 55 && (!best || score > best.score)) best = { entry, score };
  }
  return best?.entry ?? null;
}

export async function lookupClubElo(name: string): Promise<ClubEloEntry | null> {
  const snap = await fetchSnapshot();
  if (!snap) return null;
  return fuzzyLookup(name, snap);
}

/**
 * 1X2 probabilities from two ClubElo ratings using the standard
 * Elo-to-prob formula with a home advantage of 65 (ClubElo's own value).
 *
 * Draw-rate model: football draws are higher than Elo's two-way logistic
 * predicts. Empirical European-league draw rates by absolute rating gap:
 *
 *   gap=0    → ~30%        (equal teams)
 *   gap=200  → ~24%
 *   gap=400  → ~17%
 *   gap=600+ → ~12%
 *
 * Fit: linear decay 0.30 − 0.00035 · |gap|, clamped to [0.10, 0.32].
 */
export function probFromClubElo(homeElo: number, awayElo: number): { homeWinPct: number; drawPct: number; awayWinPct: number } {
  const HFA = 65;
  const diff = (homeElo + HFA) - awayElo;
  const expHome = 1 / (1 + Math.pow(10, -diff / 400));
  const drawRaw = Math.max(0.10, Math.min(0.32, 0.30 - 0.00035 * Math.abs(diff)));
  const homeWin = expHome * (1 - drawRaw);
  const awayWin = (1 - expHome) * (1 - drawRaw);
  const round = (x: number) => Math.round(x * 1000) / 10;
  return {
    homeWinPct: round(homeWin),
    drawPct: round(drawRaw),
    awayWinPct: round(awayWin),
  };
}

export async function clubEloPrediction(home: string, away: string): Promise<{
  home: ClubEloEntry;
  away: ClubEloEntry;
  homeWinPct: number;
  drawPct: number;
  awayWinPct: number;
} | null> {
  const snap = await fetchSnapshot();
  if (!snap) return null;
  const h = fuzzyLookup(home, snap);
  const a = fuzzyLookup(away, snap);
  if (!h || !a) return null;
  const probs = probFromClubElo(h.elo, a.elo);
  return { home: h, away: a, ...probs };
}

export function getClubEloStats(): { clubsCached: number; loadedAtIso: string | null } {
  return {
    clubsCached: snapshot ? snapshot.byKey.size : 0,
    loadedAtIso: snapshot ? new Date(snapshot.fetchedAt).toISOString() : null,
  };
}

/**
 * Pinnacle real-esports fetcher.
 *
 * Pinnacle is the sharpest market (~2% margin, accepts sharps without limiting).
 * Their de-vigged moneyline probabilities are as accurate as any model we
 * could train, with no scraper to maintain. We surface their lines for CS2,
 * LoL, Dota 2, Valorant, and FIFAe (when in season) so the user can:
 *   1. See the fair-value probability for each upcoming match
 *   2. Line-shop the same match at 22bet — bet wherever offers ≥ Fair odds
 *
 * Data flow:
 *   /sports/12/matchups            → all active esports leagues
 *   filter by league name keyword  → group into our 5 supported games
 *   /leagues/{id}/matchups         → matchup list per league
 *   /leagues/{id}/markets/straight → moneyline odds per matchup
 *
 * Source: guest.api.arcadia.pinnacle.com (no API key needed; the X-API-Key
 * header value is the public guest token used by pinnacle.com itself).
 */

import { logger } from '../utils/logger.js';

const BASE = 'https://guest.api.arcadia.pinnacle.com/0.1';
const SPORT_ID_ESPORTS = 12;
const CACHE_TTL = 10 * 60 * 1000; // 10 min — esports odds move fast in tournaments
const REQUEST_TIMEOUT = 10_000;

const HEADERS = {
  Accept: 'application/json',
  // Public guest token — the same value pinnacle.com itself sends.
  'X-API-Key': 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R',
  Referer: 'https://www.pinnacle.com/',
  Origin: 'https://www.pinnacle.com',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

// ── Types ────────────────────────────────────────────────

export type EsportsGame = 'cs2' | 'lol' | 'dota2' | 'valorant' | 'fifae' | 'cod' | 'mobilelegends' | 'rainbow6' | 'starcraft';

export interface EsportsMatch {
  matchupId: number;
  game: EsportsGame;
  leagueId: number;
  leagueName: string;
  startTime: string;
  homeTeam: string;
  awayTeam: string;
  decimalHome: number;
  decimalAway: number;
  impliedHome: number;       // de-vigged probability (0-1)
  impliedAway: number;
  margin: number;            // overround = (1/decH + 1/decA) - 1
}

export interface EsportsResult {
  matches: EsportsMatch[];
  byGame: Record<EsportsGame, number>;
  totalMatches: number;
  scrapedAt: string;
  source: 'pinnacle';
}

// ── Game classification ──────────────────────────────────
// Pinnacle prefixes leagues like "CS2 - BLAST Rivals", "League of Legends -
// LCK CL", "Dota 2 - DreamLeague", etc. We match the prefix to our enum.

const GAME_PATTERNS: Array<{ game: EsportsGame; rx: RegExp }> = [
  { game: 'cs2', rx: /^(CS2|CS|Counter[-\s]?Strike)\b/i },
  { game: 'lol', rx: /^(LoL|League of Legends)\b/i },
  { game: 'dota2', rx: /^(Dota[\s-]?2|DotA)\b/i },
  { game: 'valorant', rx: /^Valorant\b/i },
  // FIFAe / EA FC variants — peak season May–Aug + Nov–Mar
  { game: 'fifae', rx: /^(FIFA(e)?|EA Sports FC|EA FC|VBL|Virtual Bundesliga|eChampions League|FC World Championship|FIFA World)\b/i },
  { game: 'cod', rx: /^(Call of Duty|CoD)\b/i },
  { game: 'mobilelegends', rx: /^Mobile Legends\b/i },
  { game: 'rainbow6', rx: /^(Rainbow 6|Rainbow Six|R6)\b/i },
  { game: 'starcraft', rx: /^StarCraft\b/i },
];

function classifyLeague(name: string): EsportsGame | null {
  const t = name.trim();
  for (const { game, rx } of GAME_PATTERNS) if (rx.test(t)) return game;
  return null;
}

// ── Cache ────────────────────────────────────────────────

let cache: { matches: EsportsMatch[]; ts: number } | null = null;

// ── Helpers ──────────────────────────────────────────────

interface RawMatchup {
  id: number;
  type: string;
  parentId?: number | null;
  special?: boolean;
  participants?: Array<{ name: string; alignment?: string }>;
  startTime?: string;
  league?: { id: number; name: string };
}

interface RawMarket {
  matchupId: number;
  type: string;
  period: number;
  isAlternate?: boolean;
  prices?: Array<{ designation?: string; price: number }>;
}

async function pf<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ err, path }, 'pinnacle-esports fetch error');
    return null;
  }
}

function americanToDecimal(american: number): number {
  if (american > 0) return american / 100 + 1;
  return -100 / american + 1;
}

// ── Public API ───────────────────────────────────────────

export async function getEsportsMatches(forceRefresh = false): Promise<EsportsResult> {
  if (!forceRefresh && cache && Date.now() - cache.ts < CACHE_TTL) {
    return summarize(cache.matches);
  }

  // Pull every active esports matchup; identify which leagues map to a
  // supported game; fetch matchups + moneyline markets per league in parallel.
  const all = await pf<RawMatchup[]>(`/sports/${SPORT_ID_ESPORTS}/matchups?withSpecials=false&brandId=0`);
  if (!all) {
    cache = { matches: [], ts: Date.now() };
    return summarize([]);
  }

  // leagueId → { name, game }
  const supportedLeagues = new Map<number, { name: string; game: EsportsGame }>();
  for (const m of all) {
    const l = m.league;
    if (!l) continue;
    if (supportedLeagues.has(l.id)) continue;
    const game = classifyLeague(l.name);
    if (!game) continue;
    supportedLeagues.set(l.id, { name: l.name, game });
  }

  const perLeague = await Promise.all(
    [...supportedLeagues.entries()].map(async ([leagueId, info]) => {
      const [matchups, markets] = await Promise.all([
        pf<RawMatchup[]>(`/leagues/${leagueId}/matchups`),
        pf<RawMarket[]>(`/leagues/${leagueId}/markets/straight`),
      ]);
      if (!matchups || !markets) return [] as EsportsMatch[];

      // Top-level real matchup, drop specials and per-map / per-period sub-matchups.
      const eligible = matchups.filter(
        (m) => m.type === 'matchup' && !m.special && (m.parentId === null || m.parentId === undefined),
      );
      const moneylines = new Map<number, RawMarket>();
      for (const mk of markets) {
        if (mk.type !== 'moneyline' || mk.period !== 0 || mk.isAlternate) continue;
        moneylines.set(mk.matchupId, mk);
      }

      const out: EsportsMatch[] = [];
      for (const m of eligible) {
        const ml = moneylines.get(m.id);
        if (!ml || !ml.prices) continue;
        const home = ml.prices.find((p) => p.designation === 'home');
        const away = ml.prices.find((p) => p.designation === 'away');
        if (!home || !away) continue;
        const homeName = m.participants?.find((p) => p.alignment === 'home')?.name ?? m.participants?.[0]?.name;
        const awayName = m.participants?.find((p) => p.alignment === 'away')?.name ?? m.participants?.[1]?.name;
        if (!homeName || !awayName) continue;
        const dH = americanToDecimal(home.price);
        const dA = americanToDecimal(away.price);
        const sumImplied = 1 / dH + 1 / dA;
        out.push({
          matchupId: m.id,
          game: info.game,
          leagueId,
          leagueName: info.name,
          startTime: m.startTime ?? '',
          homeTeam: homeName,
          awayTeam: awayName,
          decimalHome: dH,
          decimalAway: dA,
          impliedHome: 1 / dH / sumImplied,
          impliedAway: 1 / dA / sumImplied,
          margin: sumImplied - 1,
        });
      }
      return out;
    }),
  );

  const matches = perLeague.flat().sort((a, b) => a.startTime.localeCompare(b.startTime));
  cache = { matches, ts: Date.now() };
  logger.info({ leagues: supportedLeagues.size, matches: matches.length }, 'pinnacle-esports refreshed');
  return summarize(matches);
}

function summarize(matches: EsportsMatch[]): EsportsResult {
  const byGame: Record<EsportsGame, number> = {
    cs2: 0, lol: 0, dota2: 0, valorant: 0, fifae: 0, cod: 0, mobilelegends: 0, rainbow6: 0, starcraft: 0,
  };
  for (const m of matches) byGame[m.game]++;
  return {
    matches,
    byGame,
    totalMatches: matches.length,
    scrapedAt: new Date().toISOString(),
    source: 'pinnacle',
  };
}

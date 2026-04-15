/**
 * Oddspedia Dropping Odds Client
 *
 * Hits oddspedia.com/api/v1/getDroppingOdds via the warmed browser
 * session. "Dropping odds" = lines that have moved sharply across
 * one or more bookmakers. Sustained drops = sharp money on that side.
 *
 * Each entry is one (match × market × outcome) row. We:
 *   - keep the raw shape internally for arbitrage scanning
 *   - expose a normalized DropSignal[] grouped per match for
 *     downstream consumers (live-predictor, /predictions/dropping-odds)
 */

import { fetchOddspediaJson } from './oddspedia-browser.js';
import { withScraperHealth } from './scraper-health.js';
import { logger } from '../utils/logger.js';

// ── Raw API types (subset of what the endpoint returns) ──

interface RawOddsBookie {
  bid: number;
  name: string;
  slug: string;
  current: string;
  link?: string;
}

interface RawOddsOutcome {
  type: string;          // "Home" | "Draw" | "Away" | "Over" | "Under" | "Yes" | "No" | ...
  current: string;       // current best/median odds
  maxCurrentBid: number;
  maxCurrentBidOdd: string;
  maxBidLink?: string;
  allOdds: RawOddsBookie[];
}

interface RawDroppingOdd {
  id: number;            // Oddspedia match id
  md: string;            // match start datetime UTC
  sport_id: number;
  sport_name: string;
  category_name: string; // country
  league_name: string;
  ht: string;            // home team
  at: string;            // away team
  ot_name: string;       // "Full Time Result 3 Way" etc.
  group_name: string;    // "1X2" | "Over/Under" | "Both Teams to Score" | ...
  title: string;         // "Full Time" | "1st Half" | ...
  handicap: string | null;
  oddNumberDrop: string; // "o1" | "o2" | "o3" — which side is dropping
  maxDrop: number;       // % drop (integer, e.g. 52 = 52%)
  last_change: string;
  maxCurrentAllBids: string; // peak odds across books for this side
  odds: RawOddsOutcome[];
  deep_url?: string;
  bookiesWithDrop?: number;
}

interface RawResponse {
  data: RawDroppingOdd[];
  matches_count?: number;
  total_pages?: number;
  current_page?: number;
  generated_at?: string;
}

// ── Public types ──

export type DropSide = 'home' | 'draw' | 'away' | 'over' | 'under' | 'btts_yes' | 'btts_no' | 'other';

export interface DropSignal {
  market: string;          // e.g. "1X2 Full Time", "Over/Under 2.5"
  side: DropSide;
  sideLabel: string;       // raw outcome label ("Home", "Over", ...)
  currentOdds: number;     // best/median current
  peakOdds: number;        // highest historical odds across books
  dropPct: number;         // 0-100, derived from maxDrop
  bookiesWithDrop: number;
  lastChange: string;      // ISO-ish
}

export interface DroppingOddsMatch {
  oddspediaId: number;
  startTime: string;       // ISO UTC
  sport: string;
  league: string;
  country: string;
  home: string;
  away: string;
  signals: DropSignal[];
  topDropPct: number;      // max dropPct across signals (sorting key)
  deepUrl: string | null;
}

export interface DroppingOddsResult {
  matches: DroppingOddsMatch[];
  totalSignals: number;
  fetchedAt: string;
  source: 'oddspedia';
}

// ── Cache ──

let cache: DroppingOddsResult | null = null;
let cacheTime = 0;
const CACHE_TTL = 90 * 1000; // 90s — auto-refresh fast enough for live use

// ── Mapping ──

function mapSide(oddNumberDrop: string, label: string, group: string): DropSide {
  const l = label.toLowerCase();
  const g = group.toLowerCase();
  if (g.includes('1x2') || g.includes('result')) {
    if (oddNumberDrop === 'o1' || l === 'home') return 'home';
    if (oddNumberDrop === 'o2' || l === 'draw') return 'draw';
    if (oddNumberDrop === 'o3' || l === 'away') return 'away';
  }
  if (g.includes('over') || g.includes('under') || g.includes('total')) {
    if (l.includes('over')) return 'over';
    if (l.includes('under')) return 'under';
  }
  if (g.includes('both teams') || g.includes('btts')) {
    if (l.includes('yes')) return 'btts_yes';
    if (l.includes('no')) return 'btts_no';
  }
  return 'other';
}

function findOutcomeForDrop(raw: RawDroppingOdd): RawOddsOutcome | null {
  // The dropping side label is encoded in oddNumberDrop ("o1"/"o2"/"o3").
  // Map to the outcomes array by index since order is stable.
  const idx = parseInt(raw.oddNumberDrop?.replace(/^o/, '') || '0', 10) - 1;
  if (idx >= 0 && raw.odds[idx]) return raw.odds[idx];
  return raw.odds[0] ?? null;
}

function buildSignal(raw: RawDroppingOdd): DropSignal | null {
  const outcome = findOutcomeForDrop(raw);
  if (!outcome) return null;
  const current = parseFloat(outcome.current || '0');
  const peak = parseFloat(raw.maxCurrentAllBids || outcome.maxCurrentBidOdd || '0');
  if (!current || !peak) return null;

  const market = raw.handicap
    ? `${raw.group_name} ${raw.handicap} (${raw.title})`
    : `${raw.group_name} (${raw.title})`;

  return {
    market,
    side: mapSide(raw.oddNumberDrop, outcome.type, raw.group_name),
    sideLabel: outcome.type,
    currentOdds: current,
    peakOdds: peak,
    dropPct: Math.round(raw.maxDrop * 10) / 10,
    bookiesWithDrop: raw.bookiesWithDrop ?? 0,
    lastChange: raw.last_change,
  };
}

// ── Public API ──

export interface FetchOptions {
  sport?: 'football' | 'basketball' | 'tennis' | 'all';
  minDropPct?: number;     // default 10
  perPage?: number;        // default 100, max 100
  period?: '1hour' | '6hours' | '1day' | '3days';
}

const SPORT_ID: Record<string, string> = {
  football: '1',
  basketball: '2',
  tennis: '5',
  all: '',
};

async function fetchPage(opts: Required<FetchOptions>, pageNum: number): Promise<RawResponse> {
  const params = new URLSearchParams({
    markets: '',
    dropPercentage: `${opts.minDropPct.toFixed(2)},100.00`,
    dropDuringPeriod: opts.period,
    geoCode: '',
    geoState: '',
    sports: SPORT_ID[opts.sport] ?? '',
    bookmakers: '',
    wettsteuer: '0',
    sort: 'drop',
    page: String(pageNum),
    perPage: String(opts.perPage),
    language: 'en',
  });
  return fetchOddspediaJson<RawResponse>(`https://oddspedia.com/api/v1/getDroppingOdds?${params}`);
}

export async function getDroppingOdds(opts: FetchOptions = {}): Promise<DroppingOddsResult> {
  if (cache && Date.now() - cacheTime < CACHE_TTL) return cache;

  const filled: Required<FetchOptions> = {
    sport: opts.sport ?? 'football',
    minDropPct: opts.minDropPct ?? 10,
    perPage: Math.min(opts.perPage ?? 100, 100),
    period: opts.period ?? '1day',
  };

  const result = await withScraperHealth(
    'oddspedia-dropping-odds',
    async () => {
      const first = await fetchPage(filled, 1);
      const allRaw: RawDroppingOdd[] = [...(first.data || [])];
      const totalPages = Math.min(first.total_pages || 1, 3); // cap at 3 pages
      for (let p = 2; p <= totalPages; p++) {
        try {
          const next = await fetchPage(filled, p);
          allRaw.push(...(next.data || []));
        } catch (err) {
          logger.warn({ err, page: p }, 'Oddspedia: page fetch failed');
          break;
        }
      }

      // Group by match id
      const byMatch = new Map<number, DroppingOddsMatch>();
      for (const raw of allRaw) {
        const sig = buildSignal(raw);
        if (!sig) continue;
        const existing = byMatch.get(raw.id);
        if (existing) {
          existing.signals.push(sig);
          existing.topDropPct = Math.max(existing.topDropPct, sig.dropPct);
        } else {
          byMatch.set(raw.id, {
            oddspediaId: raw.id,
            startTime: raw.md,
            sport: raw.sport_name,
            league: raw.league_name,
            country: raw.category_name,
            home: raw.ht,
            away: raw.at,
            signals: [sig],
            topDropPct: sig.dropPct,
            deepUrl: raw.deep_url ?? null,
          });
        }
      }

      const matches = Array.from(byMatch.values()).sort((a, b) => b.topDropPct - a.topDropPct);
      const totalSignals = matches.reduce((s, m) => s + m.signals.length, 0);

      logger.info(
        { matches: matches.length, signals: totalSignals, sport: filled.sport },
        'Oddspedia: dropping odds scraped',
      );

      return {
        matches,
        totalSignals,
        fetchedAt: new Date().toISOString(),
        source: 'oddspedia' as const,
      };
    },
    (r) => r.matches.length,
  );

  cache = result;
  cacheTime = Date.now();
  return result;
}

// ── Match lookup (for live-predictor wiring) ──

function normTeam(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(fc|cf|sc|afc|ac|club|deportivo|cd|u\d{1,2})\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Find a dropping-odds entry matching a (home, away) pair from another
 * data source. Uses normalized fuzzy match.
 */
export function findDropForMatch(
  result: DroppingOddsResult,
  home: string,
  away: string,
): DroppingOddsMatch | null {
  const h = normTeam(home);
  const a = normTeam(away);
  if (!h || !a) return null;
  for (const m of result.matches) {
    const mh = normTeam(m.home);
    const ma = normTeam(m.away);
    if ((mh.includes(h) || h.includes(mh)) && (ma.includes(a) || a.includes(ma))) {
      return m;
    }
  }
  return null;
}

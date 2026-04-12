/**
 * Sports-AI.dev Scraper
 *
 * Scrapes predictions and value bets from sports-ai.dev by parsing
 * the __NEXT_DATA__ JSON embedded in their Next.js pages.
 *
 * Three data sources:
 *   1. /predictions   — AI match predictions with moneyline, handicap, totals odds
 *   2. /value-bets    — value bets where bookmaker odds exceed true probability
 *   3. /betting-bot/results — historical bot performance (simulated bets)
 */

import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';
import { withScraperHealth } from './scraper-health.js';

// ── Types ────────────────────────────────────────────────────

export interface SportsAiPrediction {
  sport_id: string;
  league: string;
  home: string;
  away: string;
  date: number; // unix timestamp
  scrape_time: number;
  odds_moneyline: { home: number; away: number; draw?: number };
  odds_handicap: Array<{
    line: string;
    hdp: number;
    home: number;
    away: number;
    max: number;
  }>;
  odds_totals: Array<{
    line: string;
    points: number;
    over: number;
    under: number;
    max: number;
  }>;
  // Derived fields we add
  implied_home_pct: number;
  implied_away_pct: number;
  implied_draw_pct: number | null;
}

export interface SportsAiHighlight {
  id: string;
  league: string;
  home: string;
  away: string;
  date: number;
  sport_id: string;
  odds_moneyline: { home: number; away: number; draw?: number };
}

export interface SportsAiValueBet {
  _id: string;
  home: string;
  away: string;
  league: string;
  sport: string;
  country: string;
  market: string;
  outcome: string;
  trueOdds: number;
  valuePct: number;
  timeLeft: number;
  date: number;
  bookmakers: Array<{
    name: string;
    link: string;
    price: number;
    percentageDifference: number;
  }>;
}

export interface SportsAiBotResult {
  league: string;
  match: string;
  outcome: string;
  stake: number;
  bookie: string;
  odds: number;
  trueOdd: number;
  profit: number;
  roi: number;
  date: string;
}

export interface SportsAiData {
  predictions: SportsAiPrediction[];
  highlights: SportsAiHighlight[];
  valueBets: SportsAiValueBet[];
  botResults: SportsAiBotResult[];
  fetchedAt: string;
}

// ── Cache ────────────────────────────────────────────────────

let cache: SportsAiData | null = null;
let cacheTime = 0;
const CACHE_TTL = 15 * 60 * 1000;

let botResultsCache: SportsAiBotResult[] | null = null;
let botResultsCacheTime = 0;
const BOT_CACHE_TTL = 60 * 60 * 1000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
};

// ── Helpers ──────────────────────────────────────────────────

function extractNextData(html: string): Record<string, unknown> | null {
  const $ = cheerio.load(html);
  const script = $('#__NEXT_DATA__').html();
  if (!script) return null;
  try {
    return JSON.parse(script) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function oddsToImpliedPct(odds: number): number {
  if (odds <= 1) return 100;
  return Math.round((1 / odds) * 10000) / 100;
}

// ── Scrapers ─────────────────────────────────────────────────

async function scrapePredictions(): Promise<{ predictions: SportsAiPrediction[]; highlights: SportsAiHighlight[] }> {
  try {
    const res = await fetch('https://www.sports-ai.dev/predictions', {
      headers: HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { predictions: [], highlights: [] };

    const html = await res.text();
    const nextData = extractNextData(html);
    if (!nextData) return { predictions: [], highlights: [] };

    const pageProps = (nextData as { props?: { pageProps?: Record<string, unknown> } })
      ?.props?.pageProps;
    if (!pageProps) return { predictions: [], highlights: [] };

    const rawData = (pageProps.data || []) as Array<Record<string, unknown>>;
    const rawHighlights = (pageProps.highlights || []) as Array<Record<string, unknown>>;

    const predictions: SportsAiPrediction[] = rawData.map(item => {
      const ml = (item.odds_moneyline || {}) as { home?: number; away?: number; draw?: number };
      return {
        sport_id: String(item.sport_id || ''),
        league: String(item.league || ''),
        home: String(item.home || ''),
        away: String(item.away || ''),
        date: Number(item.date || 0),
        scrape_time: Number(item.scrape_time || 0),
        odds_moneyline: {
          home: ml.home || 0,
          away: ml.away || 0,
          draw: ml.draw,
        },
        odds_handicap: Array.isArray(item.odds_handicap)
          ? (item.odds_handicap as Array<Record<string, unknown>>).map(h => ({
              line: String(h.line || ''),
              hdp: Number(h.hdp || 0),
              home: Number(h.home || 0),
              away: Number(h.away || 0),
              max: Number(h.max || 0),
            }))
          : [],
        odds_totals: Array.isArray(item.odds_totals)
          ? (item.odds_totals as Array<Record<string, unknown>>).map(t => ({
              line: String(t.line || ''),
              points: Number(t.points || 0),
              over: Number(t.over || 0),
              under: Number(t.under || 0),
              max: Number(t.max || 0),
            }))
          : [],
        implied_home_pct: oddsToImpliedPct(ml.home || 0),
        implied_away_pct: oddsToImpliedPct(ml.away || 0),
        implied_draw_pct: ml.draw ? oddsToImpliedPct(ml.draw) : null,
      };
    });

    const highlights: SportsAiHighlight[] = rawHighlights.map(item => {
      const ml = (item.odds_moneyline || {}) as { home?: number; away?: number; draw?: number };
      return {
        id: String(item.id || item._id || ''),
        league: String(item.league || ''),
        home: String(item.home || ''),
        away: String(item.away || ''),
        date: Number(item.date || 0),
        sport_id: String(item.sport_id || ''),
        odds_moneyline: {
          home: ml.home || 0,
          away: ml.away || 0,
          draw: ml.draw,
        },
      };
    });

    logger.info({ predictions: predictions.length, highlights: highlights.length }, 'Sports-AI predictions scraped');
    return { predictions, highlights };
  } catch (err) {
    logger.warn({ err }, 'Failed to scrape Sports-AI predictions');
    return { predictions: [], highlights: [] };
  }
}

async function scrapeValueBets(): Promise<SportsAiValueBet[]> {
  try {
    const res = await fetch('https://www.sports-ai.dev/value-bets', {
      headers: HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];

    const html = await res.text();
    const nextData = extractNextData(html);
    if (!nextData) return [];

    const pageProps = (nextData as { props?: { pageProps?: Record<string, unknown> } })
      ?.props?.pageProps;
    if (!pageProps) return [];

    const rawItems = (pageProps.items || []) as Array<Record<string, unknown>>;

    const valueBets: SportsAiValueBet[] = rawItems.map(item => {
      const bookmakers = Array.isArray(item.bookmakers)
        ? (item.bookmakers as Array<Record<string, unknown>>).map(b => ({
            name: String(b.name || ''),
            link: String(b.link || ''),
            price: Number(b.price || 0),
            percentageDifference: Number(b.percentageDifference || 0),
          }))
        : [];

      // trueOdds can be a single number or an array — normalize
      const rawTrue = item.trueOdds;
      let trueOdds = 0;
      if (typeof rawTrue === 'number') {
        trueOdds = rawTrue;
      } else if (Array.isArray(rawTrue) && rawTrue.length > 0) {
        trueOdds = Number(rawTrue[0]) || 0;
      }

      const bestValue = bookmakers.reduce((max, b) => Math.max(max, b.percentageDifference), 0);

      // match is a string like "Columbus Blue Jackets - Boston Bruins"
      const matchStr = String(item.match || '');
      const parts = matchStr.split(' - ');
      const home = parts[0]?.trim() || '';
      const away = parts.slice(1).join(' - ').trim() || '';

      // sport is { group: "Ice Hockey", title: "NHL", country: "USA" }
      const sportObj = (item.sport || {}) as Record<string, unknown>;

      return {
        _id: String(item._id || ''),
        home,
        away,
        league: String(sportObj.title || ''),
        sport: String(sportObj.group || ''),
        country: String(sportObj.country || ''),
        market: String(item.market || ''),
        outcome: String(item.outcome || ''),
        trueOdds,
        valuePct: bestValue,
        timeLeft: Number(item.timeLeft || 0),
        date: Date.now(),
        bookmakers,
      };
    });

    logger.info({ count: valueBets.length }, 'Sports-AI value bets scraped');
    return valueBets;
  } catch (err) {
    logger.warn({ err }, 'Failed to scrape Sports-AI value bets');
    return [];
  }
}

async function scrapeBotResults(): Promise<SportsAiBotResult[]> {
  try {
    const res = await fetch('https://www.sports-ai.dev/betting-bot/results', {
      headers: HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];

    const html = await res.text();
    const $ = cheerio.load(html);
    const results: SportsAiBotResult[] = [];

    // The results page is a server-rendered HTML table
    $('table tbody tr, table tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 8) return;

      const league = $(cells[0]).text().trim();
      const match = $(cells[1]).text().trim();
      const outcome = $(cells[2]).text().trim();
      const stake = parseFloat($(cells[3]).text().replace(/[^0-9.-]/g, '')) || 0;
      const bookie = $(cells[4]).text().trim();
      const odds = parseFloat($(cells[5]).text().replace(/[^0-9.-]/g, '')) || 0;
      const trueOdd = parseFloat($(cells[6]).text().replace(/[^0-9.-]/g, '')) || 0;
      const profit = parseFloat($(cells[7]).text().replace(/[^0-9.-]/g, '')) || 0;
      const roi = cells.length > 8 ? parseFloat($(cells[8]).text().replace(/[^0-9.-]/g, '')) || 0 : 0;
      const date = cells.length > 9 ? $(cells[9]).text().trim() : '';

      if (!league || !match) return;

      results.push({ league, match, outcome, stake, bookie, odds, trueOdd, profit, roi, date });
    });

    logger.info({ count: results.length }, 'Sports-AI bot results scraped');
    return results;
  } catch (err) {
    logger.warn({ err }, 'Failed to scrape Sports-AI bot results');
    return [];
  }
}

// ── Public API ───────────────────────────────────────────────

export async function getSportsAiData(): Promise<SportsAiData> {
  if (cache && Date.now() - cacheTime < CACHE_TTL) {
    return cache;
  }

  // Only fetch predictions + value bets (fast). Bot results are loaded lazily.
  const [predsResult, valueBetsResult] = await Promise.allSettled([
    withScraperHealth('sportsAi-predictions', () => scrapePredictions(), r => r.predictions.length),
    withScraperHealth('sportsAi-valueBets', () => scrapeValueBets(), r => r.length),
  ]);

  const preds = predsResult.status === 'fulfilled' ? predsResult.value : { predictions: [], highlights: [] };
  const valueBets = valueBetsResult.status === 'fulfilled' ? valueBetsResult.value : [];

  const data: SportsAiData = {
    predictions: preds.predictions,
    highlights: preds.highlights,
    valueBets,
    botResults: [],
    fetchedAt: new Date().toISOString(),
  };

  cache = data;
  cacheTime = Date.now();
  return data;
}

/**
 * Get bot results separately — they take ~10s to scrape (5,755 HTML rows)
 * and rarely change, so they're cached for 1 hour and loaded on demand.
 */
export async function getSportsAiBotResults(): Promise<SportsAiBotResult[]> {
  if (botResultsCache && Date.now() - botResultsCacheTime < BOT_CACHE_TTL) {
    return botResultsCache;
  }

  const results = await withScraperHealth('sportsAi-botResults', () => scrapeBotResults(), r => r.length);
  botResultsCache = results;
  botResultsCacheTime = Date.now();
  return results;
}

/**
 * Look up Sports-AI's predicted odds for a specific match.
 * Used by the booking code scorer to see if the AI agrees with a pick.
 */
export async function findPredictionForMatch(
  homeTeam: string,
  awayTeam: string,
): Promise<SportsAiPrediction | null> {
  const data = await getSportsAiData();
  const homeLower = homeTeam.toLowerCase();
  const awayLower = awayTeam.toLowerCase();

  return data.predictions.find(p => {
    const h = p.home.toLowerCase();
    const a = p.away.toLowerCase();
    return (h.includes(homeLower) || homeLower.includes(h)) &&
           (a.includes(awayLower) || awayLower.includes(a));
  }) || null;
}

/**
 * Find value bets for a specific match.
 */
export async function findValueBetsForMatch(
  homeTeam: string,
  awayTeam: string,
): Promise<SportsAiValueBet[]> {
  const data = await getSportsAiData();
  const homeLower = homeTeam.toLowerCase();
  const awayLower = awayTeam.toLowerCase();

  return data.valueBets.filter(vb => {
    const h = vb.home.toLowerCase();
    const a = vb.away.toLowerCase();
    return (h.includes(homeLower) || homeLower.includes(h)) &&
           (a.includes(awayLower) || awayLower.includes(a));
  });
}

/**
 * Get bot performance summary stats.
 */
export function getBotPerformanceSummary(results: SportsAiBotResult[]): {
  totalBets: number;
  wins: number;
  losses: number;
  totalProfit: number;
  avgRoi: number;
  bySport: Record<string, { bets: number; profit: number; roi: number }>;
} {
  const wins = results.filter(r => r.profit > 0).length;
  const losses = results.filter(r => r.profit < 0).length;
  const totalProfit = results.reduce((sum, r) => sum + r.profit, 0);
  const avgRoi = results.length > 0
    ? results.reduce((sum, r) => sum + r.roi, 0) / results.length
    : 0;

  const bySport: Record<string, { bets: number; profit: number; roi: number }> = {};
  for (const r of results) {
    const sport = r.league.split(' - ')[0] || r.league;
    if (!bySport[sport]) bySport[sport] = { bets: 0, profit: 0, roi: 0 };
    bySport[sport].bets++;
    bySport[sport].profit += r.profit;
  }
  for (const sport of Object.keys(bySport)) {
    const entry = bySport[sport]!;
    entry.roi = entry.bets > 0
      ? Math.round((entry.profit / (entry.bets * 10)) * 10000) / 100
      : 0;
  }

  return {
    totalBets: results.length,
    wins,
    losses,
    totalProfit: Math.round(totalProfit * 100) / 100,
    avgRoi: Math.round(avgRoi * 100) / 100,
    bySport,
  };
}

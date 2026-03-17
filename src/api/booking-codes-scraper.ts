/**
 * Sportybet Booking Code Scraper
 *
 * Scrapes free Sportybet booking codes from tipster sites.
 * Uses cheerio for reliable HTML parsing instead of fragile regex.
 */

import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';
import { scrapeSocialMediaCodes } from './social-codes-scraper.js';

export interface BookingCodeSelection {
  homeTeam: string;
  awayTeam: string;
  league: string;
  market: string;       // "1X2", "Over/Under", "Double Chance"
  pick: string;         // "Home", "Over 2.5", "Home or Draw"
  odds: number;
  matchStatus: string;  // "Not start", "Ended", "Cancelled"
  isWinning: number | null; // 1=won, 0=lost, null=pending
  score: string | null; // "2:1"
  matchDate: string | null; // "YYYY-MM-DD" local date of the match
  estimateStartTime: number | null; // epoch ms from Sportybet API
  // Raw Sportybet IDs for creating new codes
  eventId: string;
  marketId: string;
  outcomeId: string;
  specifier: string;
  sportId: string;
}

export interface BookingCode {
  code: string;
  source: string;
  sourceUrl: string;
  events: number | null;
  totalOdds: number | null;
  market: string | null;
  date: string | null;
  status: string | null;
  postedAgo: string | null;
  // Validated data from Sportybet API
  validated: boolean;
  isValid: boolean;
  selections: BookingCodeSelection[];
  wonCount: number;
  lostCount: number;
  pendingCount: number;
}

// Cache
let codesCache: BookingCode[] | null = null;
let codesCacheTime = 0;
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
};

/** Return today's date as YYYY-MM-DD in local timezone (not UTC). */
export function todayLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Validate Sportybet booking code format.
 * Real codes: exactly 6 chars, uppercase alphanumeric.
 * Can be all-letters (TXUWQH), all-digits+letters mix (8K68G8), etc.
 * Examples: MNVGR8, WTR6D1, TXUWQH, 8K68G8, ZBEGPN
 */
export function isValidCode(s: string): boolean {
  // Must be exactly 6 characters (Sportybet standard)
  if (s.length !== 6) return false;
  // Must be uppercase alphanumeric
  if (!/^[A-Z0-9]{6}$/.test(s)) return false;
  // Must have at least 1 letter (pure digit strings are not codes)
  if (!/[A-Z]/.test(s)) return false;
  // Must not be all hex-looking with 3+ leading digits (likely CSS color)
  if (/^[0-9A-F]{6}$/.test(s) && /^[0-9]{3,}/.test(s)) return false;
  // Must not be repeating pattern (BBB100, AAA111)
  if (/^(.)\1{2}/.test(s)) return false;
  // Exclude common HTML/CSS tokens that happen to be 6 uppercase alphanum chars
  const banned = new Set([
    'HTTPS1', 'CLASS1', 'STYLE1', 'ASYNC1', 'MEDIA1', 'WIDTH1',
    'BLOCK1', 'COLOR1', 'INPUT1', 'EVENTS', 'SCROLL', 'HIDDEN',
    'INLINE', 'NORMAL', 'CANCEL', 'SUBMIT', 'BUTTON', 'RETURN',
  ]);
  return !banned.has(s);
}

/** Scrape sportpremi.com */
async function scrapeSportPremi(): Promise<BookingCode[]> {
  try {
    const res = await fetch('https://sportpremi.com/bet-codes/sportybet/', {
      headers: HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);

    const codes: BookingCode[] = [];

    // SportPremi uses a WordPress table plugin (wptb)
    // Each row has cells containing: events, code, odds in separate div containers
    $('tr.wptb-row, table tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;

      // Collect all text from all cells
      const cellTexts: string[] = [];
      cells.each((_, cell) => {
        $(cell).find('p, div, span').each((_, el) => {
          const t = $(el).text().trim();
          if (t) cellTexts.push(t);
        });
      });

      const rowText = cellTexts.join(' ');

      // Find booking code
      let code: string | null = null;
      for (const t of cellTexts) {
        const m = t.match(/^([A-Z0-9]{6})$/);
        if (m && isValidCode(m[1]!)) { code = m[1]!; break; }
      }
      if (!code) {
        const m = rowText.match(/\b([A-Z0-9]{6})\b/);
        if (m && isValidCode(m[1]!)) code = m[1]!;
      }
      if (!code || codes.some(c => c.code === code)) return;

      // Extract events count (e.g. "22events" or "47events")
      const eventsMatch = rowText.match(/(\d{1,3})\s*events?/i);
      // Extract odds (e.g. "83.51")
      const oddsMatch = rowText.match(/([\d,]+\.\d{2})/);

      codes.push({
        code,
        source: 'SportPremi',
        sourceUrl: 'https://sportpremi.com/bet-codes/sportybet/',
        events: eventsMatch ? parseInt(eventsMatch[1]!) : null,
        totalOdds: oddsMatch ? parseFloat(oddsMatch[1]!.replace(/,/g, '')) : null,
        market: null,
        date: todayLocal(),
        status: 'pending',
        postedAgo: null,
        validated: false, isValid: false, selections: [],
        wonCount: 0, lostCount: 0, pendingCount: 0,
      });
    });

    // Fallback: scan all <p> tags for codes if table parsing found nothing
    if (codes.length === 0) {
      $('p').each((_, el) => {
        const text = $(el).text().trim();
        const match = text.match(/^([A-Z0-9]{6})$/);
        if (match && isValidCode(match[1]!)) {
          codes.push({
            code: match[1]!,
            source: 'SportPremi',
            sourceUrl: 'https://sportpremi.com/bet-codes/sportybet/',
            events: null, totalOdds: null, market: null,
            date: todayLocal(),
            status: 'pending', postedAgo: null,
            validated: false, isValid: false, selections: [],
            wonCount: 0, lostCount: 0, pendingCount: 0,
          });
        }
      });
    }

    return codes;
  } catch (err) {
    logger.warn({ err }, 'Failed to scrape SportPremi');
    return [];
  }
}

/** Scrape paqbet.com */
async function scrapePaqBet(): Promise<BookingCode[]> {
  try {
    const res = await fetch('https://paqbet.com/pg/bet-codes', {
      headers: HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);

    const codes: BookingCode[] = [];

    // PaqBet uses card elements with structured data
    $('[class*="card"], [class*="code"], [class*="bet"], .row, article, tr').each((_, el) => {
      const text = $(el).text().trim();
      const codeMatches = text.match(/\b([A-Z0-9]{5,8})\b/g) || [];

      for (const code of codeMatches) {
        if (!isValidCode(code)) continue;
        if (codes.some(c => c.code === code)) continue;

        // Extract odds
        const oddsMatch = text.match(/@\s*([\d,.]+)/);
        // Extract events count
        const eventsMatch = text.match(/(\d{1,3})\s*(?:match|game|event|selection)/i);
        // Extract market type
        const marketMatch = text.match(/(?:1st Half Handicap|Over \d+\.\d|Under \d+\.\d|BTTS|Both Teams|1X2|Double Chance|Correct Score|GG\/NG|Handicap|Draw No Bet)/i);
        // Extract time
        const timeMatch = text.match(/((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+Mar\s+\d{1,2})/i);
        // Extract status
        const wonMatch = text.match(/\b(won|win)\b/i);
        const lostMatch = text.match(/\b(lost|lose)\b/i);

        codes.push({
          code,
          source: 'PaqBet',
          sourceUrl: 'https://paqbet.com/pg/bet-codes',
          events: eventsMatch ? parseInt(eventsMatch[1]!) : null,
          totalOdds: oddsMatch ? parseFloat(oddsMatch[1]!.replace(/,/g, '')) : null,
          market: marketMatch ? marketMatch[0] : null,
          date: timeMatch ? timeMatch[0] : todayLocal(),
          status: wonMatch ? 'won' : lostMatch ? 'lost' : 'pending',
          postedAgo: null,
          validated: false, isValid: false, selections: [],
          wonCount: 0, lostCount: 0, pendingCount: 0,
        });
      }
    });

    return codes;
  } catch (err) {
    logger.warn({ err }, 'Failed to scrape PaqBet');
    return [];
  }
}

/** Scrape convertbetcodes.com */
async function scrapeConvertBetCodes(): Promise<BookingCode[]> {
  try {
    const res = await fetch('https://convertbetcodes.com/c/free-bet-codes-for-today/sportybet', {
      headers: HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);

    const codes: BookingCode[] = [];

    // Structure: each conversion card is an <h4> containing:
    // Left side: source code + platform badge
    // Right side: converted code + platform badge (sportybet)
    // Above it: events count and odds in spans
    $('h4').each((_, h4) => {
      const h4Text = $(h4).text().trim();

      // Check if this card has sportybet
      if (!/sportybet/i.test(h4Text)) return;

      // Find all potential codes in this h4
      const codeMatches = h4Text.match(/\b([A-Z0-9]{6})\b/g) || [];

      // Find the sportybet code specifically — it's in a span near the sportybet badge
      const rightSpan = $(h4).find('.float-right').first().text().trim();
      const leftSpan = $(h4).find('.float-left').first().text().trim();

      // Determine which side has the sportybet code
      let sportyCode: string | null = null;
      if (/sportybet/i.test(rightSpan)) {
        const m = rightSpan.match(/\b([A-Z0-9]{6})\b/);
        if (m && isValidCode(m[1]!)) sportyCode = m[1]!;
      } else if (/sportybet/i.test(leftSpan)) {
        const m = leftSpan.match(/\b([A-Z0-9]{6})\b/);
        if (m && isValidCode(m[1]!)) sportyCode = m[1]!;
      }

      // Fallback: any valid code in the h4
      if (!sportyCode) {
        for (const c of codeMatches) {
          if (isValidCode(c)) { sportyCode = c; break; }
        }
      }

      if (!sportyCode || codes.some(c => c.code === sportyCode)) return;

      // Find events and odds — they're in sibling/parent elements above the h4
      const parent = $(h4).parent();
      const parentText = parent.text();
      const eventsMatch = parentText.match(/(\d{1,3})\s*events?/i);
      const oddsMatch = parentText.match(/@([\d,.]+)\s*odds/i);
      const agoMatch = parentText.match(/(\d+\s*(?:hour|minute|min|hr|day)s?\s*ago)/i);

      codes.push({
        code: sportyCode,
        source: 'ConvertBetCodes',
        sourceUrl: 'https://convertbetcodes.com/c/free-bet-codes-for-today/sportybet',
        events: eventsMatch ? parseInt(eventsMatch[1]!) : null,
        totalOdds: oddsMatch ? parseFloat(oddsMatch[1]!.replace(/,/g, '')) : null,
        market: null,
        date: todayLocal(),
        status: 'pending',
        postedAgo: agoMatch ? agoMatch[0] : null,
        validated: false, isValid: false, selections: [],
        wonCount: 0, lostCount: 0, pendingCount: 0,
      });
    });

    return codes;
  } catch (err) {
    logger.warn({ err }, 'Failed to scrape ConvertBetCodes');
    return [];
  }
}

// Sportybet country codes that have a working Code Hub API
const SPORTYBET_COUNTRIES = [
  { code: 'ng', name: 'Nigeria' },
  { code: 'gh', name: 'Ghana' },
  { code: 'ke', name: 'Kenya' },
  { code: 'zm', name: 'Zambia' },
  { code: 'tz', name: 'Tanzania' },
];

type CodeHubEntry = {
  shareCode: string;
  foldsAmount: number;
  totalOdds: number;
  popularity: number;
  deadline: number;
  createTime: number;
  shareCodeDetail: Array<{
    eventId: string;
    homeTeamName: string;
    awayTeamName: string;
    startTime: number;
    marketId: number;
    marketDescription: string;
    marketSpecifiers: string;
    outcomeId: number;
    outcomeDescription: string;
    odds: number;
    sportId: string;
    tournamentId: string;
  }>;
};

/** Fetch codes from a single Sportybet country hub */
async function fetchCountryCodeHub(country: { code: string; name: string }): Promise<BookingCode[]> {
  try {
    const res = await fetch(`https://www.sportybet.com/api/${country.code}/orders/bookingCode/recommendedCode`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];

    const data = await res.json() as { bizCode: number; data?: CodeHubEntry[] };
    if (data.bizCode !== 10000 || !data.data) return [];

    return data.data.map(entry => {
      const selections: BookingCodeSelection[] = entry.shareCodeDetail.map(s => {
        const startDate = new Date(s.startTime);
        const matchDate = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;
        return {
          homeTeam: s.homeTeamName, awayTeam: s.awayTeamName,
          league: s.tournamentId, market: s.marketDescription,
          pick: s.outcomeDescription, odds: s.odds,
          matchStatus: s.startTime > Date.now() ? 'Not start' : 'Live',
          matchDate, estimateStartTime: s.startTime,
          eventId: s.eventId, marketId: String(s.marketId),
          outcomeId: String(s.outcomeId), specifier: s.marketSpecifiers || '',
          sportId: s.sportId, isWinning: null, score: null,
        };
      });

      return {
        code: entry.shareCode,
        source: `Sportybet ${country.name}`,
        sourceUrl: `https://www.sportybet.com/${country.code}/m/code-hub/codes`,
        events: entry.foldsAmount,
        totalOdds: Math.round(entry.totalOdds * 100) / 100,
        market: null, date: todayLocal(), status: 'pending', postedAgo: null,
        validated: true, isValid: true, selections,
        wonCount: 0, lostCount: 0,
        pendingCount: selections.filter(s => s.isWinning === null).length,
      } satisfies BookingCode;
    });
  } catch {
    return [];
  }
}

/** Scrape Sportybet Code Hub — all countries in parallel (100 codes total) */
async function scrapeSportyBetCodeHub(): Promise<BookingCode[]> {
  const results = await Promise.allSettled(
    SPORTYBET_COUNTRIES.map(c => fetchCountryCodeHub(c)),
  );

  const allCodes: BookingCode[] = [];
  const seen = new Set<string>();

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const code of r.value) {
      if (seen.has(code.code)) continue; // dedup across countries
      seen.add(code.code);
      allCodes.push(code);
    }
  }

  logger.info({ count: allCodes.length, countries: SPORTYBET_COUNTRIES.length }, 'Sportybet Code Hub: codes fetched');
  return allCodes;
}

/**
 * Validate a booking code against the Sportybet Nigeria API.
 * Returns match details, odds, and win/loss status for each selection.
 */
async function validateCode(code: string): Promise<{
  isValid: boolean;
  selections: BookingCodeSelection[];
  totalOdds: number;
}> {
  try {
    const res = await fetch(`https://www.sportybet.com/api/ng/orders/share/${code}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { isValid: false, selections: [], totalOdds: 0 };

    const data = await res.json() as {
      bizCode: number;
      isAvailable: boolean;
      data?: {
        ticket?: {
          selections?: Array<{
            eventId: string;
            marketId: string;
            outcomeId: string;
            specifier?: string;
            sportId: string;
          }>;
        };
        outcomes?: Array<{
          eventId: string;
          homeTeamName: string;
          awayTeamName: string;
          setScore?: string;
          matchStatus: string;
          estimateStartTime?: number;
          sport: { id: string; category: { name: string; tournament: { name: string } } };
          markets: Array<{
            id: string;
            specifier?: string;
            desc: string;
            outcomes: Array<{
              id: string;
              odds: string;
              desc: string;
              isWinning?: number;
            }>;
          }>;
        }>;
      };
    };

    if (data.bizCode !== 10000 || !data.isAvailable || !data.data?.outcomes) {
      return { isValid: false, selections: [], totalOdds: 0 };
    }

    const selections: BookingCodeSelection[] = [];
    let totalOdds = 1;

    for (const outcome of data.data.outcomes) {
      const market = outcome.markets[0];
      if (!market || !market.outcomes[0]) continue;

      const sel = market.outcomes[0];
      const odds = parseFloat(sel.odds) || 1;
      totalOdds *= odds;

      // Find matching ticket selection for raw IDs
      const ticketSel = data.data.ticket?.selections?.find(
        ts => ts.eventId === outcome.eventId && ts.marketId === market.id,
      );

      // Derive local YYYY-MM-DD from estimateStartTime (epoch ms)
      let matchDate: string | null = null;
      if (outcome.estimateStartTime) {
        const d = new Date(outcome.estimateStartTime);
        matchDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }

      selections.push({
        homeTeam: outcome.homeTeamName,
        awayTeam: outcome.awayTeamName,
        league: `${outcome.sport.category.name} - ${outcome.sport.category.tournament.name}`,
        market: market.desc,
        pick: sel.desc,
        odds,
        matchStatus: outcome.matchStatus || 'Unknown',
        matchDate,
        estimateStartTime: outcome.estimateStartTime ?? null,
        eventId: outcome.eventId,
        marketId: market.id,
        outcomeId: sel.id,
        specifier: ticketSel?.specifier || market.specifier || '',
        sportId: outcome.sport.id,
        isWinning: sel.isWinning ?? null,
        score: outcome.setScore || null,
      });
    }

    return {
      isValid: true,
      selections,
      totalOdds: Math.round(totalOdds * 100) / 100,
    };
  } catch {
    return { isValid: false, selections: [], totalOdds: 0 };
  }
}

/**
 * Get all booking codes from all sources.
 * Validates each code against Sportybet API.
 * Deduplicates by code string, keeps the entry with most data.
 */
export async function getAllBookingCodes(): Promise<BookingCode[]> {
  if (codesCache && Date.now() - codesCacheTime < CACHE_TTL) {
    return codesCache;
  }

  const [sportPremi, paqBet, convertBet, social, codeHub] = await Promise.allSettled([
    scrapeSportPremi(),
    scrapePaqBet(),
    scrapeConvertBetCodes(),
    scrapeSocialMediaCodes(),
    scrapeSportyBetCodeHub(),
  ]);

  const allCodes: BookingCode[] = [];
  if (sportPremi.status === 'fulfilled') allCodes.push(...sportPremi.value);
  if (paqBet.status === 'fulfilled') allCodes.push(...paqBet.value);
  if (convertBet.status === 'fulfilled') allCodes.push(...convertBet.value);
  if (social.status === 'fulfilled') allCodes.push(...social.value);
  if (codeHub.status === 'fulfilled') allCodes.push(...codeHub.value);

  // Deduplicate
  const byCode = new Map<string, BookingCode>();
  for (const c of allCodes) {
    const existing = byCode.get(c.code);
    if (!existing) {
      byCode.set(c.code, c);
    } else {
      if (!existing.market && c.market) existing.market = c.market;
      if (!existing.totalOdds && c.totalOdds) existing.totalOdds = c.totalOdds;
      if (!existing.events && c.events) existing.events = c.events;
      if (!existing.postedAgo && c.postedAgo) existing.postedAgo = c.postedAgo;
    }
  }

  const raw = [...byCode.values()];

  // Only validate codes that haven't been validated yet (Code Hub codes come pre-validated)
  const needsValidation = raw.filter(c => !c.validated);
  for (let i = 0; i < needsValidation.length; i += 5) {
    const batch = needsValidation.slice(i, i + 5);
    const validations = await Promise.all(
      batch.map(c => validateCode(c.code)),
    );
    for (let j = 0; j < batch.length; j++) {
      const code = batch[j]!;
      const val = validations[j]!;
      code.validated = true;
      code.isValid = val.isValid;
      code.selections = val.selections;
      if (val.isValid && val.totalOdds > 0) {
        code.totalOdds = val.totalOdds;
        code.events = val.selections.length;
      }
      code.wonCount = val.selections.filter(s => s.isWinning === 1).length;
      code.lostCount = val.selections.filter(s => s.isWinning === 0).length;
      code.pendingCount = val.selections.filter(s => s.isWinning === null).length;
    }
  }

  // Only keep valid codes
  const result = raw.filter(c => c.isValid);

  // Sort: codes with pending selections first (playable), then by odds
  result.sort((a, b) => {
    // Codes with pending games first (still playable)
    if (a.pendingCount > 0 && b.pendingCount === 0) return -1;
    if (a.pendingCount === 0 && b.pendingCount > 0) return 1;
    // Then by total odds (lower = safer)
    return (a.totalOdds || 999) - (b.totalOdds || 999);
  });

  codesCache = result;
  codesCacheTime = Date.now();
  logger.info({
    scraped: raw.length + (raw.length - result.length),
    valid: result.length,
    invalid: raw.length - result.length,
    withPending: result.filter(c => c.pendingCount > 0).length,
  }, 'Booking codes validated');

  return result;
}

/**
 * Extra Sportybet Code Scraper
 *
 * Scrapes ConvertBetCodes per-platform pages (bet9ja, 1xbet, betway, etc.)
 * to find Sportybet equivalents of codes converted from other platforms.
 * This supplements the core scrapers (SportPremi, PaqBet, ConvertBetCodes/sportybet).
 *
 * Tested 2026-03-16: pulls ~40 extra codes per run.
 */

import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';
import { isValidCode, todayLocal, type BookingCode } from './booking-codes-scraper.js';


const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
};

function extractCodes(text: string): string[] {
  const upper = text.toUpperCase();
  const matches = upper.match(/\b[A-Z0-9]{6}\b/g) || [];
  return [...new Set(matches.filter(isValidCode))];
}

function makeCode(code: string, source: string, sourceUrl: string, postedAgo: string | null): BookingCode {
  return {
    code, source, sourceUrl,
    events: null, totalOdds: null, market: null,
    date: todayLocal(), status: 'pending', postedAgo,
    validated: false, isValid: false, selections: [],
    wonCount: 0, lostCount: 0, pendingCount: 0,
  };
}

// =========================================================================
// CONVERTBETCODES — per-platform pages
// The main /sportybet page is already scraped in booking-codes-scraper.ts.
// Here we scrape the OTHER platform pages which also show Sportybet equivalents.
// =========================================================================

const CBC_PLATFORMS = [
  'bet9ja', '1xbet', 'betway', 'msport', 'betpawa',
  'betwinner', '22bet', 'melbet', 'megapari', 'linebet',
  'bangbet', 'betika', 'hollywoodbet', 'merrybet',
];

async function scrapeConvertBetCodesExtra(): Promise<BookingCode[]> {
  const codes: BookingCode[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < CBC_PLATFORMS.length; i += 4) {
    const batch = CBC_PLATFORMS.slice(i, i + 4);
    const results = await Promise.allSettled(
      batch.map(async (platform) => {
        try {
          const url = `https://convertbetcodes.com/c/free-bet-codes-for-today/${platform}`;
          const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
          if (!res.ok) return [];

          const html = await res.text();
          const $ = cheerio.load(html);
          const pageCodes: BookingCode[] = [];

          $('h4').each((_, h4) => {
            const el = $(h4);
            const h4Text = el.text().trim();
            if (!/sportybet/i.test(h4Text)) return;

            const rightSpan = el.find('.float-right').first().text().trim();
            const leftSpan = el.find('.float-left').first().text().trim();

            let sportyCode: string | null = null;
            if (/sportybet/i.test(rightSpan)) {
              const m = rightSpan.match(/\b([A-Z0-9]{6})\b/);
              if (m && isValidCode(m[1]!)) sportyCode = m[1]!;
            }
            if (!sportyCode && /sportybet/i.test(leftSpan)) {
              const m = leftSpan.match(/\b([A-Z0-9]{6})\b/);
              if (m && isValidCode(m[1]!)) sportyCode = m[1]!;
            }
            if (!sportyCode) {
              for (const code of extractCodes(h4Text)) { sportyCode = code; break; }
            }

            if (!sportyCode || seen.has(sportyCode)) return;
            seen.add(sportyCode);

            const parent = el.parent();
            const parentText = parent.text();
            const eventsMatch = parentText.match(/(\d{1,3})\s*events?/i);
            const oddsMatch = parentText.match(/@([\d,.]+)\s*odds/i);
            const agoMatch = parentText.match(/(\d+\s*(?:hour|minute|min|hr|day)s?\s*ago)/i);

            const c = makeCode(
              sportyCode,
              `ConvertBetCodes (${platform})`,
              `https://convertbetcodes.com/c/free-bet-codes-for-today/${platform}`,
              agoMatch ? agoMatch[0] : null,
            );
            c.events = eventsMatch ? parseInt(eventsMatch[1]!) : null;
            c.totalOdds = oddsMatch ? parseFloat(oddsMatch[1]!.replace(/,/g, '')) : null;
            pageCodes.push(c);
          });

          return pageCodes;
        } catch {
          return [];
        }
      }),
    );

    for (const r of results) {
      if (r.status === 'fulfilled') codes.push(...r.value);
    }
  }

  return codes;
}

// =========================================================================
// CONVERTBETCODES — "all" page (different from the sportybet-specific page)
// =========================================================================

async function scrapeConvertBetCodesAll(): Promise<BookingCode[]> {
  try {
    const url = 'https://convertbetcodes.com/c/free-bet-codes-for-today';
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];

    const html = await res.text();
    const $ = cheerio.load(html);
    const codes: BookingCode[] = [];
    const seen = new Set<string>();

    $('h4').each((_, h4) => {
      const el = $(h4);
      const text = el.text().trim();
      if (!/sportybet/i.test(text)) return;

      for (const code of extractCodes(text)) {
        if (seen.has(code)) continue;
        seen.add(code);

        const parent = el.parent();
        const pt = parent.text();
        const agoMatch = pt.match(/(\d+\s*(?:hour|minute|min|hr|day)s?\s*ago)/i);
        const eventsMatch = pt.match(/(\d{1,3})\s*events?/i);
        const oddsMatch = pt.match(/@([\d,.]+)\s*odds/i);

        const c = makeCode(code, 'ConvertBetCodes (all)', url, agoMatch ? agoMatch[0] : null);
        c.events = eventsMatch ? parseInt(eventsMatch[1]!) : null;
        c.totalOdds = oddsMatch ? parseFloat(oddsMatch[1]!.replace(/,/g, '')) : null;
        codes.push(c);
      }
    });

    return codes;
  } catch {
    return [];
  }
}

// =========================================================================
// MAIN ENTRY
// =========================================================================

export async function scrapeSocialMediaCodes(): Promise<BookingCode[]> {
  const [cbcExtra, cbcAll] = await Promise.allSettled([
    scrapeConvertBetCodesExtra(),
    scrapeConvertBetCodesAll(),
  ]);

  const all: BookingCode[] = [];
  if (cbcExtra.status === 'fulfilled') all.push(...cbcExtra.value);
  if (cbcAll.status === 'fulfilled') all.push(...cbcAll.value);

  // Deduplicate
  const byCode = new Map<string, BookingCode>();
  for (const c of all) {
    if (!byCode.has(c.code)) byCode.set(c.code, c);
  }

  const result = [...byCode.values()];
  logger.info({
    total: result.length,
    cbcExtra: cbcExtra.status === 'fulfilled' ? cbcExtra.value.length : 0,
    cbcAll: cbcAll.status === 'fulfilled' ? cbcAll.value.length : 0,
  }, 'Extra codes scraped');

  return result;
}

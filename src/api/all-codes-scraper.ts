/**
 * All-Platform Booking Code Scraper
 *
 * Scrapes booking codes for ALL betting platforms from convertbetcodes.com.
 * Platforms: Bet9ja, 1xBet, Betway, MSport, Betpawa, Sportybet, etc.
 */

import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';

export interface AllPlatformCode {
  code: string;
  platform: string;
  events: number | null;
  totalOdds: number | null;
  postedAgo: string | null;
  sourceUrl: string;
  // Conversion pair: if this code was converted from/to another platform
  sportyCode: string | null;  // Sportybet equivalent (if available)
  convertedFrom: { code: string; platform: string } | null;
}

let allCodesCache: AllPlatformCode[] | null = null;
let allCodesCacheTime = 0;
const CACHE_TTL = 15 * 60 * 1000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// Platforms we care about (skip obscure ones)
const KNOWN_PLATFORMS = new Set([
  'sportybet', 'bet9ja', '1xbet', 'betway', 'msport', 'betpawa',
  'betwinner', 'betika', '22bet', 'hollywoodbet', 'megapari',
  'melbet', 'linebet', 'bangbet', 'merrybet', 'sportpesa',
  'soccabet', 'helabet', 'paripesa', 'odibet', 'betbaba',
]);

export async function scrapeAllPlatformCodes(): Promise<AllPlatformCode[]> {
  if (allCodesCache && Date.now() - allCodesCacheTime < CACHE_TTL) {
    return allCodesCache;
  }

  try {
    const res = await fetch('https://convertbetcodes.com/c/free-bet-codes-for-today', {
      headers: HEADERS,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return allCodesCache || [];
    const html = await res.text();
    const $ = cheerio.load(html);

    const codes: AllPlatformCode[] = [];
    const seen = new Set<string>();

    $('h4').each((_, h4) => {
      const el = $(h4);

      // Extract left/right sides with their platform badges
      const badges = el.find('code.badge').map((_, b) => $(b).text().trim().toLowerCase().replace(/\s+/g, '')).get();
      const leftSpan = el.find('.float-left').first().text().trim();
      const rightSpan = el.find('.float-right').first().text().trim();

      const leftCode = leftSpan.match(/\b([A-Za-z0-9]{4,12})\b/);
      const rightCode = rightSpan.match(/\b([A-Za-z0-9]{4,12})\b/);
      const leftPlatform = (badges[0] || '').replace(/\s+/g, '');
      const rightPlatform = (badges[1] || '').replace(/\s+/g, '');

      if (!leftCode && !rightCode) return;

      // Get events/odds from parent container
      const container = el.parent();
      const containerText = container.text();
      const eventsMatch = containerText.match(/(\d{1,3})\s*events?/i);
      const oddsMatch = containerText.match(/@([\d,.]+)\s*odds/i);
      const agoMatch = containerText.match(/(\d+\s*(?:hour|minute|min|hr|day)s?\s*ago)/i);

      const events = eventsMatch ? parseInt(eventsMatch[1]!) : null;
      const totalOdds = oddsMatch ? parseFloat(oddsMatch[1]!.replace(/,/g, '')) : null;
      const postedAgo = agoMatch ? agoMatch[0] : null;

      // Determine if either side is Sportybet (for conversion linking)
      const leftIsSporty = leftPlatform === 'sportybet';
      const rightIsSporty = rightPlatform === 'sportybet';

      // Build entries for both sides of the conversion
      const sides: { code: string; platform: string; otherCode: string | null; otherPlatform: string }[] = [];

      if (leftCode?.[1] && leftPlatform && KNOWN_PLATFORMS.has(leftPlatform)) {
        if (!/[a-zA-Z]/.test(leftCode[1])) { /* skip numeric-only */ }
        else if (/^(class|style|badge|float|https|code)$/i.test(leftCode[1])) { /* skip HTML tokens */ }
        else sides.push({ code: leftCode[1], platform: leftPlatform, otherCode: rightCode?.[1] || null, otherPlatform: rightPlatform });
      }

      if (rightCode?.[1] && rightPlatform && KNOWN_PLATFORMS.has(rightPlatform) && rightCode[1] !== leftCode?.[1]) {
        if (!/[a-zA-Z]/.test(rightCode[1])) { /* skip */ }
        else if (/^(class|style|badge|float|https|code)$/i.test(rightCode[1])) { /* skip */ }
        else sides.push({ code: rightCode[1], platform: rightPlatform, otherCode: leftCode?.[1] || null, otherPlatform: leftPlatform });
      }

      for (const entry of sides) {
        const key = entry.code + ':' + entry.platform;
        if (seen.has(key)) continue;
        seen.add(key);

        // Determine Sportybet equivalent
        let sportyCode: string | null = null;
        let convertedFrom: { code: string; platform: string } | null = null;

        if (entry.platform === 'sportybet') {
          sportyCode = entry.code; // it IS sportybet
          if (entry.otherCode && entry.otherPlatform && entry.otherPlatform !== 'sportybet') {
            convertedFrom = { code: entry.otherCode, platform: entry.otherPlatform };
          }
        } else {
          // Non-sporty code — check if the other side is sportybet
          if (entry.otherPlatform === 'sportybet' && entry.otherCode) {
            sportyCode = entry.otherCode;
          }
          convertedFrom = null;
        }

        codes.push({
          code: entry.code,
          platform: entry.platform,
          events,
          totalOdds,
          postedAgo,
          sourceUrl: 'https://convertbetcodes.com/c/free-bet-codes-for-today',
          sportyCode,
          convertedFrom,
        });
      }
    });

    // Also try to scrape the popular platform-specific pages for more codes
    const extraPages = ['bet9ja', '1xbet', 'betway', 'msport', 'betpawa'];
    const extraResults = await Promise.allSettled(
      extraPages.map(async (platform) => {
        const pageRes = await fetch(
          `https://convertbetcodes.com/c/free-bet-codes-for-today/${platform}`,
          { headers: HEADERS, signal: AbortSignal.timeout(8000) },
        );
        if (!pageRes.ok) return [];
        const pageHtml = await pageRes.text();
        const page$ = cheerio.load(pageHtml);
        const pageCodes: AllPlatformCode[] = [];

        page$('h4').each((_, h4) => {
          const elText = page$(h4).text().trim();
          const badges = page$(h4).find('code.badge').map((_, b) => page$(b).text().trim().toLowerCase()).get();

          // Find codes for this platform
          const spans = [
            page$(h4).find('.float-left').first().text().trim(),
            page$(h4).find('.float-right').first().text().trim(),
          ];

          for (let si = 0; si < spans.length; si++) {
            const codeMatch = spans[si]!.match(/\b([A-Za-z0-9]{4,12})\b/);
            const plat = (badges[si] || platform).replace(/\s+/g, '').toLowerCase();
            if (!codeMatch || !KNOWN_PLATFORMS.has(plat)) continue;
            if (!/[a-zA-Z]/.test(codeMatch[1]!)) continue;

            const key = codeMatch[1]! + ':' + plat;
            if (seen.has(key)) continue;
            seen.add(key);

            const ct = page$(h4).parent().text();
            const em = ct.match(/(\d{1,3})\s*events?/i);
            const om = ct.match(/@([\d,.]+)\s*odds/i);
            const am = ct.match(/(\d+\s*(?:hour|minute|min|hr|day)s?\s*ago)/i);

            pageCodes.push({
              code: codeMatch[1]!,
              platform: plat,
              events: em ? parseInt(em[1]!) : null,
              totalOdds: om ? parseFloat(om[1]!.replace(/,/g, '')) : null,
              postedAgo: am ? am[0] : null,
              sourceUrl: `https://convertbetcodes.com/c/free-bet-codes-for-today/${platform}`,
              sportyCode: plat === 'sportybet' ? codeMatch[1]! : null,
              convertedFrom: null,
            });
          }
        });

        return pageCodes;
      }),
    );

    for (const result of extraResults) {
      if (result.status === 'fulfilled') codes.push(...result.value);
    }

    // Sort: newest first
    codes.sort((a, b) => {
      // Parse "X minutes/hours ago" for rough sorting
      const parseAgo = (s: string | null) => {
        if (!s) return 9999;
        const m = s.match(/(\d+)\s*(minute|hour|day)/i);
        if (!m) return 9999;
        const n = parseInt(m[1]!);
        if (m[2]!.startsWith('day')) return n * 1440;
        if (m[2]!.startsWith('hour') || m[2]!.startsWith('hr')) return n * 60;
        return n;
      };
      return parseAgo(a.postedAgo) - parseAgo(b.postedAgo);
    });

    allCodesCache = codes;
    allCodesCacheTime = Date.now();
    logger.info({ total: codes.length, platforms: [...new Set(codes.map(c => c.platform))].length }, 'All-platform codes scraped');

    return codes;
  } catch (err) {
    logger.warn({ err }, 'Failed to scrape all-platform codes');
    return allCodesCache || [];
  }
}

/**
 * Telegram Public Channel Scraper
 *
 * Scrapes Sportybet booking codes from public Telegram channels
 * using the t.me/s/{channel} web preview (no API key needed).
 */

import { logger } from '../utils/logger.js';
import { isValidCode, todayLocal, type BookingCode } from './booking-codes-scraper.js';

const TELEGRAM_CHANNELS = [
  'sportybetfreecodes',
  'sportybet_free_codes',
  'sportybet_codes',
  'sportybet_code',
  'sportybet_ng',
  'sportybet_daily',
  'sportybet_prediction',
  'sportybetng',
  'sportybet_kenya',
  'freesportybetcode',
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

function extractCodesFromMessage(text: string): string[] {
  const upper = text.toUpperCase();
  const matches = upper.match(/\b[A-Z0-9]{6,8}\b/g) || [];
  return matches.filter(m => {
    if (m.length !== 6) return false;
    if (!isValidCode(m)) return false;
    // Require at least 1 digit (filter English words)
    if (!/[0-9]/.test(m)) return false;
    if ((m.match(/[A-Z]/g) || []).length < 2) return false;
    return true;
  });
}

async function scrapeChannel(channel: string): Promise<BookingCode[]> {
  try {
    const res = await fetch(`https://t.me/s/${channel}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];

    const html = await res.text();

    // Extract messages from the widget HTML
    const msgRegex = /tgme_widget_message_text[^"]*"[^>]*>(.*?)<\/div>/gs;
    const dateRegex = /datetime="([^"]+)"/g;

    // Collect all dates
    const dates: string[] = [];
    let dateMatch;
    while ((dateMatch = dateRegex.exec(html)) !== null) {
      dates.push(dateMatch[1]!);
    }

    const codes: BookingCode[] = [];
    const seen = new Set<string>();
    let msgIdx = 0;
    let match;

    while ((match = msgRegex.exec(html)) !== null) {
      const msgHtml = match[1]!;
      // Strip HTML tags
      const text = msgHtml.replace(/<[^>]+>/g, ' ').trim();

      const extracted = extractCodesFromMessage(text);
      const msgDate = dates[msgIdx] || null;
      msgIdx++;

      for (const code of extracted) {
        if (seen.has(code)) continue;
        seen.add(code);

        // Extract odds if mentioned
        const oddsMatch = text.match(/([\d,.]+)\s*odds/i);

        codes.push({
          code,
          source: `Telegram (@${channel})`,
          sourceUrl: `https://t.me/s/${channel}`,
          events: null,
          totalOdds: oddsMatch ? parseFloat(oddsMatch[1]!.replace(/,/g, '')) : null,
          market: null,
          date: todayLocal(),
          status: 'pending',
          postedAgo: msgDate ? timeAgo(msgDate) : null,
          validated: false,
          isValid: false,
          selections: [],
          wonCount: 0,
          lostCount: 0,
          pendingCount: 0,
        });
      }
    }

    return codes;
  } catch (err) {
    logger.warn({ err, channel }, 'Failed to scrape Telegram channel');
    return [];
  }
}

function timeAgo(dateStr: string): string | null {
  try {
    const then = new Date(dateStr).getTime();
    const now = Date.now();
    const diffMs = now - then;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `${mins} minutes ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hours ago`;
    const days = Math.floor(hours / 24);
    return `${days} days ago`;
  } catch {
    return null;
  }
}

/**
 * Scrape Sportybet booking codes from public Telegram channels.
 */
export async function scrapeTelegramCodes(): Promise<BookingCode[]> {
  // Batch channels to avoid rate limits (3 concurrent)
  const allCodes: BookingCode[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < TELEGRAM_CHANNELS.length; i += 3) {
    const batch = TELEGRAM_CHANNELS.slice(i, i + 3);
    const results = await Promise.allSettled(
      batch.map(ch => scrapeChannel(ch)),
    );
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const code of r.value) {
        if (seen.has(code.code)) continue;
        seen.add(code.code);
        allCodes.push(code);
      }
    }
  }

  logger.info({ count: allCodes.length, channels: TELEGRAM_CHANNELS.length }, 'Telegram: codes scraped');
  return allCodes;
}

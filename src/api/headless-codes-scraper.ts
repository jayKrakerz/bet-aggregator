/**
 * Headless Browser Code Scraper
 *
 * Scrapes JS-rendered tipster sites that can't be scraped with cheerio/fetch.
 * Uses puppeteer-core with the system Chrome installation.
 * Lazy-loaded to avoid crashing when Chrome is unavailable (e.g. Vercel).
 */

import fs from 'node:fs';
import type { Browser } from 'puppeteer-core';
import { logger } from '../utils/logger.js';
import { isValidCode, todayLocal, type BookingCode } from './booking-codes-scraper.js';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',      // macOS
  '/usr/bin/google-chrome-stable',                                      // Linux
  '/usr/bin/chromium-browser',                                          // Linux alt
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',         // Windows
];

const SITES = [
  {
    name: 'BetCodes24',
    urls: [
      'https://betcodes24.com/booking-codes/sportybet/',
      'https://betcodes24.com/booking-codes/',
    ],
  },
  {
    name: 'SurePredictz',
    urls: [
      'https://surepredictz.com/sportybet-booking-code-today',
      'https://surepredictz.com/free-booking-codes',
    ],
  },
];

function extractValidCodes(text: string): string[] {
  const upper = text.toUpperCase();
  const matches = upper.match(/\b[A-Z0-9]{6}\b/g) || [];
  return [...new Set(matches.filter(m => {
    if (!isValidCode(m)) return false;
    if (!/[0-9]/.test(m)) return false;
    if ((m.match(/[A-Z]/g) || []).length < 2) return false;
    if (/^\d+[A-Z]+$/.test(m)) return false;
    return true;
  }))];
}

function findChrome(): string | null {
  for (const p of CHROME_PATHS) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

/**
 * Scrape codes from JS-rendered sites using headless Chrome.
 * Returns empty array if Chrome is not available.
 */
export async function scrapeHeadlessCodes(): Promise<BookingCode[]> {
  const chromePath = findChrome();
  if (!chromePath) {
    logger.debug('Headless scraper skipped — no Chrome found');
    return [];
  }

  let browser: Browser | null = null;
  const allCodes: BookingCode[] = [];
  const seen = new Set<string>();

  try {
    const puppeteer = await import('puppeteer-core');
    browser = await puppeteer.default.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });

    for (const site of SITES) {
      for (const url of site.urls) {
        const page = await browser.newPage();
        try {
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
          const text = await page.evaluate(() => document.body.innerText);

          // Only process if it mentions sportybet
          if (!text.toLowerCase().includes('sportybet') && !text.toLowerCase().includes('sporty')) {
            await page.close();
            continue;
          }

          const codes = extractValidCodes(text);

          for (const code of codes) {
            if (seen.has(code)) continue;
            seen.add(code);

            // Try to find odds context
            const oddsMatch = text.match(new RegExp(code + '[\\s\\S]{0,100}?(\\d+\\.?\\d*)\\s*odds', 'i'));

            allCodes.push({
              code,
              source: site.name,
              sourceUrl: url,
              events: null,
              totalOdds: oddsMatch ? parseFloat(oddsMatch[1]!) : null,
              market: null,
              date: todayLocal(),
              status: 'pending',
              postedAgo: null,
              validated: false,
              isValid: false,
              selections: [],
              wonCount: 0,
              lostCount: 0,
              pendingCount: 0,
            });
          }
        } catch (err) {
          logger.warn({ err, url }, 'Headless scrape failed for page');
        }
        await page.close();
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Headless browser launch failed');
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }

  logger.info({ count: allCodes.length }, 'Headless: codes scraped');
  return allCodes;
}

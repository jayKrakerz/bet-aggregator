/**
 * Virtual Football Scraper
 *
 * Uses Puppeteer to scrape Sportybet's Golden Race virtual football
 * schedule from the embedded iframe at virtustec.com.
 * Caches results for 2 minutes since virtual rounds change every ~3 min.
 */

import puppeteer, { type Browser } from 'puppeteer-core';
import { logger } from '../utils/logger.js';

export interface VirtualMatch {
  num: string;
  home: string;
  away: string;
  homeOdds: string;
  drawOdds: string;
  awayOdds: string;
}

export interface VirtualLeague {
  title: string;       // "Football League: Germany Week 25"
  country: string;     // "Germany"
  week: string;        // "Week 25"
  timer: string;       // "00:47" countdown to kick-off
  matches: VirtualMatch[];
}

// Cache
let virtualsCache: VirtualLeague[] = [];
let virtualsCacheTime = 0;
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes

// Chrome path detection
function getChromePath(): string {
  const paths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  return paths[0]!; // macOS default, adjust for server
}

let browserInstance: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

export async function getBrowser(): Promise<Browser> {
  if (browserInstance?.connected) return browserInstance;

  // Prevent multiple simultaneous launches
  if (browserLaunchPromise) return browserLaunchPromise;

  browserLaunchPromise = puppeteer.launch({
    executablePath: getChromePath(),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--no-first-run',
      '--single-process',
    ],
  });

  try {
    browserInstance = await browserLaunchPromise;
    browserInstance.on('disconnected', () => {
      browserInstance = null;
      browserLaunchPromise = null;
    });
    return browserInstance;
  } finally {
    browserLaunchPromise = null;
  }
}

let scrapeInProgress: Promise<VirtualLeague[]> | null = null;

export async function scrapeVirtuals(): Promise<VirtualLeague[]> {
  // Return cache if fresh
  if (virtualsCache.length > 0 && Date.now() - virtualsCacheTime < CACHE_TTL) {
    return virtualsCache;
  }

  // If a scrape is already running, wait for it instead of starting another
  if (scrapeInProgress) return scrapeInProgress;

  scrapeInProgress = doScrapeVirtuals();
  try {
    return await scrapeInProgress;
  } finally {
    scrapeInProgress = null;
  }
}

async function doScrapeVirtuals(): Promise<VirtualLeague[]> {
  const startTime = Date.now();
  let page: Awaited<ReturnType<Browser['newPage']>> | null = null;

  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    );
    // Block images/media for speed
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto('https://www.sportybet.com/gh/virtual/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Wait for the Golden Race iframe to load and render
    await new Promise((r) => setTimeout(r, 15000));

    // Find the GR iframe
    const grFrame = page.frames().find(
      (f) => f.url().includes('virtustec.com') || f.url().includes('golden-race'),
    );

    if (!grFrame) {
      logger.warn('Virtual scraper: Golden Race iframe not found');
      return virtualsCache; // return stale cache if available
    }

    // Extract football events
    const raw = await grFrame.evaluate(() => {
      const markets = document.querySelectorAll('.market');
      const results: Array<{
        title: string;
        timer: string;
        matches: Array<{
          num: string;
          home: string;
          away: string;
          homeOdds: string;
          drawOdds: string;
          awayOdds: string;
        }>;
      }> = [];

      for (const m of Array.from(markets)) {
        const titleEl = m.querySelector('.market-title, .event-description');
        const title = (titleEl?.textContent || '').replace(/\s+/g, ' ').trim();
        if (!title.toLowerCase().includes('football')) continue;

        const timer = m.querySelector('.market-timer')?.textContent?.trim() || '';
        const rows = Array.from(m.querySelectorAll('.market-table-row'));
        const matches: Array<{
          num: string;
          home: string;
          away: string;
          homeOdds: string;
          drawOdds: string;
          awayOdds: string;
        }> = [];

        for (const row of rows) {
          const num = row.querySelector('.match-number')?.textContent?.trim() || '';
          const teams = row.querySelectorAll('.team-name');
          const home = teams[0]?.textContent?.trim() || '';
          const away = teams[1]?.textContent?.trim() || '';
          const odds = row.querySelectorAll('.odd-value');
          const homeOdds = odds[0]?.textContent?.trim() || '';
          const drawOdds = odds[1]?.textContent?.trim() || '';
          const awayOdds = odds[2]?.textContent?.trim() || '';
          if (home && away) {
            matches.push({ num, home, away, homeOdds, drawOdds, awayOdds });
          }
        }

        if (matches.length > 0) {
          results.push({ title, timer, matches });
        }
      }
      return results;
    });

    // Parse into structured data
    const leagues: VirtualLeague[] = raw.map((r) => {
      // Parse "Football League: Germany Week 25"
      const parts = r.title.replace('Football League:', '').trim().split(/\s+(Week\s+\d+)/i);
      const country = parts[0]?.trim() || 'Unknown';
      const week = parts[1]?.trim() || '';
      return {
        title: r.title,
        country,
        week,
        timer: r.timer,
        matches: r.matches,
      };
    });

    const elapsed = Date.now() - startTime;
    logger.info(
      { leagues: leagues.length, matches: leagues.reduce((s, l) => s + l.matches.length, 0), elapsed },
      'Virtual football scraped',
    );

    virtualsCache = leagues;
    virtualsCacheTime = Date.now();
    return leagues;
  } catch (err) {
    logger.error({ err }, 'Virtual scraper error');
    return virtualsCache; // return stale cache
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // ignore
      }
    }
  }
}

// Graceful shutdown
export async function closeVirtualBrowser(): Promise<void> {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch {
      // ignore
    }
    browserInstance = null;
  }
}

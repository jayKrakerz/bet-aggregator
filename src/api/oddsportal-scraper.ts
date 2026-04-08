/**
 * OddsPortal Scraper
 *
 * Scrapes upcoming football match odds from oddsportal.com using Puppeteer.
 * Based on patterns from oddsharvester (Python/Playwright).
 *
 * Features:
 * - Scrapes today's football matches with odds from multiple bookmakers
 * - Extracts average odds + per-bookmaker breakdown
 * - Caches results for 15 minutes
 * - Lazy-loads Puppeteer to avoid crashes on Vercel
 *
 * URL pattern: https://www.oddsportal.com/matches/football/YYYYMMDD/
 */

import { logger } from '../utils/logger.js';

// ── Types ───────────────────────────────────────────────────

export interface OddsPortalMatch {
  url: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  date: string;
  time: string;
  odds1x2: {
    home: number;
    draw: number;
    away: number;
  } | null;
  bookmakers: Array<{
    name: string;
    home: number;
    draw: number;
    away: number;
  }>;
}

export interface OddsPortalResult {
  matches: OddsPortalMatch[];
  count: number;
  scrapedAt: string;
  date: string;
}

// ── Constants (from oddsharvester) ──────────────────────────

const BASE_URL = 'https://www.oddsportal.com';
const COOKIE_BANNER = '#onetrust-accept-btn-handler';
const EVENT_ROW_PATTERN = /^eventRow/;
const BOOKMAKER_ROW_CLASS = 'border-black-borders';
const ODDS_BLOCK_PATTERN = /flex-center.*flex-col.*font-bold/;

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
];

import fs from 'node:fs';

function findChrome(): string {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return CHROME_PATHS[0]!;
}

// ── Cache ───────────────────────────────────────────────────

let cache: OddsPortalResult | null = null;
let cacheTime = 0;
const CACHE_TTL = 15 * 60 * 1000; // 15 min

// ── Scraper ─────────────────────────────────────────────────

function todayDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Scrape upcoming football matches from OddsPortal for today.
 * Returns match list with average 1X2 odds.
 */
export async function scrapeOddsPortal(
  date?: string,
): Promise<OddsPortalResult> {
  const targetDate = date || todayDate();

  // Check cache
  if (cache && Date.now() - cacheTime < CACHE_TTL && cache.date === targetDate) {
    return cache;
  }

  const puppeteer = await import('puppeteer-core');
  let browser;

  try {
    browser = await puppeteer.default.launch({
      executablePath: findChrome(),
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--window-size=1280,720',
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    );

    // Block images/fonts for speed
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'media', 'font'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const url = `${BASE_URL}/matches/football/${targetDate}/`;
    logger.info({ url }, 'OddsPortal: navigating');

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Dismiss cookie banner
    try {
      await page.waitForSelector(COOKIE_BANNER, { timeout: 5000 });
      await page.click(COOKIE_BANNER);
      await new Promise((r) => setTimeout(r, 1000));
    } catch {
      // No cookie banner
    }

    // Scroll to load lazy content (OddsPortal uses lazy loading)
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await new Promise((r) => setTimeout(r, 1500));
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 1000));

    // Extract match data from the page
    const matches = await page.evaluate(
      (baseUrl: string) => {
        const results: Array<{
          url: string;
          homeTeam: string;
          awayTeam: string;
          league: string;
          time: string;
          home: number;
          draw: number;
          away: number;
        }> = [];

        // Find all event rows
        const rows = document.querySelectorAll('div[class^="eventRow"]');
        let currentLeague = '';

        // Track league headers
        const leagueHeaders = document.querySelectorAll(
          'div.text-black-main.font-main, a[class*="font-main"]',
        );
        const leagueMap = new Map<Element, string>();
        for (let i = 0; i < leagueHeaders.length; i++) {
          const el = leagueHeaders[i] as HTMLElement;
          const text = el.textContent?.trim() || '';
          if (text && text.length > 2) {
            leagueMap.set(el, text);
          }
        }

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i] as HTMLElement;

          // Try to find the league this row belongs to by walking up
          let leagueEl = row.previousElementSibling;
          let attempts = 0;
          while (leagueEl && attempts < 10) {
            const leagueText = leagueMap.get(leagueEl);
            if (leagueText) {
              currentLeague = leagueText;
              break;
            }
            leagueEl = leagueEl.previousElementSibling;
            attempts++;
          }

          // Extract teams from links
          const links = row.querySelectorAll('a[href]');
          let matchUrl = '';
          const teamNames: string[] = [];
          let matchTime = '';

          for (let j = 0; j < links.length; j++) {
            const link = links[j] as HTMLAnchorElement;
            const href = link.getAttribute('href') || '';
            // Match links have 4+ path segments
            if (href.split('/').filter(Boolean).length > 3 && !matchUrl) {
              matchUrl = baseUrl + href;
            }
            // Team names are typically in spans within the link
            const text = link.textContent?.trim() || '';
            if (text && text.length > 1 && text.length < 40 && !text.includes(':')) {
              teamNames.push(text);
            }
          }

          // Extract time
          const timeEl = row.querySelector('p[class*="text-"]');
          if (timeEl) {
            matchTime = timeEl.textContent?.trim() || '';
          }

          // Extract odds (look for odds cells)
          const oddsCells = row.querySelectorAll('div[class*="flex-center"] p, p[class*="height-content"]');
          const oddsValues: number[] = [];
          for (let j = 0; j < oddsCells.length; j++) {
            const text = (oddsCells[j] as HTMLElement).textContent?.trim() || '';
            const val = parseFloat(text);
            if (!isNaN(val) && val > 1 && val < 200) {
              oddsValues.push(val);
            }
          }

          if (teamNames.length >= 2 && oddsValues.length >= 3) {
            results.push({
              url: matchUrl,
              homeTeam: teamNames[0]!,
              awayTeam: teamNames[1]!,
              league: currentLeague,
              time: matchTime,
              home: oddsValues[0]!,
              draw: oddsValues[1]!,
              away: oddsValues[2]!,
            });
          }
        }

        return results;
      },
      BASE_URL,
    );

    await page.close();

    const result: OddsPortalResult = {
      matches: matches.map((m) => ({
        url: m.url,
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
        league: m.league,
        date: targetDate,
        time: m.time,
        odds1x2: {
          home: m.home,
          draw: m.draw,
          away: m.away,
        },
        bookmakers: [],
      })),
      count: matches.length,
      scrapedAt: new Date().toISOString(),
      date: targetDate,
    };

    cache = result;
    cacheTime = Date.now();

    logger.info(
      { matches: result.count, date: targetDate },
      'OddsPortal scrape complete',
    );

    return result;
  } catch (err) {
    logger.error({ err }, 'OddsPortal scrape failed');
    if (cache) return cache; // return stale cache
    return {
      matches: [],
      count: 0,
      scrapedAt: new Date().toISOString(),
      date: targetDate,
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Scrape detailed per-bookmaker odds for a specific match URL.
 * Opens the match page and extracts individual bookmaker rows.
 */
export async function scrapeMatchOdds(
  matchUrl: string,
): Promise<OddsPortalMatch | null> {
  const puppeteer = await import('puppeteer-core');
  let browser;

  try {
    browser = await puppeteer.default.launch({
      executablePath: findChrome(),
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    );

    await page.goto(matchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Dismiss cookie banner
    try {
      await page.waitForSelector(COOKIE_BANNER, { timeout: 3000 });
      await page.click(COOKIE_BANNER);
      await new Promise((r) => setTimeout(r, 1000));
    } catch { /* no banner */ }

    // Wait for odds to load
    await new Promise((r) => setTimeout(r, 3000));

    const data = await page.evaluate(() => {
      // Extract teams from header
      const homeEl = document.querySelector('span.homeTeam, [class*="homeTeam"]');
      const awayEl = document.querySelector('span.awayTeam, [class*="awayTeam"]');
      const homeTeam = homeEl?.textContent?.trim() || '';
      const awayTeam = awayEl?.textContent?.trim() || '';

      // Extract bookmaker rows
      const bookmakers: Array<{ name: string; home: number; draw: number; away: number }> = [];
      const rows = document.querySelectorAll('div.border-black-borders.flex.h-9');

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] as HTMLElement;

        // Bookmaker name from logo
        const logo = row.querySelector('img.bookmaker-logo, img[class*="bookmaker"]') as HTMLImageElement | null;
        const nameLink = row.querySelector('a[title]') as HTMLAnchorElement | null;
        let name = logo?.title || logo?.alt || nameLink?.title || '';
        if (name.toLowerCase().startsWith('go to ') && name.endsWith('!')) {
          name = name.slice(6, -1).replace(/ website$/i, '').trim();
        }
        if (!name) continue;

        // Odds values
        const oddsCells = row.querySelectorAll('div[class*="flex-center"][class*="font-bold"]');
        const vals: number[] = [];
        for (let j = 0; j < oddsCells.length; j++) {
          const text = (oddsCells[j] as HTMLElement).textContent?.trim() || '';
          // Handle fractional odds (e.g., "4/5")
          const fracMatch = text.match(/^(\d+)\/(\d+)$/);
          if (fracMatch) {
            vals.push(parseInt(fracMatch[1]!) / parseInt(fracMatch[2]!) + 1);
          } else {
            const v = parseFloat(text);
            if (!isNaN(v) && v > 1) vals.push(v);
          }
        }

        if (vals.length >= 3) {
          bookmakers.push({ name, home: vals[0]!, draw: vals[1]!, away: vals[2]! });
        }
      }

      return { homeTeam, awayTeam, bookmakers };
    });

    await page.close();

    if (!data.homeTeam || !data.awayTeam) return null;

    // Calculate average odds
    let avgHome = 0, avgDraw = 0, avgAway = 0;
    if (data.bookmakers.length > 0) {
      avgHome = data.bookmakers.reduce((s, b) => s + b.home, 0) / data.bookmakers.length;
      avgDraw = data.bookmakers.reduce((s, b) => s + b.draw, 0) / data.bookmakers.length;
      avgAway = data.bookmakers.reduce((s, b) => s + b.away, 0) / data.bookmakers.length;
    }

    return {
      url: matchUrl,
      homeTeam: data.homeTeam,
      awayTeam: data.awayTeam,
      league: '',
      date: '',
      time: '',
      odds1x2: data.bookmakers.length > 0
        ? {
            home: Math.round(avgHome * 100) / 100,
            draw: Math.round(avgDraw * 100) / 100,
            away: Math.round(avgAway * 100) / 100,
          }
        : null,
      bookmakers: data.bookmakers,
    };
  } catch (err) {
    logger.error({ err, matchUrl }, 'OddsPortal match scrape failed');
    return null;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch { /* ignore */ }
    }
  }
}

/**
 * Virtual Football Schedule Scraper
 *
 * Scrapes upcoming scheduled virtual football matches from Golden Race
 * (inside Sportybet's virtual page) and returns them with odds + predictions.
 *
 * Uses puppeteer-core with system Chrome.
 */

import fs from 'node:fs';
import type { Browser } from 'puppeteer-core';
import { logger } from '../utils/logger.js';

export interface VirtualMatch {
  country: string;       // "England", "Germany", etc.
  week: number;
  matchNum: number;      // 1-10 within the week
  home: string;          // "BHA", "MUN", etc.
  away: string;
  homeOdds: number;
  drawOdds: number;
  awayOdds: number;
  startsAt: string | null; // "01:35" or similar
  status: string;        // "WAITING", "NOW", "WATCH"
}

export interface VirtualPrediction extends VirtualMatch {
  predictedOutcome: '1' | 'X' | '2';
  confidence: number;     // 0-100
  valuePick: string | null;  // "1", "X", "2" if odds offer value vs prediction
  valueEdge: number | null;
  homeWinProb: number;
  drawProb: number;
  awayWinProb: number;
}

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
];

function findChrome(): string | null {
  for (const p of CHROME_PATHS) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

// No cache — virtual games rotate every ~3 min, data must be fresh
export let lastScanTime = 0;

/**
 * Parse the text output from the Golden Race scheduled page into matches.
 */
function parseScheduleText(text: string): VirtualMatch[] {
  const matches: VirtualMatch[] = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  let currentCountry = '';
  let currentWeek = 0;
  let currentTime = '';
  let currentStatus = 'WAITING';
  let matchNum = 0;
  let inOddsSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Detect "Football League: {Country} Week {N}" header
    const headerMatch = line.match(/Football League:\s*(\w+)\s+Week\s+(\d+)/i);
    if (headerMatch) {
      currentCountry = headerMatch[1]!;
      currentWeek = parseInt(headerMatch[2]!);
      matchNum = 0;
      inOddsSection = false;
      continue;
    }

    // Detect country + week in separate lines: "England\nWeek 9"
    const countryMatch = line.match(/^(England|Germany|Italy|France|Spain|Turkey)$/);
    if (countryMatch) {
      const nextLine = lines[i + 1] || '';
      const weekMatch = nextLine.match(/Week\s+(\d+)/i);
      if (weekMatch) {
        currentCountry = countryMatch[1]!;
        currentWeek = parseInt(weekMatch[1]!);
        matchNum = 0;
        i++; // skip the week line
      }
      continue;
    }

    // Detect time like "01:35" or "00:35"
    const timeMatch = line.match(/^(\d{2}:\d{2})$/);
    if (timeMatch) {
      currentTime = timeMatch[1]!;
      continue;
    }

    // Detect status
    if (/^(WAITING|NOW|WATCH)$/.test(line)) {
      currentStatus = line;
      continue;
    }

    // Detect "HOME DRAW AWAY" header — next lines are odds
    if (line === 'HOME' || line === 'HOME\tDRAW\tAWAY' || /^HOME\s+DRAW\s+AWAY$/i.test(line)) {
      inOddsSection = true;
      continue;
    }

    // Detect match line: "1. BHA - LEE 1 1.90 X 3.66 2 3.94"
    // Or split across lines: "1.\nBHA\n-\nLEE\n1\n1.90\nX\n3.66\n2\n3.94"
    const matchLine = line.match(/^(\d{1,2})\.\s*$/);
    if (matchLine && currentCountry && inOddsSection) {
      // Match data split across lines
      const num = parseInt(matchLine[1]!);
      // Look ahead for: home - away odds
      const remaining = lines.slice(i + 1, i + 10).join(' ');
      const oddsMatch = remaining.match(/([A-Z]{3})\s*-\s*([A-Z]{3})\s*1\s*([\d.]+)\s*X\s*([\d.]+)\s*2\s*([\d.]+)/);
      if (oddsMatch) {
        matchNum++;
        matches.push({
          country: currentCountry,
          week: currentWeek,
          matchNum: num,
          home: oddsMatch[1]!,
          away: oddsMatch[2]!,
          homeOdds: parseFloat(oddsMatch[3]!),
          drawOdds: parseFloat(oddsMatch[4]!),
          awayOdds: parseFloat(oddsMatch[5]!),
          startsAt: currentTime || null,
          status: currentStatus,
        });
      }
      continue;
    }

    // Single-line match: "1.  BHA - LEE 1 1.90 X 3.66 2 3.94"
    const singleMatch = line.match(/(\d{1,2})\.\s+([A-Z]{3})\s*-\s*([A-Z]{3})\s+1\s+([\d.]+)\s+X\s+([\d.]+)\s+2\s+([\d.]+)/);
    if (singleMatch && currentCountry) {
      matches.push({
        country: currentCountry,
        week: currentWeek,
        matchNum: parseInt(singleMatch[1]!),
        home: singleMatch[2]!,
        away: singleMatch[3]!,
        homeOdds: parseFloat(singleMatch[4]!),
        drawOdds: parseFloat(singleMatch[5]!),
        awayOdds: parseFloat(singleMatch[6]!),
        startsAt: currentTime || null,
        status: currentStatus,
      });
      continue;
    }
  }

  return matches;
}

/**
 * Scrape upcoming scheduled virtual football matches.
 */
export async function scrapeVirtualSchedule(): Promise<VirtualMatch[]> {
  const chromePath = findChrome();
  if (!chromePath) {
    logger.debug('Virtual schedule scraper skipped — no Chrome');
    return [];
  }

  let browser: Browser | null = null;
  try {
    const puppeteer = await import('puppeteer-core');
    browser = await puppeteer.default.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    await page.goto('https://www.sportybet.com/gh/virtual', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));

    // Navigate to Football League > Upcoming in the Golden Race iframe
    let matchText = '';
    for (const frame of page.frames()) {
      if (!frame.url().includes('virtustec')) continue;
      try {
        await frame.evaluate(() => {
          window.location.hash = '/scheduled/league/upcoming';
        });
        await new Promise(r => setTimeout(r, 5000));
        matchText = await frame.evaluate(() => document.body.innerText);
      } catch (e) {
        logger.warn({ err: e }, 'Failed to navigate virtual iframe');
      }
    }

    await browser.close();
    browser = null;

    const matches = parseScheduleText(matchText);
    lastScanTime = Date.now();

    logger.info({ count: matches.length, countries: [...new Set(matches.map(m => m.country))].length }, 'Virtual schedule scraped');
    return matches;
  } catch (err) {
    logger.warn({ err }, 'Virtual schedule scrape failed');
    return [];
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

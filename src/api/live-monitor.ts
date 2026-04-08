/**
 * Live Match Monitor
 *
 * Scrapes FlashScore for live match statistics every 60 seconds.
 * Detects "Big Chance" signals: rising xG, shot pressure, dominance.
 * No API key needed — uses puppeteer to scrape FlashScore.
 */

import fs from 'node:fs';
import type { Browser } from 'puppeteer-core';
import { logger } from '../utils/logger.js';

// =========================================================================
// Types
// =========================================================================

export interface LiveMatch {
  id: string;              // FlashScore match ID (e.g., "nJ3WxRrQ")
  home: string;
  away: string;
  score: string;           // "2 - 1"
  time: string;            // "67'" or "HT" or "45+2'"
  league: string;
  status: 'live' | 'ht' | 'finished';
}

export interface LiveMatchStats extends LiveMatch {
  xgHome: number | null;
  xgAway: number | null;
  possession: [number, number] | null;   // [home%, away%]
  shotsHome: number;
  shotsAway: number;
  shotsOnTargetHome: number;
  shotsOnTargetAway: number;
  bigChancesHome: number;
  bigChancesAway: number;
  cornersHome: number;
  cornersAway: number;
  dangerousAttacksHome: number;
  dangerousAttacksAway: number;
}

export interface LiveSignal {
  matchId: string;
  home: string;
  away: string;
  score: string;
  time: string;
  league: string;
  signal: 'big_chance' | 'goal_likely' | 'pressure' | 'domination';
  side: 'home' | 'away';
  strength: number;        // 1-10
  reason: string;
  stats: LiveMatchStats;
}

// =========================================================================
// Chrome
// =========================================================================

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

// =========================================================================
// State
// =========================================================================

let liveData: LiveMatchStats[] = [];
let signals: LiveSignal[] = [];
let lastScrapeTime = 0;
let scraping = false;

// =========================================================================
// Scraper
// =========================================================================

function parseStatValue(text: string): number {
  const n = parseFloat(text.replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : n;
}

/**
 * Scrape all live matches from FlashScore homepage
 */
async function scrapeLiveMatches(browser: Browser): Promise<LiveMatch[]> {
  const page = await browser.newPage();
  try {
    await page.goto('https://www.flashscore.com/', { waitUntil: 'networkidle2', timeout: 20000 });
    await new Promise(r => setTimeout(r, 3000));

    // Click "LIVE" tab to filter live matches
    await page.evaluate(() => {
      document.querySelectorAll('button, a, div').forEach(el => {
        if ((el as HTMLElement).innerText?.trim() === 'LIVE') (el as HTMLElement).click();
      });
    });
    await new Promise(r => setTimeout(r, 2000));

    const matches = await page.evaluate(() => {
      const results: any[] = [];
      let currentLeague = '';

      document.querySelectorAll('[id^="g_1_"]').forEach(el => {
        const id = el.id.replace('g_1_', '');
        const text = (el as HTMLElement).innerText || '';
        const lines = text.split('\n').map((s: string) => s.trim()).filter(Boolean);

        // Get league from parent section
        const section = el.closest('[class*=event__round], [class*=leagues]');
        if (section) {
          const leagueEl = section.querySelector('[class*=event__title]');
          if (leagueEl) currentLeague = (leagueEl as HTMLElement).innerText?.trim() || '';
        }

        if (lines.length < 2) return;

        // Detect if live (has time indicator)
        const timeLine = lines.find((l: string) => /^\d+['′]$|^HT$|^\d+\+\d+['′]?$/.test(l));
        const scoreLine = lines.find((l: string) => /^\d+\s*-\s*\d+$/.test(l));
        if (!timeLine && !scoreLine) return; // Not live

        // Extract teams (first and last non-score, non-time entries)
        const teams = lines.filter((l: string) => !(/^\d+\s*-\s*\d+$/.test(l)) && !(/^\d+['′]$|^HT$|^\d+\+/.test(l)));
        const home = teams[0] || '';
        const away = teams[teams.length - 1] || '';
        if (!home || !away || home === away) return;

        const status = timeLine === 'HT' ? 'ht' : 'live';
        results.push({ id, home, away, score: scoreLine || '0 - 0', time: timeLine || '', league: currentLeague, status });
      });

      return results;
    });

    return matches;
  } finally {
    await page.close();
  }
}

/**
 * Get detailed stats for a specific match
 */
async function scrapeMatchStats(browser: Browser, matchId: string): Promise<Partial<LiveMatchStats>> {
  const page = await browser.newPage();
  try {
    await page.goto(`https://www.flashscore.com/match/${matchId}/#/match-summary/match-statistics/0`,
      { waitUntil: 'networkidle2', timeout: 15000 });
    await new Promise(r => setTimeout(r, 2000));

    const statsText = await page.evaluate(() => {
      const body = document.body.innerText;
      const idx = body.indexOf('Expected Goals') || body.indexOf('Ball Possession') || body.indexOf('Total Shots');
      if (idx > 0) return body.slice(idx, idx + 1500);
      return '';
    });

    if (!statsText) return {};

    const lines = statsText.split('\n').map(l => l.trim()).filter(Boolean);
    const stats: Record<string, [string, string]> = {};

    // Parse "value1 \n StatName \n value2" pattern
    for (let i = 0; i < lines.length - 2; i++) {
      const name = lines[i + 1]!;
      if (/[a-zA-Z]/.test(name) && name.length > 3 && name.length < 40) {
        const home = lines[i]!;
        const away = lines[i + 2]!;
        if (/[\d%.]/.test(home) && /[\d%.]/.test(away)) {
          stats[name.toLowerCase()] = [home, away];
        }
      }
    }

    return {
      xgHome: stats['expected goals (xg)'] ? parseStatValue(stats['expected goals (xg)'][0]!) : null,
      xgAway: stats['expected goals (xg)'] ? parseStatValue(stats['expected goals (xg)'][1]!) : null,
      possession: stats['ball possession'] ? [parseStatValue(stats['ball possession'][0]!), parseStatValue(stats['ball possession'][1]!)] : null,
      shotsHome: parseStatValue(stats['total shots']?.[0] || '0'),
      shotsAway: parseStatValue(stats['total shots']?.[1] || '0'),
      shotsOnTargetHome: parseStatValue(stats['shots on target']?.[0] || '0'),
      shotsOnTargetAway: parseStatValue(stats['shots on target']?.[1] || '0'),
      bigChancesHome: parseStatValue(stats['big chances']?.[0] || '0'),
      bigChancesAway: parseStatValue(stats['big chances']?.[1] || '0'),
      cornersHome: parseStatValue(stats['corner kicks']?.[0] || stats['corners']?.[0] || '0'),
      cornersAway: parseStatValue(stats['corner kicks']?.[1] || stats['corners']?.[1] || '0'),
      dangerousAttacksHome: parseStatValue(stats['touches in opposition box']?.[0] || stats['dangerous attacks']?.[0] || '0'),
      dangerousAttacksAway: parseStatValue(stats['touches in opposition box']?.[1] || stats['dangerous attacks']?.[1] || '0'),
    };
  } catch {
    return {};
  } finally {
    await page.close();
  }
}

// =========================================================================
// Signal Detection
// =========================================================================

function detectSignals(match: LiveMatchStats, prev?: LiveMatchStats): LiveSignal[] {
  const sigs: LiveSignal[] = [];

  function addSignal(side: 'home' | 'away', signal: LiveSignal['signal'], strength: number, reason: string) {
    sigs.push({
      matchId: match.id, home: match.home, away: match.away,
      score: match.score, time: match.time, league: match.league,
      signal, side, strength: Math.min(10, Math.max(1, Math.round(strength))),
      reason, stats: match,
    });
  }

  // Big Chances detected
  if (match.bigChancesHome >= 2) addSignal('home', 'big_chance', Math.min(10, match.bigChancesHome * 3), `${match.home} has ${match.bigChancesHome} big chances`);
  if (match.bigChancesAway >= 2) addSignal('away', 'big_chance', Math.min(10, match.bigChancesAway * 3), `${match.away} has ${match.bigChancesAway} big chances`);

  // xG domination (one team xG >> other)
  if (match.xgHome !== null && match.xgAway !== null) {
    if (match.xgHome >= 1.5 && match.xgHome > match.xgAway * 2) {
      addSignal('home', 'goal_likely', Math.min(10, Math.round(match.xgHome * 3)), `${match.home} xG ${match.xgHome.toFixed(2)} — goal overdue`);
    }
    if (match.xgAway >= 1.5 && match.xgAway > match.xgHome * 2) {
      addSignal('away', 'goal_likely', Math.min(10, Math.round(match.xgAway * 3)), `${match.away} xG ${match.xgAway.toFixed(2)} — goal overdue`);
    }
  }

  // Shot pressure (10+ shots, 60%+ on target)
  if (match.shotsHome >= 10 && match.shotsOnTargetHome >= 5) {
    addSignal('home', 'pressure', Math.min(10, match.shotsOnTargetHome), `${match.home}: ${match.shotsOnTargetHome} shots on target from ${match.shotsHome} total`);
  }
  if (match.shotsAway >= 10 && match.shotsOnTargetAway >= 5) {
    addSignal('away', 'pressure', Math.min(10, match.shotsOnTargetAway), `${match.away}: ${match.shotsOnTargetAway} shots on target from ${match.shotsAway} total`);
  }

  // Domination (70%+ possession + shots advantage)
  if (match.possession) {
    if (match.possession[0] >= 65 && match.shotsHome > match.shotsAway * 1.5) {
      addSignal('home', 'domination', 7, `${match.home} dominating: ${match.possession[0]}% possession, ${match.shotsHome} shots`);
    }
    if (match.possession[1] >= 65 && match.shotsAway > match.shotsHome * 1.5) {
      addSignal('away', 'domination', 7, `${match.away} dominating: ${match.possession[1]}% possession, ${match.shotsAway} shots`);
    }
  }

  // Rising xG (compare with previous scrape)
  if (prev && match.xgHome !== null && prev.xgHome !== null) {
    const homeRise = match.xgHome - prev.xgHome;
    const awayRise = (match.xgAway || 0) - (prev.xgAway || 0);
    if (homeRise >= 0.5) addSignal('home', 'goal_likely', Math.min(10, Math.round(homeRise * 5)), `${match.home} xG surging +${homeRise.toFixed(2)} since last check`);
    if (awayRise >= 0.5) addSignal('away', 'goal_likely', Math.min(10, Math.round(awayRise * 5)), `${match.away} xG surging +${awayRise.toFixed(2)} since last check`);
  }

  return sigs;
}

// =========================================================================
// Public API
// =========================================================================

/**
 * Scrape live matches and detect signals.
 * Returns current live data + signals.
 */
export async function scrapeLiveMonitor(): Promise<{ matches: LiveMatchStats[]; signals: LiveSignal[]; scrapedAt: number }> {
  if (scraping) {
    return { matches: liveData, signals, scrapedAt: lastScrapeTime };
  }

  const chromePath = findChrome();
  if (!chromePath) {
    logger.debug('Live monitor skipped — no Chrome');
    return { matches: [], signals: [], scrapedAt: 0 };
  }

  scraping = true;
  let browser: Browser | null = null;

  try {
    const puppeteer = await import('puppeteer-core');
    browser = await puppeteer.default.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });

    // 1. Get all live matches
    const liveMatches = await scrapeLiveMatches(browser);
    logger.info({ count: liveMatches.length }, 'Live matches found');

    if (!liveMatches.length) {
      liveData = [];
      signals = [];
      lastScrapeTime = Date.now();
      return { matches: [], signals: [], scrapedAt: lastScrapeTime };
    }

    // 2. Get stats for top 10 live matches (limit to avoid timeout)
    const prevData = new Map(liveData.map(m => [m.id, m]));
    const newData: LiveMatchStats[] = [];
    const newSignals: LiveSignal[] = [];

    // Scrape stats in batches of 3
    for (let i = 0; i < Math.min(liveMatches.length, 10); i += 3) {
      const batch = liveMatches.slice(i, i + 3);
      const results = await Promise.allSettled(
        batch.map(m => scrapeMatchStats(browser!, m.id)),
      );

      for (let j = 0; j < batch.length; j++) {
        const match = batch[j]!;
        const statsResult = results[j];
        const stats = statsResult?.status === 'fulfilled' ? statsResult.value : {};

        const full: LiveMatchStats = {
          ...match,
          xgHome: stats.xgHome ?? null,
          xgAway: stats.xgAway ?? null,
          possession: stats.possession ?? null,
          shotsHome: stats.shotsHome ?? 0,
          shotsAway: stats.shotsAway ?? 0,
          shotsOnTargetHome: stats.shotsOnTargetHome ?? 0,
          shotsOnTargetAway: stats.shotsOnTargetAway ?? 0,
          bigChancesHome: stats.bigChancesHome ?? 0,
          bigChancesAway: stats.bigChancesAway ?? 0,
          cornersHome: stats.cornersHome ?? 0,
          cornersAway: stats.cornersAway ?? 0,
          dangerousAttacksHome: stats.dangerousAttacksHome ?? 0,
          dangerousAttacksAway: stats.dangerousAttacksAway ?? 0,
        };

        newData.push(full);

        // Detect signals
        const prev = prevData.get(match.id);
        const matchSignals = detectSignals(full, prev);
        newSignals.push(...matchSignals);
      }
    }

    // Also include live matches without stats
    for (const m of liveMatches.slice(10)) {
      newData.push({
        ...m,
        xgHome: null, xgAway: null, possession: null,
        shotsHome: 0, shotsAway: 0, shotsOnTargetHome: 0, shotsOnTargetAway: 0,
        bigChancesHome: 0, bigChancesAway: 0, cornersHome: 0, cornersAway: 0,
        dangerousAttacksHome: 0, dangerousAttacksAway: 0,
      });
    }

    liveData = newData;
    signals = newSignals.sort((a, b) => b.strength - a.strength);
    lastScrapeTime = Date.now();

    logger.info({ matches: newData.length, signals: newSignals.length }, 'Live monitor updated');

    return { matches: liveData, signals, scrapedAt: lastScrapeTime };
  } catch (err) {
    logger.warn({ err }, 'Live monitor scrape failed');
    return { matches: liveData, signals, scrapedAt: lastScrapeTime };
  } finally {
    if (browser) try { await browser.close(); } catch {}
    scraping = false;
  }
}

/**
 * Get cached live data without scraping.
 */
export function getLiveData() {
  return { matches: liveData, signals, scrapedAt: lastScrapeTime };
}

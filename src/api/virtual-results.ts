/**
 * Virtual Football Results Collector & Stats Engine
 *
 * Scrapes historical results from Golden Race's Results History page,
 * stores them in a JSONL file, and computes per-team stats for predictions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'puppeteer-core';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const RESULTS_FILE = path.join(DATA_DIR, 'virtual-results.jsonl');

// ===== TYPES =====

export interface VirtualResult {
  eventId: string;
  country: string;     // "England"
  week: number;
  date: string;        // "02/04/2026 19:31"
  home: string;        // "SUN"
  away: string;        // "MCI"
  homeGoals: number;
  awayGoals: number;
  scrapedAt: string;   // ISO timestamp
}

export interface TeamStats {
  team: string;
  country: string;
  played: number;
  homeWins: number;
  homeLosses: number;
  homeDraws: number;
  awayWins: number;
  awayLosses: number;
  awayDraws: number;
  goalsScored: number;
  goalsConceded: number;
  homeGoalsScored: number;
  homeGoalsConceded: number;
  awayGoalsScored: number;
  awayGoalsConceded: number;
  overRate: number;      // % games with 3+ total goals
  ggRate: number;        // % games both teams scored
  cleanSheetRate: number;
  form: string;          // last 10: W/D/L
  homeWinRate: number;
  awayWinRate: number;
  avgGoalsScored: number;
  avgGoalsConceded: number;
}

export interface MatchPrediction {
  home: string;
  away: string;
  country: string;
  predictedOutcome: '1' | 'X' | '2';
  confidence: number;      // 0-100
  homeWinProb: number;
  drawProb: number;
  awayWinProb: number;
  overProb: number;        // Over 2.5
  ggProb: number;          // Both teams score
  homeForm: string;
  awayForm: string;
  h2h: { played: number; homeWins: number; draws: number; awayWins: number };
}

// ===== STORAGE =====

const knownEventIds = new Set<string>();
let allResults: VirtualResult[] = [];

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadResults(): void {
  ensureDataDir();
  if (!fs.existsSync(RESULTS_FILE)) return;

  const lines = fs.readFileSync(RESULTS_FILE, 'utf-8').split('\n').filter(Boolean);
  allResults = [];
  knownEventIds.clear();

  for (const line of lines) {
    try {
      const r = JSON.parse(line) as VirtualResult;
      if (r.eventId && !knownEventIds.has(r.eventId)) {
        knownEventIds.add(r.eventId);
        allResults.push(r);
      }
    } catch {
      // skip malformed lines
    }
  }
  logger.info({ count: allResults.length }, 'Virtual results loaded from disk');
}

function appendResults(results: VirtualResult[]): void {
  ensureDataDir();
  const newResults = results.filter((r) => !knownEventIds.has(r.eventId));
  if (newResults.length === 0) return;

  const lines = newResults.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(RESULTS_FILE, lines);

  for (const r of newResults) {
    knownEventIds.add(r.eventId);
    allResults.push(r);
  }
  logger.info({ new: newResults.length, total: allResults.length }, 'Virtual results appended');
}

// ===== SCRAPING =====

// Reuse the browser from virtual-scraper.ts
let getBrowserFn: (() => Promise<Browser>) | null = null;

export function setBrowserProvider(fn: () => Promise<Browser>): void {
  getBrowserFn = fn;
}

export async function scrapeResults(): Promise<VirtualResult[]> {
  if (!getBrowserFn) {
    logger.warn('No browser provider set for virtual results scraper');
    return [];
  }

  const startTime = Date.now();
  let page: Awaited<ReturnType<Browser['newPage']>> | null = null;

  try {
    const browser = await getBrowserFn();
    page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    );
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) req.abort();
      else req.continue();
    });

    await page.goto('https://www.sportybet.com/gh/virtual/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await new Promise((r) => setTimeout(r, 15000));

    const grFrame = page.frames().find(
      (f) => f.url().includes('virtustec.com') || f.url().includes('golden-race'),
    );
    if (!grFrame) {
      logger.warn('Virtual results: GR iframe not found');
      return [];
    }

    // Click Football League to expand, then Results History
    await grFrame.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      links.find((el) => el.textContent?.trim() === 'Football League')?.click();
    });
    await new Promise((r) => setTimeout(r, 1000));

    await grFrame.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      links.find((el) => el.textContent?.trim() === 'Results History')?.click();
    });
    await new Promise((r) => setTimeout(r, 5000));

    // Click "Load more" a few times to get more history
    for (let i = 0; i < 5; i++) {
      const hasMore = await grFrame.evaluate(() => {
        const el = Array.from(document.querySelectorAll('div, a, button'))
          .find((e) => (e.textContent || '').trim().toLowerCase() === 'load more events');
        if (el) {
          (el as HTMLElement).click();
          return true;
        }
        return false;
      });
      if (!hasMore) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Extract all results
    const raw = await grFrame.evaluate(() => {
      const containers = Array.from(document.querySelectorAll('.history-container'));
      const data: Array<{
        country: string;
        week: number;
        date: string;
        matches: Array<{
          eventId: string;
          home: string;
          away: string;
          score: string;
        }>;
      }> = [];

      for (const c of containers) {
        const game = c.querySelector('.event-block-game')?.textContent?.trim() || '';
        if (!game.toLowerCase().includes('football')) continue;

        const name = c.querySelector('.event-block-name')?.textContent?.trim() || '';
        const headText = (c.querySelector('.panel-heading')?.textContent || '').replace(/\s+/g, ' ').trim();
        const weekMatch = headText.match(/Week\s+(\d+)/i);
        const dateMatch = headText.match(/(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/);
        const week = weekMatch ? parseInt(weekMatch[1]!) : 0;
        const dateStr = dateMatch ? dateMatch[1]! : '';

        const blocks = c.querySelectorAll('.football-event-block');
        const matches: Array<{ eventId: string; home: string; away: string; score: string }> = [];

        for (const block of Array.from(blocks)) {
          const eventId = block.querySelector('.event-id')?.textContent?.trim() || '';
          const home = block.querySelector('.teamA .team-name')?.textContent?.trim() || '';
          const away = block.querySelector('.teamB .team-name')?.textContent?.trim() || '';
          const score = (block.querySelector('.match-result-score')?.textContent || '').replace(/\s+/g, '').trim();
          if (home && away && score && eventId) {
            matches.push({ eventId, home, away, score });
          }
        }

        if (matches.length > 0) {
          data.push({ country: name, week, date: dateStr as string, matches });
        }
      }
      return data;
    });

    // Convert to VirtualResult[]
    const now = new Date().toISOString();
    const results: VirtualResult[] = [];
    for (const block of raw) {
      for (const m of block.matches) {
        const parts = m.score.split(':').map(Number);
        const hg = parts[0] ?? 0;
        const ag = parts[1] ?? 0;
        results.push({
          eventId: m.eventId,
          country: block.country,
          week: block.week,
          date: block.date,
          home: m.home,
          away: m.away,
          homeGoals: isNaN(hg) ? 0 : hg,
          awayGoals: isNaN(ag) ? 0 : ag,
          scrapedAt: now,
        });
      }
    }

    const elapsed = Date.now() - startTime;
    logger.info({ scraped: results.length, elapsed }, 'Virtual results scraped');

    // Persist new results
    appendResults(results);

    return results;
  } catch (err) {
    logger.error({ err }, 'Virtual results scraper error');
    return [];
  } finally {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
  }
}

// ===== STATS ENGINE =====

export function computeStats(country?: string): Map<string, TeamStats> {
  const filtered = country
    ? allResults.filter((r) => r.country.toLowerCase() === country.toLowerCase())
    : allResults;

  const stats = new Map<string, TeamStats>();

  function getOrCreate(team: string, ctry: string): TeamStats {
    const key = `${ctry}:${team}`;
    if (!stats.has(key)) {
      stats.set(key, {
        team, country: ctry, played: 0,
        homeWins: 0, homeLosses: 0, homeDraws: 0,
        awayWins: 0, awayLosses: 0, awayDraws: 0,
        goalsScored: 0, goalsConceded: 0,
        homeGoalsScored: 0, homeGoalsConceded: 0,
        awayGoalsScored: 0, awayGoalsConceded: 0,
        overRate: 0, ggRate: 0, cleanSheetRate: 0,
        form: '', homeWinRate: 0, awayWinRate: 0,
        avgGoalsScored: 0, avgGoalsConceded: 0,
      });
    }
    return stats.get(key)!;
  }

  // Track form (chronological order matters)
  const formMap = new Map<string, string[]>(); // key -> array of W/D/L

  for (const r of filtered) {
    const homeStats = getOrCreate(r.home, r.country);
    const awayStats = getOrCreate(r.away, r.country);
    homeStats.played++;
    awayStats.played++;
    homeStats.goalsScored += r.homeGoals;
    homeStats.goalsConceded += r.awayGoals;
    awayStats.goalsScored += r.awayGoals;
    awayStats.goalsConceded += r.homeGoals;
    homeStats.homeGoalsScored += r.homeGoals;
    homeStats.homeGoalsConceded += r.awayGoals;
    awayStats.awayGoalsScored += r.awayGoals;
    awayStats.awayGoalsConceded += r.homeGoals;

    const hKey = `${r.country}:${r.home}`;
    const aKey = `${r.country}:${r.away}`;
    if (!formMap.has(hKey)) formMap.set(hKey, []);
    if (!formMap.has(aKey)) formMap.set(aKey, []);

    if (r.homeGoals > r.awayGoals) {
      homeStats.homeWins++;
      awayStats.awayLosses++;
      formMap.get(hKey)!.push('W');
      formMap.get(aKey)!.push('L');
    } else if (r.homeGoals < r.awayGoals) {
      homeStats.homeLosses++;
      awayStats.awayWins++;
      formMap.get(hKey)!.push('L');
      formMap.get(aKey)!.push('W');
    } else {
      homeStats.homeDraws++;
      awayStats.awayDraws++;
      formMap.get(hKey)!.push('D');
      formMap.get(aKey)!.push('D');
    }

    if (r.awayGoals === 0) homeStats.cleanSheetRate++;
    if (r.homeGoals === 0) awayStats.cleanSheetRate++;
  }

  // Compute derived stats
  for (const [key, s] of stats) {
    const homeGames = s.homeWins + s.homeLosses + s.homeDraws;
    const awayGames = s.awayWins + s.awayLosses + s.awayDraws;
    s.homeWinRate = homeGames > 0 ? s.homeWins / homeGames : 0;
    s.awayWinRate = awayGames > 0 ? s.awayWins / awayGames : 0;
    s.avgGoalsScored = s.played > 0 ? s.goalsScored / s.played : 0;
    s.avgGoalsConceded = s.played > 0 ? s.goalsConceded / s.played : 0;

    // Over/GG/CS rates need per-game tracking
    const teamResults = filtered.filter((r) =>
      (r.country === s.country) && (r.home === s.team || r.away === s.team),
    );
    const overCount = teamResults.filter((r) => r.homeGoals + r.awayGoals >= 3).length;
    const ggCount = teamResults.filter((r) => r.homeGoals > 0 && r.awayGoals > 0).length;
    s.overRate = s.played > 0 ? overCount / s.played : 0;
    s.ggRate = s.played > 0 ? ggCount / s.played : 0;
    s.cleanSheetRate = s.played > 0 ? s.cleanSheetRate / s.played : 0;

    // Form: last 10
    const form = formMap.get(key) || [];
    s.form = form.slice(-10).join('');

    // Round rates
    s.homeWinRate = Math.round(s.homeWinRate * 100) / 100;
    s.awayWinRate = Math.round(s.awayWinRate * 100) / 100;
    s.overRate = Math.round(s.overRate * 100) / 100;
    s.ggRate = Math.round(s.ggRate * 100) / 100;
    s.cleanSheetRate = Math.round(s.cleanSheetRate * 100) / 100;
    s.avgGoalsScored = Math.round(s.avgGoalsScored * 100) / 100;
    s.avgGoalsConceded = Math.round(s.avgGoalsConceded * 100) / 100;
  }

  return stats;
}

// ===== PREDICTIONS =====

export function predictMatch(home: string, away: string, country: string): MatchPrediction | null {
  const stats = computeStats(country);
  const hKey = `${country}:${home}`;
  const aKey = `${country}:${away}`;
  const hStats = stats.get(hKey);
  const aStats = stats.get(aKey);

  if (!hStats || !aStats || hStats.played < 3 || aStats.played < 3) return null;

  // Head-to-head
  const h2hGames = allResults.filter(
    (r) => r.country === country &&
      ((r.home === home && r.away === away) || (r.home === away && r.away === home)),
  );
  const h2h = { played: h2hGames.length, homeWins: 0, draws: 0, awayWins: 0 };
  for (const g of h2hGames) {
    if (g.home === home) {
      if (g.homeGoals > g.awayGoals) h2h.homeWins++;
      else if (g.homeGoals === g.awayGoals) h2h.draws++;
      else h2h.awayWins++;
    } else {
      if (g.awayGoals > g.homeGoals) h2h.homeWins++;
      else if (g.homeGoals === g.awayGoals) h2h.draws++;
      else h2h.awayWins++;
    }
  }

  // Probability model
  // Home strength = home win rate * attack / opponent defense
  const homeAttack = hStats.homeGoalsScored / Math.max(1, hStats.homeWins + hStats.homeDraws + hStats.homeLosses);
  const awayDefense = aStats.awayGoalsConceded / Math.max(1, aStats.awayWins + aStats.awayDraws + aStats.awayLosses);
  const awayAttack = aStats.awayGoalsScored / Math.max(1, aStats.awayWins + aStats.awayDraws + aStats.awayLosses);
  const homeDefense = hStats.homeGoalsConceded / Math.max(1, hStats.homeWins + hStats.homeDraws + hStats.homeLosses);

  // Expected goals
  const homeXG = (homeAttack + awayDefense) / 2;
  const awayXG = (awayAttack + homeDefense) / 2;

  // Win probabilities (weighted blend of rate-based and xG-based)
  const rateHomeWin = hStats.homeWinRate * 0.6 + (1 - aStats.awayWinRate) * 0.4;
  const rateAwayWin = aStats.awayWinRate * 0.6 + (1 - hStats.homeWinRate) * 0.4;
  // xG-based adjustment
  const xgDiff = homeXG - awayXG;
  let homeWinProb = Math.max(0.05, Math.min(0.85, rateHomeWin + xgDiff * 0.1));
  let awayWinProb = Math.max(0.05, Math.min(0.85, rateAwayWin - xgDiff * 0.1));
  let drawProb = Math.max(0.08, 1 - homeWinProb - awayWinProb);

  // Normalize to sum to 1
  const total = homeWinProb + drawProb + awayWinProb;
  homeWinProb /= total;
  drawProb /= total;
  awayWinProb /= total;

  // H2H adjustment (small weight)
  if (h2h.played >= 2) {
    const h2hHomeRate = h2h.homeWins / h2h.played;
    const h2hAwayRate = h2h.awayWins / h2h.played;
    homeWinProb = homeWinProb * 0.85 + h2hHomeRate * 0.15;
    awayWinProb = awayWinProb * 0.85 + h2hAwayRate * 0.15;
    drawProb = 1 - homeWinProb - awayWinProb;
  }

  // Over 2.5 probability
  const overProb = (hStats.overRate + aStats.overRate) / 2;

  // GG probability
  const ggProb = (hStats.ggRate + aStats.ggRate) / 2;

  // Predicted outcome
  let predictedOutcome: '1' | 'X' | '2' = '1';
  let maxProb = homeWinProb;
  if (drawProb > maxProb) { predictedOutcome = 'X'; maxProb = drawProb; }
  if (awayWinProb > maxProb) { predictedOutcome = '2'; maxProb = awayWinProb; }

  const confidence = Math.round(maxProb * 100);

  return {
    home, away, country,
    predictedOutcome,
    confidence,
    homeWinProb: Math.round(homeWinProb * 100) / 100,
    drawProb: Math.round(drawProb * 100) / 100,
    awayWinProb: Math.round(awayWinProb * 100) / 100,
    overProb: Math.round(overProb * 100) / 100,
    ggProb: Math.round(ggProb * 100) / 100,
    homeForm: hStats.form,
    awayForm: aStats.form,
    h2h,
  };
}

// ===== PUBLIC API =====

export function getResultsCount(): number {
  return allResults.length;
}

export function getRecentResults(country?: string, limit = 50): VirtualResult[] {
  const filtered = country
    ? allResults.filter((r) => r.country.toLowerCase() === country.toLowerCase())
    : allResults;
  return filtered.slice(-limit).reverse();
}

export function getAllStats(): Record<string, TeamStats[]> {
  const stats = computeStats();
  const grouped: Record<string, TeamStats[]> = {};
  for (const s of stats.values()) {
    if (!grouped[s.country]) grouped[s.country] = [];
    grouped[s.country]!.push(s);
  }
  // Sort each country by win rate
  for (const arr of Object.values(grouped)) {
    arr.sort((a, b) => (b.homeWinRate + b.awayWinRate) - (a.homeWinRate + a.awayWinRate));
  }
  return grouped;
}

// Init: load from disk on import
loadResults();

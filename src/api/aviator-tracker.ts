/**
 * Aviator Crash Game Tracker
 *
 * Opens Sportybet Aviator via Puppeteer, scrapes crash multipliers
 * in real-time, tracks history, and detects patterns/signals.
 *
 * Signals:
 * - Streak detection: long run of low (<2x) or high (>5x) crashes
 * - Mean reversion: after many low crashes, a high one is statistically due
 * - Hot zone: recent average multiplier trending up/down
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { logger } from '../utils/logger.js';
import {
  launchBrowser,
  checkLoggedIn,
  autoLogin,
  dismissDialogs,
} from './sportybet-browser.js';

// ── Config ─────────────────────────────────────────────────

// Sportybet Ghana homepage (login first) then navigate to Aviator
const SPORTYBET_HOME = 'https://www.sportybet.com/gh/';
const AVIATOR_URL = 'https://www.sportybet.com/gh/games/aviator';
const HISTORY_FILE = path.join(process.cwd(), 'data', 'aviator_history.json');
const MAX_HISTORY = 500;

// ── Types ──────────────────────────────────────────────────

export interface CrashPoint {
  multiplier: number;
  timestamp: number;
  /**
   * Monotonically increasing synthetic round index. Not the game's real
   * round ID (which lives on Spribe's server), but a local counter we can
   * use to detect gaps and compute coverage. Older entries missing this
   * field are backfilled sequentially on load.
   */
  roundIndex?: number;
  /**
   * True if a gap was detected immediately before this crash was recorded
   * (e.g. we saw the bar skip >1 position between polls, or the overlap
   * detection failed). Use this to filter audit-clean data.
   */
  gapBefore?: boolean;
}

export interface TrackerCoverage {
  /** Total scrape cycles since tracker started */
  totalPolls: number;
  /** Polls where the history bar actually changed */
  barChanges: number;
  /** Rounds we recorded via the clean 1-step shift */
  cleanRecords: number;
  /** Rounds we recorded via the multi-step overlap match (2-6 rounds passed) */
  skipRecords: number;
  /** Rounds we recorded via the "no overlap found" conservative fallback
   *  — these are the suspicious ones, data may be missing around them */
  fallbackRecords: number;
  /** Count of detected gaps (either skip >1 or fallback path taken) */
  gapsDetected: number;
  /** Polls where we saw a shorter/shrinking bar — usually a UI loading state */
  shrinkGuardHits: number;
  /** Polls where the bar had too few entries to diff reliably */
  shortBarGuardHits: number;
  /** Rough coverage %: cleanRecords / (cleanRecords + skipRecords*avgSkip + fallbackRecords*2) */
  coveragePct: number;
  trackerStartedAt: number;
}

export interface AviatorSignal {
  type: 'low_streak' | 'high_due' | 'hot_zone' | 'cold_zone' | 'mega_due';
  message: string;
  strength: number; // 1-10
  suggestedCashout: number; // suggested cashout multiplier
}

export interface PredictionRecord {
  timestamp: number;
  signalType: string;           // which signal was active
  suggestedCashout: number;     // what the system said to cash out at
  actualCrash: number;          // what the round actually crashed at
  wouldHaveWon: boolean;        // actual >= suggestedCashout
  profit: number;               // +cashout-1 if won, -1 if lost (flat $1 bet)
  historySnapshot: number[];    // last 5 crashes before this prediction
}

export interface PredictionAccuracy {
  total: number;
  won: number;
  lost: number;
  winRate: number;
  totalProfit: number;          // cumulative P&L on $1 flat bets
  bySignal: Record<string, { total: number; won: number; lost: number; winRate: number; profit: number }>;
  byCashout: Record<string, { total: number; won: number; lost: number; winRate: number; profit: number }>;
  recent: PredictionRecord[];   // last 30
}

export interface AutoBetConfig {
  enabled: boolean;
  betAmount: number;         // base bet in GHS
  cashoutAt: number;         // auto-cashout multiplier (default 1.5)
  minStreak: number;         // min consecutive <2x rounds before betting (default 2)
  maxBetsPerSession: number; // stop after this many bets (default 30)
  takeProfitPct: number;     // stop if session profit reaches this % (default 20)
  stopLossPct: number;       // stop if session loss reaches this % (default 30)
  cooldownRounds: number;    // skip N rounds after a loss (default 0)
}

export interface AutoBetState {
  active: boolean;
  sessionBets: number;
  sessionWins: number;
  sessionLosses: number;
  sessionProfit: number;     // running P&L in GHS
  startBank: number;         // bankroll at session start
  currentBank: number;       // estimated current bankroll
  lastBetRound: number;      // timestamp of last bet
  lastBetResult: 'win' | 'loss' | 'pending' | null;
  cooldownLeft: number;      // rounds to skip
  stoppedReason: string | null; // why auto-bet stopped (take-profit, stop-loss, max-bets)
  betLog: AutoBetLog[];
}

export interface AutoBetLog {
  timestamp: number;
  betAmount: number;
  cashoutTarget: number;
  crash: number;
  result: 'win' | 'loss';
  profit: number;
  bankAfter: number;
  streak: number;            // how long the low streak was when we bet
}

export interface AviatorState {
  running: boolean;
  connected: boolean;
  history: CrashPoint[];
  signals: AviatorSignal[];
  stats: {
    total: number;
    avg: number;
    median: number;
    above2x: number;
    above5x: number;
    above10x: number;
    lastLowStreak: number;
    recentAvg: number;
  };
  predictionAccuracy: PredictionAccuracy;
  autoBet: AutoBetState;
  autoBetConfig: AutoBetConfig;
  coverage: TrackerCoverage;
  lastUpdate: number;
}

// ── State ──────────────────────────────────────────────────

let history: CrashPoint[] = [];
let predictions: PredictionRecord[] = [];
let pendingSignals: AviatorSignal[] = []; // signals active BEFORE the next crash
let tracking = false;
let aviatorPage: Page | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let lastBar: number[] = []; // previous scrape's full history bar — for dedup

// ── Audit / coverage state ─────────────────────────────────
let nextRoundIndex = 0; // monotonic counter for synthetic round IDs
let coverage: TrackerCoverage = {
  totalPolls: 0,
  barChanges: 0,
  cleanRecords: 0,
  skipRecords: 0,
  fallbackRecords: 0,
  gapsDetected: 0,
  shrinkGuardHits: 0,
  shortBarGuardHits: 0,
  coveragePct: 100,
  trackerStartedAt: 0,
};

// Capture loop tunables
const POLL_INTERVAL_MS = 2000;        // tight enough to catch every round even during transient freezes
const MAX_SKIP_SEARCH = 6;             // recover from up to 6 rounds passed between polls
const MIN_BAR_LENGTH_TO_DIFF = 5;      // below this the scrape is probably mid-transition

function computeCoverage(): void {
  // Rough estimate: "reliable" records = clean + skip (2x weight because a
  // multi-skip means we recorded the new ones but confirm a gap happened).
  // Fallback records penalize coverage because we don't know what we missed.
  const clean = coverage.cleanRecords;
  const skip = coverage.skipRecords;
  const fallback = coverage.fallbackRecords;
  const totalRecorded = clean + skip + fallback;
  if (totalRecorded === 0) {
    coverage.coveragePct = 100;
    return;
  }
  // Fallback records each count as a miss (or potentially-miss)
  const estimatedMissed = fallback;
  coverage.coveragePct = Math.round(
    (totalRecorded / (totalRecorded + estimatedMissed)) * 1000,
  ) / 10;
}

const PREDICTIONS_FILE = path.join(process.cwd(), 'data', 'aviator_predictions.json');
const MAX_PREDICTIONS = 1000;
const AUTOBET_LOG_FILE = path.join(process.cwd(), 'data', 'aviator_autobet.json');

// ── Auto-Bet State ────────────────────────────────────────

let autoBetConfig: AutoBetConfig = {
  enabled: false,
  betAmount: 1,
  cashoutAt: 1.5,
  minStreak: 2,
  maxBetsPerSession: 30,
  takeProfitPct: 20,
  stopLossPct: 30,
  cooldownRounds: 0,
};

let autoBetState: AutoBetState = {
  active: false,
  sessionBets: 0,
  sessionWins: 0,
  sessionLosses: 0,
  sessionProfit: 0,
  startBank: 0,
  currentBank: 0,
  lastBetRound: 0,
  lastBetResult: null,
  cooldownLeft: 0,
  stoppedReason: null,
  betLog: [],
};

let pendingAutoBet = false; // true = we placed a bet, waiting for next crash to settle it

// Load from disk
function loadHistory(): CrashPoint[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return [];
}

function loadPredictions(): PredictionRecord[] {
  try {
    if (fs.existsSync(PREDICTIONS_FILE)) {
      return JSON.parse(fs.readFileSync(PREDICTIONS_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return [];
}

function saveHistory(): void {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-MAX_HISTORY)));
  } catch { /* ignore */ }
}

function savePredictions(): void {
  try {
    fs.mkdirSync(path.dirname(PREDICTIONS_FILE), { recursive: true });
    fs.writeFileSync(PREDICTIONS_FILE, JSON.stringify(predictions.slice(-MAX_PREDICTIONS)));
  } catch { /* ignore */ }
}

/**
 * Record prediction outcomes: compare active signals before the crash
 * against what actually happened.
 */
function recordPrediction(actualCrash: number): void {
  if (pendingSignals.length === 0) return;

  const snapshot = history.slice(-6, -1).map(h => h.multiplier); // last 5 before this one

  for (const sig of pendingSignals) {
    const wouldHaveWon = actualCrash >= sig.suggestedCashout;
    const profit = wouldHaveWon ? (sig.suggestedCashout - 1) : -1; // $1 flat bet

    predictions.push({
      timestamp: Date.now(),
      signalType: sig.type,
      suggestedCashout: sig.suggestedCashout,
      actualCrash,
      wouldHaveWon,
      profit: Math.round(profit * 100) / 100,
      historySnapshot: snapshot,
    });
  }

  if (predictions.length > MAX_PREDICTIONS) predictions = predictions.slice(-MAX_PREDICTIONS);
  savePredictions();

  // Refresh pending signals for next round
  pendingSignals = detectSignals(history);
}

/**
 * Compute prediction accuracy stats.
 */
function computeAccuracy(): PredictionAccuracy {
  const total = predictions.length;
  const won = predictions.filter(p => p.wouldHaveWon).length;
  const lost = total - won;
  const totalProfit = Math.round(predictions.reduce((s, p) => s + p.profit, 0) * 100) / 100;

  // By signal type
  const bySignal: PredictionAccuracy['bySignal'] = {};
  for (const p of predictions) {
    if (!bySignal[p.signalType]) bySignal[p.signalType] = { total: 0, won: 0, lost: 0, winRate: 0, profit: 0 };
    const s = bySignal[p.signalType]!;
    s.total++;
    if (p.wouldHaveWon) s.won++;
    else s.lost++;
    s.profit = Math.round((s.profit + p.profit) * 100) / 100;
    s.winRate = Math.round((s.won / s.total) * 1000) / 10;
  }

  // By cashout target
  const byCashout: PredictionAccuracy['byCashout'] = {};
  for (const p of predictions) {
    const key = p.suggestedCashout + 'x';
    if (!byCashout[key]) byCashout[key] = { total: 0, won: 0, lost: 0, winRate: 0, profit: 0 };
    const s = byCashout[key]!;
    s.total++;
    if (p.wouldHaveWon) s.won++;
    else s.lost++;
    s.profit = Math.round((s.profit + p.profit) * 100) / 100;
    s.winRate = Math.round((s.won / s.total) * 1000) / 10;
  }

  return {
    total,
    won,
    lost,
    winRate: total > 0 ? Math.round((won / total) * 1000) / 10 : 0,
    totalProfit,
    bySignal,
    byCashout,
    recent: predictions.slice(-30).reverse(),
  };
}

// Init — deferred because detectSignals is defined below
history = loadHistory();
predictions = loadPredictions();

// Backfill roundIndex on legacy entries so the audit counter is monotonic
// from day one. Existing data is assumed gapless (we don't know otherwise).
{
  let maxIdx = -1;
  for (const h of history) {
    if (typeof h.roundIndex === 'number') maxIdx = Math.max(maxIdx, h.roundIndex);
  }
  if (maxIdx < 0) {
    history.forEach((h, i) => { h.roundIndex = i; });
    nextRoundIndex = history.length;
  } else {
    // Some already numbered — fill any gaps at the tail
    history.forEach((h, i) => {
      if (typeof h.roundIndex !== 'number') h.roundIndex = maxIdx + 1 + (i - history.findIndex((x) => typeof x.roundIndex !== 'number'));
    });
    nextRoundIndex = maxIdx + 1;
  }
}
// pendingSignals set after detectSignals is defined (see bottom of file)

// ── Ghana Direct Login ─────────────────────────────────────

const SPORTYBET_PHONE = process.env.SPORTYBET_PHONE || '';
const SPORTYBET_PASSWORD = process.env.SPORTYBET_PASSWORD || '';

/**
 * Login directly via the Sportybet Ghana inline header form.
 * The Ghana site shows phone + password inputs in the header bar,
 * not behind a popup button.
 */
async function ghanaDirectLogin(page: Page): Promise<boolean> {
  if (!SPORTYBET_PHONE || !SPORTYBET_PASSWORD) {
    logger.warn('No credentials set (SPORTYBET_PHONE / SPORTYBET_PASSWORD)');
    return false;
  }

  try {
    // Find the phone input — Ghana header shows "+233 Mobile Number"
    const phoneInput = await page.$([
      'input[placeholder*="Mobile"]',
      'input[placeholder*="Phone"]',
      'input[placeholder*="phone"]',
      'input[type="tel"]',
      'input[name="phone"]',
      'input[name="mobile"]',
    ].join(', '));

    if (!phoneInput) {
      logger.warn('Ghana login: phone input not found, trying autoLogin fallback');
      return await autoLogin(page);
    }

    logger.info('Ghana login: found phone input, filling credentials...');

    // Clear and type phone number
    await phoneInput.click({ clickCount: 3 });
    await phoneInput.type(SPORTYBET_PHONE, { delay: 30 });
    await sleep(200);

    // Find password input
    const passInput = await page.$([
      'input[type="password"]',
      'input[placeholder*="Password"]',
      'input[placeholder*="password"]',
      'input[name="password"]',
    ].join(', '));

    if (!passInput) {
      logger.warn('Ghana login: password input not found');
      return false;
    }

    await passInput.click({ clickCount: 3 });
    await passInput.type(SPORTYBET_PASSWORD, { delay: 30 });
    await sleep(200);

    // Find and click the login/submit button
    // Try multiple approaches since Ghana header may have different button styles
    let submitted = false;

    // Approach 1: Look for a submit button near the form
    const submitBtn = await page.$([
      'button[type="submit"]',
      'button.login-btn',
      '[class*="login-btn"]',
      '[class*="af-header"] button',
      'header button',
    ].join(', '));

    if (submitBtn) {
      await submitBtn.click();
      submitted = true;
      logger.info('Ghana login: clicked submit button');
    }

    // Approach 2: Press Enter on the password field
    if (!submitted) {
      await passInput.press('Enter');
      submitted = true;
      logger.info('Ghana login: pressed Enter to submit');
    }

    // Wait for login to complete (check for balance/My Account)
    logger.info('Ghana login: waiting for session...');
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      if (await checkLoggedIn(page)) {
        logger.info('Ghana login: SUCCESS');
        return true;
      }
      // Dismiss any popups that might appear
      if (i % 3 === 2) await dismissDialogs(page);
    }

    logger.warn('Ghana login: timed out after 12s');
    return false;
  } catch (err) {
    logger.error({ err }, 'Ghana login failed');
    return false;
  }
}

// ── Scraping ───────────────────────────────────────────────

/**
 * Scrape crash multipliers from the Aviator game page.
 * Aviator shows recent results as bubbles/badges with multipliers.
 */
async function scrapeMultipliers(page: Page): Promise<number[]> {
  // The Aviator game runs inside iframe#games-lobby (src: sportygames/lobby).
  // The history bar is at: .past-multipliers .coefficient-row .coefficent-value > span
  // We must find and evaluate inside that specific iframe.

  const extract = async (ctx: Page | import('puppeteer-core').Frame): Promise<number[]> => {
    try {
      return await ctx.evaluate(() => {
        const els = Array.from(
          document.querySelectorAll('.past-multipliers .coefficient-row .coefficent-value > span')
        );
        const results: number[] = [];
        for (const el of els) {
          const text = (el as HTMLElement).textContent?.trim() || '';
          const match = text.match(/^(\d+\.?\d*)x$/);
          if (match) {
            const val = parseFloat(match[1]!);
            if (val >= 1 && val < 10000) results.push(val);
          }
        }
        return results;
      });
    } catch {
      return [];
    }
  };

  // Log all available frames for debugging
  const allFrames = page.frames();
  logger.debug(`Aviator scraper: ${allFrames.length} frames available`);
  for (const f of allFrames) {
    logger.debug(`  Frame: ${f.url().slice(0, 80)}`);
  }

  // 1. Try finding the #games-lobby iframe directly
  try {
    const iframeEl = await page.$('#games-lobby');
    if (iframeEl) {
      const frame = await iframeEl.contentFrame();
      if (frame) {
        const results = await extract(frame);
        logger.debug(`Aviator scraper: #games-lobby iframe found, ${results.length} values: [${results.slice(0, 5).join(',')}...]`);
        if (results.length > 0) return results;
      }
    } else {
      logger.debug('Aviator scraper: #games-lobby iframe NOT found on page');
    }
  } catch (err) { logger.debug(`Aviator scraper: #games-lobby error: ${err}`); }

  // 2. Search ALL frames by URL pattern (sportygames/lobby)
  try {
    for (const frame of allFrames) {
      const url = frame.url();
      if (url.includes('sportygames') || url.includes('sporty-hero')) {
        const results = await extract(frame);
        logger.debug(`Aviator scraper: matched frame ${url.slice(0, 60)}, ${results.length} values`);
        if (results.length > 0) return results;
      }
    }
  } catch { /* continue */ }

  // 3. Try all frames as fallback
  try {
    for (const frame of allFrames) {
      const results = await extract(frame);
      if (results.length > 0) {
        logger.debug(`Aviator scraper: fallback frame ${frame.url().slice(0, 60)}, ${results.length} values`);
        return results;
      }
    }
  } catch { /* ignore */ }

  // 4. Try main page as last resort
  logger.debug('Aviator scraper: trying main page as last resort');
  return await extract(page);
}

/**
 * Find and enter the Aviator game iframe.
 * Aviator runs inside a nested iframe (Sportybet → game provider iframe).
 */
async function findAviatorFrame(page: Page): Promise<Page | import('puppeteer-core').Frame> {
  // Wait for iframes to load
  for (let i = 0; i < 10; i++) {
    // Try multiple iframe selectors — Sportybet embeds games in various ways
    const iframeEl = await page.$(
      'iframe[src*="aviator"], iframe[src*="spribe"], iframe[src*="game"], ' +
      'iframe[src*="casino"], iframe[src*="lobby"], iframe#game-iframe, ' +
      'iframe.game-iframe, iframe[id*="game"]'
    );
    if (iframeEl) {
      const frame = await iframeEl.contentFrame();
      if (frame) {
        logger.info('Found Aviator game iframe');
        // Check for nested iframe inside (some providers double-nest)
        await sleep(1000);
        try {
          const inner = await frame.$('iframe');
          if (inner) {
            const innerFrame = await inner.contentFrame();
            if (innerFrame) {
              logger.info('Found nested Aviator iframe');
              return innerFrame;
            }
          }
        } catch { /* use outer frame */ }
        return frame;
      }
    }
    await sleep(800);
  }
  logger.warn('No Aviator iframe found — using page directly');
  return page;
}

/**
 * Open Aviator in the browser (non-headless so user can see + interact).
 */
export async function startAviator(): Promise<{ success: boolean; message: string }> {
  if (tracking && aviatorPage) {
    return { success: true, message: 'Aviator already running' };
  }

  try {
    // Launch visible browser so user can see and interact
    const browser = await launchBrowser(false);
    aviatorPage = (await browser.pages())[0] ?? (await browser.newPage());

    await aviatorPage.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    );

    // Step 1: Go to homepage first to handle login
    await aviatorPage.goto(SPORTYBET_HOME, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await sleep(2000);

    // Step 2: Login — Sportybet Ghana has inline header form (phone + password always visible)
    // Check if login form inputs are visible — that's the definitive "not logged in" signal
    const hasLoginForm = await aviatorPage.evaluate(() => {
      const phoneEl = document.querySelector('input[placeholder*="Mobile"], input[placeholder*="Phone"], input[type="tel"]') as HTMLElement | null;
      const passEl = document.querySelector('input[type="password"]') as HTMLElement | null;
      return !!(phoneEl && phoneEl.offsetHeight > 0 && passEl && passEl.offsetHeight > 0);
    });
    const loggedIn = !hasLoginForm && await checkLoggedIn(aviatorPage);
    logger.info(`Login check: hasLoginForm=${hasLoginForm}, loggedIn=${loggedIn}`);

    if (!loggedIn) {
      logger.info('Attempting direct login on Sportybet Ghana...');
      const loginResult = await ghanaDirectLogin(aviatorPage);
      if (!loginResult) {
        await aviatorPage.goto(AVIATOR_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        return { success: true, message: 'Aviator opened — log in manually in the browser, then click Refresh' };
      }
      await sleep(1000);
    }

    // Step 3: Dismiss any popups
    await dismissDialogs(aviatorPage);

    // Step 4: Navigate to Games lobby (SPA — must use this URL, not /games/aviator)
    logger.info('Navigating to Games lobby...');
    await aviatorPage.goto('https://www.sportybet.com/gh/games?source=TopRibbon', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await sleep(2000);
    await dismissDialogs(aviatorPage);

    // Step 5: Click Aviator — it's the first game card (#game_item19) in the lobby
    logger.info('Looking for Aviator game card...');
    let foundAviator = false;
    try {
      // Aviator is #game_item19 (first game, "POPULAR", ~765 players)
      // Also try clicking the first .list-item as fallback
      const aviatorBtn = await aviatorPage.$('#game_item19') || await aviatorPage.$('.list-item');
      if (aviatorBtn) {
        await aviatorBtn.click();
        foundAviator = true;
        logger.info('Clicked Aviator game card (#game_item19)');
      }
    } catch { /* fallback below */ }

    if (!foundAviator) {
      logger.warn('Aviator card not found — try clicking it manually in the browser');
    }

    // Step 6: Wait for game iframe to appear (instead of blind sleep)
    logger.info('Waiting for Aviator game to load...');
    try {
      await aviatorPage.waitForSelector(
        'iframe[src*="aviator"], iframe[src*="spribe"], iframe[src*="game"], iframe[src*="lobby"], iframe#game-iframe, iframe#games-lobby',
        { timeout: 15000 },
      );
    } catch {
      // Iframe selector didn't match — fall through, findAviatorFrame will retry
      await sleep(3000);
    }
    await dismissDialogs(aviatorPage);

    // Click inside game area to trigger start if needed
    try {
      await aviatorPage.mouse.click(640, 450);
      await sleep(1000);
    } catch { /* ignore */ }

    // Step 7: Find and enter the game iframe
    const target = await findAviatorFrame(aviatorPage);

    tracking = true;

    // Reset coverage counters for this tracking session
    coverage = {
      totalPolls: 0,
      barChanges: 0,
      cleanRecords: 0,
      skipRecords: 0,
      fallbackRecords: 0,
      gapsDetected: 0,
      shrinkGuardHits: 0,
      shortBarGuardHits: 0,
      coveragePct: 100,
      trackerStartedAt: Date.now(),
    };

    // Start polling for crash results
    pollInterval = setInterval(async () => {
      if (!aviatorPage || !tracking) return;
      try {
        coverage.totalPolls++;
        await dismissDialogs(aviatorPage);
        const mults = await scrapeMultipliers(aviatorPage!);
        if (mults.length > 0) {
          // The history bar shows N past crash results (e.g. [1.00, 1.10, 24.46, 12.97, 1.12, 1.15])
          // When a new round ends, a new value appears and the oldest shifts out.
          // We store the ENTIRE previous bar and compare — only the new value(s) at one end are new.

          // Guard 1: too few entries → the game UI is mid-transition or loading.
          // Diffing now would produce phantom records, so skip this tick.
          if (mults.length < MIN_BAR_LENGTH_TO_DIFF) {
            coverage.shortBarGuardHits++;
            return;
          }

          if (!lastBar || lastBar.length === 0) {
            // First scrape — store bar but don't log (we don't know which are new)
            lastBar = [...mults];
            logger.info(`Aviator: initial bar captured (${mults.length} values: ${mults.map(m => m + 'x').join(', ')})`);
          } else {
            // Guard 2: bar shrank → the game UI is in a transient state
            // (loading animation, round-start wipe, etc.). Do not diff —
            // this is the primary hidden bias source on the legacy loop.
            if (mults.length < lastBar.length) {
              coverage.shrinkGuardHits++;
              return;
            }

            // Compare current bar to previous bar
            const curStr = mults.join(',');
            const prevStr = lastBar.join(',');

            if (curStr !== prevStr) {
              coverage.barChanges++;

              // Bar changed — find the new value(s)
              // IMPORTANT: Newest values appear at the START (leftmost) of the bar.
              // The bar shifts right: old [A,B,C,D,E] → new [F,A,B,C,D] means F is new.

              let newValues: number[] = [];
              // Provenance so we can tag recorded crashes correctly for the audit
              let provenance: 'clean' | 'skip' | 'fallback' = 'fallback';

              // Try matching: if old bar's first N-1 values match new bar's last N-1
              // then the first value in new bar is the new crash
              const oldHead = lastBar.slice(0, lastBar.length - 1).join(','); // [A,B,C,D]
              const newTail = mults.slice(1).join(','); // [A,B,C,D]

              if (oldHead === newTail) {
                // Perfect shift — exactly 1 new value at the start
                newValues = [mults[0]!];
                provenance = 'clean';
              } else {
                // Multiple rounds passed or bar restructured
                // Find overlap by checking progressively — up to MAX_SKIP_SEARCH
                // rounds passed between polls (covers transient freezes)
                for (let skip = 1; skip <= Math.min(MAX_SKIP_SEARCH, mults.length); skip++) {
                  const oldCheck = lastBar.slice(0, lastBar.length - skip).join(',');
                  const newCheck = mults.slice(skip).join(',');
                  if (oldCheck === newCheck) {
                    newValues = mults.slice(0, skip);
                    provenance = 'skip';
                    break;
                  }
                }
                // No overlap found — just take the first value as new (conservative)
                if (newValues.length === 0) {
                  newValues = [mults[0]!];
                  provenance = 'fallback';
                }
              }

              // Update coverage counters
              if (provenance === 'clean') {
                coverage.cleanRecords += newValues.length;
              } else if (provenance === 'skip') {
                coverage.skipRecords += newValues.length;
                coverage.gapsDetected++;
              } else {
                coverage.fallbackRecords += newValues.length;
                coverage.gapsDetected++;
              }

              // Record each new crash + settle auto-bets. The FIRST value
              // after a detected gap carries the gapBefore flag so audit
              // tools can strip or downweight post-gap data.
              for (let i = 0; i < newValues.length; i++) {
                const m = newValues[i]!;
                // Settle any pending auto-bet BEFORE recording prediction
                settleAutoBet(m);
                recordPrediction(m);
                history.push({
                  multiplier: m,
                  timestamp: Date.now(),
                  roundIndex: nextRoundIndex++,
                  ...(i === 0 && provenance !== 'clean' ? { gapBefore: true } : {}),
                });
              }

              computeCoverage();

              if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
              saveHistory();
              pendingSignals = detectSignals(history);
              logger.info(
                `Aviator: +${newValues.length} crash(es): ${newValues.map(m => m + 'x').join(', ')} ` +
                `| total ${history.length} | coverage ${coverage.coveragePct}% ` +
                `(clean ${coverage.cleanRecords}, skip ${coverage.skipRecords}, fallback ${coverage.fallbackRecords})`,
              );

              // Auto-bet: check if we should place a bet for the NEXT round
              if (shouldAutoBet() && aviatorPage) {
                const placed = await placeBet(aviatorPage, autoBetConfig.betAmount, autoBetConfig.cashoutAt);
                if (placed) {
                  pendingAutoBet = true;
                  autoBetState.lastBetRound = Date.now();
                  autoBetState.lastBetResult = 'pending';
                  logger.info({ streak: computeStats(history).lastLowStreak }, 'Auto-bet: bet queued for next round');
                }
              }

              // Update stored bar
              lastBar = [...mults];
            }
          }
        }
      } catch (err) {
        logger.debug({ err }, 'Aviator poll error');
      }
    }, POLL_INTERVAL_MS); // Tuned to catch every round even during brief freezes

    logger.info('Aviator tracker started');
    return { success: true, message: 'Aviator opened and tracking' };
  } catch (err) {
    logger.error({ err }, 'Failed to start Aviator');
    return { success: false, message: `Failed: ${err}` };
  }
}

export async function stopAviator(): Promise<void> {
  tracking = false;
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  // Don't close the browser — user might still be using it
  aviatorPage = null;
  saveHistory();
  logger.info('Aviator tracker stopped');
}

// ── Auto-Bet Engine ───────────────────────────────────────

function loadAutoBetLog(): AutoBetLog[] {
  try {
    if (fs.existsSync(AUTOBET_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(AUTOBET_LOG_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return [];
}

function saveAutoBetLog(): void {
  try {
    fs.mkdirSync(path.dirname(AUTOBET_LOG_FILE), { recursive: true });
    fs.writeFileSync(AUTOBET_LOG_FILE, JSON.stringify(autoBetState.betLog.slice(-500)));
  } catch { /* ignore */ }
}

/**
 * Place a bet in the Aviator game via Puppeteer.
 * Finds the bet input + auto-cashout input inside the game iframe,
 * sets values, and clicks BET.
 */
async function placeBet(page: Page, amount: number, autoCashout: number): Promise<boolean> {
  try {
    // Aviator (Spribe) runs inside a nested iframe structure.
    // We need to find the game frame and interact with its DOM.
    const frames = page.frames();
    let gameFrame: import('puppeteer-core').Frame | null = null;

    for (const frame of frames) {
      const url = frame.url();
      if (url.includes('spribe') || url.includes('aviator') || url.includes('sportygames')) {
        gameFrame = frame;
        break;
      }
    }

    const ctx = gameFrame || page;

    // Set the bet via evaluate — Aviator's React/canvas UI varies,
    // so we use multiple selector strategies
    const placed = await ctx.evaluate((amt: number, cashout: number) => {
      // Strategy 1: Standard Spribe Aviator selectors
      // Bet amount input
      const betInputs = Array.from(document.querySelectorAll<HTMLInputElement>(
        'input[data-testid="betInput"], input.bet-input, ' +
        'input[class*="amount"], input[class*="stake"], ' +
        'input[type="number"]'
      ));

      let betInput: HTMLInputElement | null = null;
      for (const inp of betInputs) {
        if (inp.offsetHeight > 0) { betInput = inp; break; }
      }

      if (betInput) {
        // Set value via native setter to trigger React state update
        const nativeSet = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype, 'value'
        )?.set;
        if (nativeSet) {
          nativeSet.call(betInput, String(amt));
          betInput.dispatchEvent(new Event('input', { bubbles: true }));
          betInput.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          betInput.value = String(amt);
        }
      }

      // Auto-cashout — look for the toggle + input
      const autoCashToggle = document.querySelector<HTMLElement>(
        '[data-testid="autoCashout"], [class*="auto-cashout"] input[type="checkbox"], ' +
        '[class*="cashout"] .switch, [class*="cashout"] input[type="checkbox"]'
      );
      if (autoCashToggle) {
        // Enable if not already checked
        const isCheckbox = autoCashToggle instanceof HTMLInputElement && autoCashToggle.type === 'checkbox';
        if (isCheckbox && !autoCashToggle.checked) {
          autoCashToggle.click();
        } else if (!isCheckbox) {
          autoCashToggle.click(); // toggle switch
        }
      }

      // Set auto-cashout value
      const cashoutInputs = Array.from(document.querySelectorAll<HTMLInputElement>(
        'input[data-testid="autoCashoutInput"], [class*="cashout"] input[type="number"], ' +
        '[class*="cashout"] input[type="text"], [class*="auto"] input'
      ));
      for (const inp of cashoutInputs) {
        if (inp.offsetHeight > 0 && inp !== betInput) {
          const nativeSet2 = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype, 'value'
          )?.set;
          if (nativeSet2) {
            nativeSet2.call(inp, String(cashout));
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
          }
          break;
        }
      }

      // Click BET button
      const betBtns = Array.from(document.querySelectorAll<HTMLElement>(
        'button[data-testid="betButton"], button.bet-button, ' +
        'button[class*="bet"], button[class*="place"], ' +
        'button.btn-green, button.btn-success'
      ));
      for (const btn of betBtns) {
        const text = btn.textContent?.toLowerCase() || '';
        if (btn.offsetHeight > 0 && (text.includes('bet') || text.includes('place'))) {
          btn.click();
          return true;
        }
      }

      return false;
    }, amount, autoCashout);

    if (placed) {
      logger.info({ amount, autoCashout }, 'Auto-bet: bet placed');
    } else {
      logger.warn('Auto-bet: could not find/click bet button');
    }

    return placed;
  } catch (err) {
    logger.error({ err }, 'Auto-bet: failed to place bet');
    return false;
  }
}

/**
 * Check if auto-bet should fire this round.
 * Called after each new crash is recorded.
 */
function shouldAutoBet(): boolean {
  if (!autoBetConfig.enabled || !autoBetState.active) return false;
  if (!aviatorPage || !tracking) return false;

  // Check stop conditions
  if (autoBetState.stoppedReason) return false;
  if (autoBetState.sessionBets >= autoBetConfig.maxBetsPerSession) {
    autoBetState.stoppedReason = `Max bets reached (${autoBetConfig.maxBetsPerSession})`;
    autoBetState.active = false;
    return false;
  }

  if (autoBetState.startBank > 0) {
    const profitPct = (autoBetState.sessionProfit / autoBetState.startBank) * 100;
    if (profitPct >= autoBetConfig.takeProfitPct) {
      autoBetState.stoppedReason = `Take profit hit (+${profitPct.toFixed(1)}%)`;
      autoBetState.active = false;
      return false;
    }
    if (profitPct <= -autoBetConfig.stopLossPct) {
      autoBetState.stoppedReason = `Stop loss hit (${profitPct.toFixed(1)}%)`;
      autoBetState.active = false;
      return false;
    }
  }

  // Cooldown after loss
  if (autoBetState.cooldownLeft > 0) {
    autoBetState.cooldownLeft--;
    return false;
  }

  // Check streak condition
  const stats = computeStats(history);
  if (stats.lastLowStreak < autoBetConfig.minStreak) return false;

  return true;
}

/**
 * Settle the pending auto-bet after a crash resolves.
 */
function settleAutoBet(crash: number): void {
  if (!pendingAutoBet) return;
  pendingAutoBet = false;

  const won = crash >= autoBetConfig.cashoutAt;
  const profit = won
    ? autoBetConfig.betAmount * (autoBetConfig.cashoutAt - 1)
    : -autoBetConfig.betAmount;

  autoBetState.sessionBets++;
  autoBetState.sessionProfit = Math.round((autoBetState.sessionProfit + profit) * 100) / 100;
  autoBetState.currentBank = Math.round((autoBetState.currentBank + profit) * 100) / 100;
  autoBetState.lastBetResult = won ? 'win' : 'loss';

  if (won) {
    autoBetState.sessionWins++;
    autoBetState.cooldownLeft = 0;
  } else {
    autoBetState.sessionLosses++;
    autoBetState.cooldownLeft = autoBetConfig.cooldownRounds;
  }

  const stats = computeStats(history);
  autoBetState.betLog.push({
    timestamp: Date.now(),
    betAmount: autoBetConfig.betAmount,
    cashoutTarget: autoBetConfig.cashoutAt,
    crash,
    result: won ? 'win' : 'loss',
    profit: Math.round(profit * 100) / 100,
    bankAfter: autoBetState.currentBank,
    streak: stats.lastLowStreak,
  });

  saveAutoBetLog();

  const emoji = won ? 'WIN' : 'LOSS';
  logger.info(
    { crash, profit: profit.toFixed(2), bank: autoBetState.currentBank, bets: autoBetState.sessionBets },
    `Auto-bet: ${emoji} — crash ${crash}x, cashout ${autoBetConfig.cashoutAt}x, P&L: ${autoBetState.sessionProfit.toFixed(2)}`,
  );
}

// ── Analysis ───────────────────────────────────────────────

function computeStats(hist: CrashPoint[]) {
  if (hist.length === 0) {
    return { total: 0, avg: 0, median: 0, above2x: 0, above5x: 0, above10x: 0, lastLowStreak: 0, recentAvg: 0 };
  }

  const vals = hist.map(h => h.multiplier);
  const sorted = [...vals].sort((a, b) => a - b);
  const avg = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const above2x = Math.round((vals.filter(v => v >= 2).length / vals.length) * 1000) / 10;
  const above5x = Math.round((vals.filter(v => v >= 5).length / vals.length) * 1000) / 10;
  const above10x = Math.round((vals.filter(v => v >= 10).length / vals.length) * 1000) / 10;

  // Current low streak
  let lastLowStreak = 0;
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i]! < 2) lastLowStreak++;
    else break;
  }

  // Recent 10 avg
  const recent = vals.slice(-10);
  const recentAvg = recent.length > 0
    ? Math.round((recent.reduce((a, b) => a + b, 0) / recent.length) * 100) / 100
    : 0;

  return { total: vals.length, avg, median, above2x, above5x, above10x, lastLowStreak, recentAvg };
}

// ── Wilson score interval helpers ──────────────────────────
// Used everywhere we need to gate on "is this edge statistically real?"

function wilsonCI(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function wilsonLower(k: number, n: number): number {
  return wilsonCI(k, n)[0];
}

// ── Adaptive baseline / conditional edge machinery ─────────
//
// SIGNALS v8 — adaptive, statistically gated.
//
// Instead of hardcoded rules, we walk through a set of *candidate* conditions
// and only fire the ones whose conditional win-rate, over a rolling window,
// beats the local baseline by a margin — using the Wilson 95% lower bound,
// not the point estimate. This handles:
//   - Regime drift (baseline recomputed each call)
//   - Small-sample overfitting (Wilson lower bound kills noisy edges)
//   - Signal rot (a rule that worked in March stops firing in April)
//
// See the analysis in data/aviator_history.json: blind 1.2x has a point
// estimate WR of 85% but Wilson lower bound of 83% < break-even, so naive
// flat-1.2x betting is NOT a reliable edge. Adaptive gating catches this.

const BASELINE_WINDOW = 100;  // rolling window for local baseline P(>=target)
const SIGNAL_LOOKBACK = 200;  // rounds of history to estimate conditional WR
const MIN_SAMPLE = 15;        // min conditional occurrences to even consider
const EDGE_MARGIN = 0.03;     // conditional LB must beat baseline LB by ≥3pp

type Predicate = (priorVals: number[]) => boolean;

interface SignalCandidate {
  type: AviatorSignal['type'];
  label: string;
  condition: Predicate;
  target: number;
}

const SIGNAL_CANDIDATES: SignalCandidate[] = [
  {
    type: 'cold_zone',
    label: 'After crash ≥10x',
    condition: (v) => (v[v.length - 1] ?? 0) >= 10,
    target: 2.0,
  },
  {
    type: 'cold_zone',
    label: 'After crash ≥10x (safe)',
    condition: (v) => (v[v.length - 1] ?? 0) >= 10,
    target: 1.5,
  },
  {
    type: 'hot_zone',
    label: 'Hot zone (avg-5 ≥5x)',
    condition: (v) => {
      if (v.length < 5) return false;
      const r = v.slice(-5);
      return r.reduce((a, b) => a + b, 0) / r.length >= 5;
    },
    target: 1.2,
  },
  {
    type: 'hot_zone',
    label: 'Hot zone (avg-5 ≥5x, aggressive)',
    condition: (v) => {
      if (v.length < 5) return false;
      const r = v.slice(-5);
      return r.reduce((a, b) => a + b, 0) / r.length >= 5;
    },
    target: 1.5,
  },
];

interface EdgeEstimate {
  k: number;       // wins
  n: number;       // trials
  wr: number;      // point estimate
  lower: number;   // Wilson 95% lower bound
  upper: number;
}

function baselineEdge(vals: number[], target: number): EdgeEstimate {
  const window = vals.slice(-BASELINE_WINDOW);
  const n = window.length;
  const k = window.filter(v => v >= target).length;
  const [lower, upper] = wilsonCI(k, n);
  return { k, n, wr: n ? k / n : 0, lower, upper };
}

function conditionalEdge(vals: number[], cand: SignalCandidate): EdgeEstimate {
  const lookback = Math.min(SIGNAL_LOOKBACK, vals.length - 1);
  const start = Math.max(10, vals.length - lookback);
  let k = 0, n = 0;
  for (let i = start; i < vals.length; i++) {
    if (cand.condition(vals.slice(0, i))) {
      n++;
      if (vals[i]! >= cand.target) k++;
    }
  }
  const [lower, upper] = wilsonCI(k, n);
  return { k, n, wr: n ? k / n : 0, lower, upper };
}

function detectSignals(hist: CrashPoint[]): AviatorSignal[] {
  if (hist.length < 30) return [];

  const vals = hist.map(h => h.multiplier);
  const signals: AviatorSignal[] = [];

  for (const cand of SIGNAL_CANDIDATES) {
    // Condition must hold right now
    if (!cand.condition(vals)) continue;

    const cond = conditionalEdge(vals, cand);
    if (cond.n < MIN_SAMPLE) continue;

    const base = baselineEdge(vals, cand.target);

    // Edge must clear baseline by the margin, using the LOWER bounds
    // (not point estimates). This kills small-sample noise.
    if (cond.lower < base.lower + EDGE_MARGIN) continue;

    // EV sanity check using the conditional lower bound
    const b = cand.target - 1;
    const evLower = cond.lower * b - (1 - cond.lower);
    if (evLower <= 0) continue;

    // Strength scales with EV lower bound — a real $0.25/bet edge is 8,
    // a marginal $0.03/bet edge is 3.
    const strength = Math.min(10, Math.max(1, Math.round(2 + evLower * 25)));

    signals.push({
      type: cand.type,
      message:
        `${cand.label} → ${cand.target}x | ` +
        `cond ${(cond.wr * 100).toFixed(0)}% [lb ${(cond.lower * 100).toFixed(0)}%] n=${cond.n} ` +
        `vs base ${(base.wr * 100).toFixed(0)}% [lb ${(base.lower * 100).toFixed(0)}%] ` +
        `| EV lb +$${evLower.toFixed(3)}/bet`,
      strength,
      suggestedCashout: cand.target,
    });
  }

  // If multiple candidates survive on the same signal type, keep the
  // strongest (highest EV lower bound). Prevents duplicate alerts from the
  // safe/aggressive variants firing together.
  const byType = new Map<string, AviatorSignal>();
  for (const s of signals) {
    const prev = byType.get(s.type);
    if (!prev || s.strength > prev.strength) byType.set(s.type, s);
  }

  return Array.from(byType.values()).sort((a, b) => b.strength - a.strength);
}

// ── Backtesting ────────────────────────────────────────────

export interface BacktestResult {
  strategy: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;                // point estimate, 0-100
  winRateCI: [number, number];    // Wilson 95% CI, 0-100
  totalProfit: number;
  evPerBet: number;
  evLowerBound: number;           // EV using Wilson lower bound of WR
  breakEvenWR: number;            // required WR to break even, 0-100
}

/**
 * Walk the full history and simulate a strategy. The strategy is given the
 * crash history *up to but not including* round i, and returns either null
 * (skip) or a cashout target. We then settle against vals[i].
 */
export function backtestStrategy(
  name: string,
  strategy: (priorVals: number[]) => number | null,
  hist: CrashPoint[] = history,
): BacktestResult {
  const vals = hist.map(h => h.multiplier);
  let trades = 0, wins = 0, profit = 0, cashoutSum = 0;

  for (let i = 10; i < vals.length; i++) {
    const target = strategy(vals.slice(0, i));
    if (target == null) continue;
    trades++;
    cashoutSum += target;
    if (vals[i]! >= target) {
      wins++;
      profit += target - 1;
    } else {
      profit -= 1;
    }
  }

  const winRate = trades > 0 ? wins / trades : 0;
  const avgCashout = trades > 0 ? cashoutSum / trades : 0;
  const b = avgCashout - 1;
  const [ciLo, ciHi] = wilsonCI(wins, trades);
  const evLower = trades > 0 && b > 0 ? ciLo * b - (1 - ciLo) : 0;

  const r1 = (x: number) => Math.round(x * 1000) / 10;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;

  return {
    strategy: name,
    trades,
    wins,
    losses: trades - wins,
    winRate: r1(winRate),
    winRateCI: [r1(ciLo), r1(ciHi)],
    totalProfit: Math.round(profit * 100) / 100,
    evPerBet: trades > 0 ? r3(profit / trades) : 0,
    evLowerBound: r3(evLower),
    breakEvenWR: avgCashout > 0 ? r1(1 / avgCashout) : 0,
  };
}

/**
 * Backtest the current detectSignals() against the full history, plus a
 * few baseline strategies for comparison.
 */
export function runBacktestSuite(hist: CrashPoint[] = history): BacktestResult[] {
  const liveSignals = (priorVals: number[]): number | null => {
    const priorHist = priorVals.map(v => ({ multiplier: v, timestamp: 0 }));
    const sigs = detectSignals(priorHist);
    if (sigs.length === 0) return null;
    return sigs[0]!.suggestedCashout;
  };

  return [
    backtestStrategy('current detectSignals', liveSignals, hist),
    backtestStrategy('blind 1.2x', () => 1.2, hist),
    backtestStrategy('blind 1.5x', () => 1.5, hist),
    backtestStrategy('after >=10x → 2.0x', (v) => v[v.length - 1]! >= 10 ? 2.0 : null, hist),
    backtestStrategy('after >=5x → 2.0x', (v) => v[v.length - 1]! >= 5 ? 2.0 : null, hist),
    backtestStrategy('hot zone (avg5 >=5) → 1.2x', (v) => {
      const r = v.slice(-5);
      return r.reduce((a, b) => a + b, 0) / r.length >= 5 ? 1.2 : null;
    }, hist),
  ];
}

// ── Public API ─────────────────────────────────────────────

export function getAviatorState(): AviatorState {
  const stats = computeStats(history);
  const signals = detectSignals(history);

  return {
    running: tracking,
    connected: !!(aviatorPage && tracking),
    history: history.slice(-50),
    signals,
    stats,
    predictionAccuracy: computeAccuracy(),
    autoBet: { ...autoBetState, betLog: autoBetState.betLog.slice(-20) },
    autoBetConfig: { ...autoBetConfig },
    coverage: { ...coverage },
    lastUpdate: history.length > 0 ? history[history.length - 1]!.timestamp : 0,
  };
}

/**
 * Compute audit-clean coverage stats from the persisted history file.
 * Counts entries flagged as gapBefore vs clean, and the density of recorded
 * rounds over time. Useful for the analysis scripts to gate their verdicts.
 */
export function getHistoryAudit(): {
  total: number;
  clean: number;
  postGap: number;
  cleanPct: number;
  firstIndex: number | null;
  lastIndex: number | null;
  sequentialGaps: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
} {
  if (history.length === 0) {
    return {
      total: 0, clean: 0, postGap: 0, cleanPct: 100,
      firstIndex: null, lastIndex: null, sequentialGaps: 0,
      firstTimestamp: null, lastTimestamp: null,
    };
  }
  let clean = 0;
  let postGap = 0;
  let sequentialGaps = 0;
  for (let i = 0; i < history.length; i++) {
    const h = history[i]!;
    if (h.gapBefore) postGap++; else clean++;
    if (i > 0) {
      const prev = history[i - 1]!;
      if (
        typeof h.roundIndex === 'number' &&
        typeof prev.roundIndex === 'number' &&
        h.roundIndex - prev.roundIndex !== 1
      ) {
        sequentialGaps++;
      }
    }
  }
  return {
    total: history.length,
    clean,
    postGap,
    cleanPct: Math.round((clean / history.length) * 1000) / 10,
    firstIndex: history[0]!.roundIndex ?? null,
    lastIndex: history[history.length - 1]!.roundIndex ?? null,
    sequentialGaps,
    firstTimestamp: history[0]!.timestamp,
    lastTimestamp: history[history.length - 1]!.timestamp,
  };
}

// ── Auto-Bet Public API ────────────────────────────────────

export function configureAutoBet(config: Partial<AutoBetConfig>): AutoBetConfig {
  autoBetConfig = { ...autoBetConfig, ...config };
  return { ...autoBetConfig };
}

export function startAutoBet(initialBank: number): AutoBetState {
  if (!autoBetConfig.enabled) {
    autoBetConfig.enabled = true;
  }
  autoBetState = {
    active: true,
    sessionBets: 0,
    sessionWins: 0,
    sessionLosses: 0,
    sessionProfit: 0,
    startBank: initialBank,
    currentBank: initialBank,
    lastBetRound: 0,
    lastBetResult: null,
    cooldownLeft: 0,
    stoppedReason: null,
    betLog: loadAutoBetLog(),
  };
  pendingAutoBet = false;
  logger.info({ initialBank, config: autoBetConfig }, 'Auto-bet started');
  return { ...autoBetState };
}

export function stopAutoBet(reason = 'Manually stopped'): AutoBetState {
  autoBetState.active = false;
  autoBetState.stoppedReason = reason;
  autoBetConfig.enabled = false;
  pendingAutoBet = false;
  logger.info({ reason, profit: autoBetState.sessionProfit }, 'Auto-bet stopped');
  return { ...autoBetState };
}

export function getAutoBetState(): AutoBetState {
  return { ...autoBetState, betLog: autoBetState.betLog.slice(-50) };
}

export function getAutoBetConfig(): AutoBetConfig {
  return { ...autoBetConfig };
}

export function getFullHistory(): CrashPoint[] {
  return [...history];
}

export function getPredictions(): PredictionRecord[] {
  return [...predictions];
}

export function clearHistory(): void {
  history = [];
  predictions = [];
  pendingSignals = [];
  saveHistory();
  savePredictions();
}

// ── Deferred Init ──────────────────────────────────────────
pendingSignals = detectSignals(history);

// ── Utility ────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

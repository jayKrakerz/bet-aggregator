/**
 * SportyBet Browser Automation Utilities
 *
 * Ported from sportybet-instantvirtual/src/bot.py (Playwright/Python)
 * to TypeScript/Puppeteer for use with the bet-aggregator.
 *
 * Provides:
 * - Persistent browser profile (session/cookie reuse across restarts)
 * - Auto-login with credentials from environment
 * - Login state detection
 * - Session expiry detection + auto-recovery
 * - Dialog/popup dismissal (promo popups, win splashes, session warnings)
 * - iframe recovery (re-locate after page reload or navigation)
 * - Screen detection (betting / live / results / unknown)
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page, Frame } from 'puppeteer-core';
import { logger } from '../utils/logger.js';

// ── Config ──────────────────────────────────────────────────

const SPORTYBET_PHONE = process.env.SPORTYBET_PHONE || '';
const SPORTYBET_PASSWORD = process.env.SPORTYBET_PASSWORD || '';

const PROFILE_DIR = path.join(process.cwd(), 'data', 'browser_profile');

const SPORTYBET_VIRTUALS_URL =
  'https://www.sportybet.com/gh/sporty-instant-virtuals?from=games';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
];

type ScreenType = 'betting' | 'live' | 'results' | 'unknown';

// ── Browser Launch ──────────────────────────────────────────

function findChrome(): string {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return CHROME_PATHS[0]!;
}

let browserInstance: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

/**
 * Launch (or reuse) a browser with a persistent user-data directory
 * so login cookies survive across restarts.
 */
export async function launchBrowser(
  headless = true,
): Promise<Browser> {
  if (browserInstance?.connected) return browserInstance;
  if (browserLaunchPromise) return browserLaunchPromise;

  browserLaunchPromise = (async () => {
    const puppeteer = await import('puppeteer-core');

    // Ensure profile dir exists
    fs.mkdirSync(PROFILE_DIR, { recursive: true });

    const browser = await puppeteer.default.launch({
      executablePath: findChrome(),
      headless,
      userDataDir: PROFILE_DIR,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
      ],
    });

    browser.on('disconnected', () => {
      browserInstance = null;
      browserLaunchPromise = null;
    });

    browserInstance = browser;
    return browser;
  })();

  try {
    return await browserLaunchPromise;
  } finally {
    browserLaunchPromise = null;
  }
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch {
      // ignore
    }
    browserInstance = null;
  }
}

// ── Login Detection ─────────────────────────────────────────

/**
 * Check whether the user is currently logged in on the outer SportyBet page.
 *
 * Looks for "My Account" + currency balance (GHS/NGN) in the header,
 * and checks that the Login button is NOT visible.
 */
export async function checkLoggedIn(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const body = document.body?.textContent || '';
      // Logged-in users see balance (GHS/NGN) + "My Account"
      if (
        body.includes('My Account') &&
        /(?:GHS|NGN)\s*[\d,]+/.test(body)
      ) {
        return true;
      }
      // Login button visible = NOT logged in
      const loginBtn = document.querySelector(
        'button.login-btn, [class*="login-btn"]',
      ) as HTMLElement | null;
      if (loginBtn && loginBtn.offsetHeight > 0) return false;

      // Phone input visible = login form open = NOT logged in
      const phoneInput = document.querySelector(
        'input[placeholder*="Mobile"], input[placeholder*="Phone"]',
      ) as HTMLElement | null;
      if (phoneInput && phoneInput.offsetHeight > 0) return false;

      return false;
    });
  } catch {
    return false;
  }
}

// ── Auto-Login ──────────────────────────────────────────────

/**
 * Attempt automatic login using SPORTYBET_PHONE + SPORTYBET_PASSWORD env vars.
 *
 * Flow:
 * 1. Click Login button to open the form
 * 2. Fill phone + password
 * 3. Submit
 * 4. Wait for session (balance visible)
 *
 * Returns true on success.
 */
export async function autoLogin(page: Page): Promise<boolean> {
  if (!SPORTYBET_PHONE || !SPORTYBET_PASSWORD) {
    logger.warn(
      'Auto-login: no credentials (set SPORTYBET_PHONE / SPORTYBET_PASSWORD)',
    );
    return false;
  }

  logger.info('Attempting auto-login...');

  try {
    // Step 1: Click login button
    const loginBtn = await page.$(
      'button.login-btn, [class*="login-btn"], ' +
        'a[href*="login"], button:has-text("Log In"), ' +
        'span:has-text("Log In"), [class*="af-header-login"]',
    );
    if (loginBtn) {
      await loginBtn.click();
      await sleep(2000);
    }

    // Step 2: Wait for phone input
    let phoneInput: ReturnType<Page['$']> extends Promise<infer T> ? T : never =
      null;
    for (let i = 0; i < 10; i++) {
      phoneInput = await page.$(
        'input[placeholder*="Mobile"], input[placeholder*="Phone"], ' +
          'input[placeholder*="phone"], input[placeholder*="mobile"], ' +
          'input[type="tel"], input[name="phone"], input[name="mobile"]',
      );
      if (phoneInput) break;
      await sleep(1000);
    }
    if (!phoneInput) {
      logger.warn('Auto-login: phone input not found');
      return false;
    }

    // Step 3: Fill phone
    await phoneInput.click();
    // Triple-click to select all, then type over it
    await phoneInput.click({ clickCount: 3 });
    await phoneInput.type(SPORTYBET_PHONE, { delay: 50 });
    await sleep(500);

    // Step 4: Fill password
    const passwordInput = await page.$(
      'input[type="password"], input[placeholder*="Password"], ' +
        'input[placeholder*="password"], input[name="password"]',
    );
    if (!passwordInput) {
      logger.warn('Auto-login: password input not found');
      return false;
    }
    await passwordInput.click();
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(SPORTYBET_PASSWORD, { delay: 50 });
    await sleep(500);

    // Step 5: Submit
    const submitBtn = await page.$(
      'button[type="submit"], button:has-text("Log In"), ' +
        'button:has-text("LOGIN"), button:has-text("Sign In"), ' +
        'form button[type="submit"]',
    );
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await passwordInput.press('Enter');
    }

    // Step 6: Wait for login (up to 30s)
    logger.info('Waiting for session...');
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (await checkLoggedIn(page)) {
        logger.info('Auto-login successful');
        return true;
      }
      // Check for error messages after a few seconds
      if (i > 3) {
        const error = await page.evaluate(() => {
          const els = document.querySelectorAll(
            '.error, .alert, [class*="error"], [class*="alert"]',
          );
          for (let j = 0; j < els.length; j++) {
            const htmlEl = els[j] as HTMLElement;
            if (htmlEl.offsetHeight > 0 && htmlEl.textContent?.trim()) {
              return htmlEl.textContent.trim();
            }
          }
          return null;
        });
        if (error) {
          logger.warn({ error }, 'Auto-login error detected');
          return false;
        }
      }
    }

    logger.warn('Auto-login timed out after 30s');
    return false;
  } catch (err) {
    logger.error({ err }, 'Auto-login failed');
    return false;
  }
}

// ── Session Management ──────────────────────────────────────

/**
 * Check whether the session is still alive.
 * Detects login popups, "Data Failed loading" errors, and lost iframes.
 */
export async function checkSessionAlive(
  page: Page,
  target: Page | Frame,
): Promise<boolean> {
  try {
    const loginVisible = await page.evaluate(() => {
      const el = document.getElementById('loginStep');
      if (el && (el as HTMLElement).offsetHeight > 0) return true;
      const popup = document.querySelector('.m-dialog-main');
      if (popup) {
        const txt = popup.textContent || '';
        if (/log in|Login|session/i.test(txt)) return true;
      }
      return false;
    });
    if (loginVisible) return false;

    const screen = await detectScreen(target);
    if (screen === 'unknown') {
      await sleep(3000);
      return (await detectScreen(target)) !== 'unknown';
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Handle session expiry: attempt auto-login, then navigate back.
 * Returns true if session was restored.
 */
export async function handleSessionExpired(page: Page): Promise<boolean> {
  logger.warn('Session expired — attempting recovery');

  if (SPORTYBET_PHONE && SPORTYBET_PASSWORD) {
    await page.goto(SPORTYBET_VIRTUALS_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await sleep(2000);

    if (await autoLogin(page)) {
      await page.goto(SPORTYBET_VIRTUALS_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await sleep(3000);
      return true;
    }
  }

  // Wait for manual login (up to ~5 min)
  logger.info('Waiting for manual login...');
  for (let i = 0; i < 100; i++) {
    await sleep(3000);
    if (await checkLoggedIn(page)) {
      logger.info('Session restored via manual login');
      await page.goto(SPORTYBET_VIRTUALS_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await sleep(3000);
      return true;
    }
  }

  logger.error('Session recovery timed out');
  return false;
}

// ── Dialog / Popup Dismissal ────────────────────────────────

/**
 * Dismiss modal dialogs, promo popups, overlay masks, and winning splash
 * screens that block interaction with the page.
 *
 * Returns the number of elements dismissed.
 */
export async function dismissDialogs(
  target: Page | Frame,
): Promise<number> {
  try {
    return await target.evaluate(() => {
      let dismissed = 0;

      // es-dialog overlays
      const dialogs = document.querySelectorAll('.es-dialog-wrap, [id^="esDialog"]');
      for (let i = 0; i < dialogs.length; i++) {
        (dialogs[i] as HTMLElement).style.display = 'none';
        dismissed++;
      }

      // Mask/layout overlays
      const masks = document.querySelectorAll('.layout.mask');
      for (let i = 0; i < masks.length; i++) {
        (masks[i] as HTMLElement).style.display = 'none';
        dismissed++;
      }

      // Close buttons in dialogs
      const closeBtns = document.querySelectorAll(
        '.es-dialog-wrap .close, .es-dialog-wrap .m-close',
      );
      for (let i = 0; i < closeBtns.length; i++) {
        (closeBtns[i] as HTMLElement).click();
        dismissed++;
      }

      // Winning splash popup
      const winPop = document.getElementById('winngin-pop');
      if (winPop && winPop.offsetHeight > 0) {
        winPop.style.display = 'none';
        dismissed++;
      }

      // instant-win-wrapper pointer-events pass-through
      const iw = document.getElementById('instant-win-wrapper');
      if (iw) iw.style.pointerEvents = 'none';

      return dismissed;
    });
  } catch {
    return 0;
  }
}

// ── iframe Handling ─────────────────────────────────────────

/**
 * Locate the virtual soccer iframe inside the outer SportyBet page.
 * Returns the Frame if found, or the Page as fallback.
 */
export async function findVirtualIframe(
  page: Page,
): Promise<Page | Frame> {
  for (let i = 0; i < 30; i++) {
    const iframeEl = await page.$(
      'iframe#instantwin-sport, iframe[src*="instant-virtuals"], ' +
        'iframe[src*="sporty-instant"]',
    );
    if (iframeEl) {
      const frame = await iframeEl.contentFrame();
      if (frame) {
        logger.info('Found virtual soccer iframe');
        return frame;
      }
    }
    await sleep(1000);
  }

  logger.warn('No iframe detected — using outer page');
  return page;
}

/**
 * Re-locate the iframe after a page reload or navigation error.
 */
export async function recoverIframe(page: Page): Promise<Page | Frame> {
  for (let i = 0; i < 15; i++) {
    const iframeEl = await page.$(
      'iframe#instantwin-sport, iframe[src*="instant-virtuals"], ' +
        'iframe[src*="sporty-instant"]',
    );
    if (iframeEl) {
      const frame = await iframeEl.contentFrame();
      if (frame) {
        await sleep(1000);
        return frame;
      }
    }
    await sleep(1000);
  }
  return page;
}

// ── Screen Detection ────────────────────────────────────────

/**
 * Detect which screen is currently displayed inside the virtual soccer iframe.
 *
 * Returns: 'betting' | 'live' | 'results' | 'unknown'
 */
export async function detectScreen(
  target: Page | Frame,
): Promise<ScreenType> {
  try {
    const url = 'url' in target ? (target as Page).url() : '';

    // Results screen
    const resultEl = await target.$('.liveResult-matches-item');
    if (resultEl) return 'results';

    // Betting screen
    const eventEl = await target.$('.event-list');
    if (eventEl) return 'betting';

    // Live/animation
    if (url.includes('/live/')) return 'live';

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// ── Navigation Helpers ──────────────────────────────────────

/** Click "Next Round" button. Returns true if found and clicked. */
export async function clickNextRound(
  target: Page | Frame,
): Promise<boolean> {
  await dismissDialogs(target);
  const btn = await target.$(
    'span[data-cms-key="next_round"], div[data-cms-key="next_round"]',
  );
  if (btn) {
    await btn.click();
    await sleep(2000);
    return true;
  }
  return false;
}

/** Wait for results screen to appear. Returns true on success. */
export async function waitForResults(
  target: Page | Frame,
  timeoutMs = 180_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const el = await target.$('.liveResult-matches-item');
    if (el) {
      await sleep(1000);
      return true;
    }
    await sleep(2000);
  }
  return false;
}

/**
 * Navigate to the SportyBet virtuals page and ensure we're logged in.
 * Handles auto-login + iframe discovery.
 *
 * Returns { page, target } where target is the iframe Frame or page.
 */
export async function navigateToVirtuals(
  headless = true,
): Promise<{ page: Page; target: Page | Frame }> {
  const browser = await launchBrowser(headless);
  const page = (await browser.pages())[0] ?? (await browser.newPage());

  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  );

  await page.goto(SPORTYBET_VIRTUALS_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await sleep(2000);

  // Login if needed
  if (!(await checkLoggedIn(page))) {
    if (SPORTYBET_PHONE && SPORTYBET_PASSWORD) {
      const ok = await autoLogin(page);
      if (ok) {
        await page.goto(SPORTYBET_VIRTUALS_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await sleep(3000);
      }
    }
  }

  const target = await findVirtualIframe(page);
  return { page, target };
}

// ── Utility ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

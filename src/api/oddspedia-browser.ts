/**
 * Oddspedia Browser Session
 *
 * Oddspedia's API (oddspedia.com/api/v1/...) returns 403 to plain HTTP
 * requests because of Cloudflare. The site's own front-end works fine
 * once a real browser has solved the Cloudflare challenge and stored
 * the resulting cookies.
 *
 * This module keeps a single headless Chrome warm with a persistent
 * profile so the cookies survive restarts, and exposes `fetchJson()`
 * which makes the request from inside the page context — that way
 * every call carries the live cookies + UA fingerprint Cloudflare expects.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { logger } from '../utils/logger.js';

const PROFILE_DIR = path.join(process.cwd(), 'data', 'oddspedia_profile');

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
];

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let browser: Browser | null = null;
let page: Page | null = null;
let warmupPromise: Promise<Page> | null = null;
let lastWarmup = 0;
const WARMUP_TTL = 30 * 60 * 1000; // refresh Cloudflare cookies every 30 min

function findChrome(): string | null {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function launch(): Promise<Page> {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome executable not found');

  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const puppeteer = await import('puppeteer-core');
  browser = await puppeteer.default.launch({
    executablePath: chrome,
    headless: true,
    userDataDir: PROFILE_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--window-size=1280,900',
    ],
    defaultViewport: null,
  });

  browser.on('disconnected', () => {
    browser = null;
    page = null;
  });

  page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.setUserAgent(UA);

  await page.goto('https://oddspedia.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await new Promise((r) => setTimeout(r, 2000));

  lastWarmup = Date.now();
  logger.info('Oddspedia browser warmed');
  return page;
}

async function getPage(): Promise<Page> {
  if (page && browser?.connected && Date.now() - lastWarmup < WARMUP_TTL) {
    return page;
  }
  if (warmupPromise) return warmupPromise;
  warmupPromise = launch();
  try {
    return await warmupPromise;
  } finally {
    warmupPromise = null;
  }
}

/**
 * Fetch a JSON URL from inside the warmed Oddspedia browser context so
 * Cloudflare cookies + UA travel with the request.
 */
export async function fetchOddspediaJson<T = unknown>(url: string): Promise<T> {
  const p = await getPage();
  return p.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }, url) as Promise<T>;
}

export async function closeOddspediaBrowser(): Promise<void> {
  if (browser) {
    try {
      await browser.close();
    } catch {
      // ignore
    }
    browser = null;
    page = null;
  }
}

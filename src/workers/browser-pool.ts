import { chromium, type Browser, type Page } from 'playwright';
import { logger } from '../utils/logger.js';

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    logger.info('Playwright browser launched');
  }
  return browser;
}

export async function fetchBrowser(
  url: string,
  actions?: (page: Page) => Promise<void>,
): Promise<string> {
  const b = await getBrowser();
  const context = await b.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    if (actions) {
      await actions(page);
    }

    return await page.content();
  } finally {
    await context.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

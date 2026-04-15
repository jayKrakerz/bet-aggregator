// V2 probe: intercept XHR/fetch on /dropping-odds to find the JSON API.
// If we can hit the API directly we skip HTML scraping entirely.

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const PROFILE_DIR = path.join(process.cwd(), 'data', 'oddspedia_profile');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: PROFILE_DIR,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,900'],
  defaultViewport: null,
});

try {
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  );

  const seen = new Map();
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      const ct = resp.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      if (/cdn\./.test(url)) return;
      const key = url.split('?')[0];
      if (seen.has(key)) return;
      let bodyPreview = '';
      try {
        const txt = await resp.text();
        bodyPreview = txt.slice(0, 400);
      } catch {}
      seen.set(key, { url, status: resp.status(), preview: bodyPreview });
    } catch {}
  });

  console.log('▶ navigating to /dropping-odds (capturing JSON XHR)');
  await page.goto('https://oddspedia.com/dropping-odds', { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(8000);

  // Try clicking refresh-now if visible to trigger a fresh API call
  const refreshed = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a, button')).filter((a) => /refresh now/i.test(a.textContent || ''));
    if (links.length) { links[0].click(); return true; }
    return false;
  });
  console.log('▶ clicked refresh:', refreshed);
  await sleep(5000);

  console.log(`\n=== ${seen.size} JSON responses captured ===\n`);
  for (const [, v] of seen) {
    console.log(`[${v.status}] ${v.url}`);
    console.log(`  preview: ${v.preview.replace(/\n/g, ' ').slice(0, 200)}`);
    console.log('');
  }

  // Snapshot a clean match row so we know the DOM if no API exists
  const sample = await page.evaluate(() => {
    const row = document.querySelector('.btools-match.btools-match--dropping-odds');
    if (!row) return null;
    return row.outerHTML.slice(0, 4000);
  });
  if (sample) fs.writeFileSync('/tmp/oddspedia-row.html', sample);
  console.log('✓ sample row →', sample ? '/tmp/oddspedia-row.html' : 'NOT FOUND');

  // Check session
  const session = await page.evaluate(() => {
    const ud = document.querySelector('.user-dropdown');
    return { userDropdownText: ud ? ud.textContent.trim().slice(0, 80) : null, url: location.href };
  });
  console.log('SESSION:', JSON.stringify(session));
} catch (err) {
  console.error('PROBE_ERROR:', err.message);
} finally {
  await browser.close();
}

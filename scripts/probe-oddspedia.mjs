// One-off DOM discovery probe for oddspedia.com.
// Launches Chrome with a persistent profile, logs in with
// ODDSPEDIA_EMAIL / ODDSPEDIA_PASSWORD, navigates to the dropping
// odds page and dumps a structural snapshot to stdout so we can
// pick stable selectors for the real scraper.

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const EMAIL = process.env.ODDSPEDIA_EMAIL;
const PASSWORD = process.env.ODDSPEDIA_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error('Set ODDSPEDIA_EMAIL and ODDSPEDIA_PASSWORD');
  process.exit(2);
}

const PROFILE_DIR = path.join(process.cwd(), 'data', 'oddspedia_profile');
fs.mkdirSync(PROFILE_DIR, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: PROFILE_DIR,
  args: [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1280,900',
  ],
  defaultViewport: null,
});

try {
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  );

  console.log('▶ navigating to oddspedia.com');
  await page.goto('https://oddspedia.com/', { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(3000);

  // Capture visible login-related elements
  const loginShape = await page.evaluate(() => {
    const out = { loginButtons: [], emailInputs: [], passwordInputs: [], submitButtons: [] };
    document.querySelectorAll('a, button').forEach((el) => {
      const t = (el.textContent || '').trim();
      if (/log\s*in|sign\s*in/i.test(t) && el.offsetHeight > 0) {
        out.loginButtons.push({ tag: el.tagName, text: t.slice(0, 40), cls: el.className.slice(0, 80) });
      }
    });
    document.querySelectorAll('input').forEach((el) => {
      const info = { type: el.type, name: el.name, id: el.id, placeholder: el.placeholder, cls: el.className.slice(0, 80) };
      if (el.type === 'email' || /email|user/i.test(el.placeholder || el.name || '')) out.emailInputs.push(info);
      if (el.type === 'password') out.passwordInputs.push(info);
    });
    return out;
  });
  console.log('LOGIN_SHAPE:', JSON.stringify(loginShape, null, 2));

  // Try to open login modal
  const loginClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('a, button, [class*="login"]'));
    for (const el of btns) {
      const t = (el.textContent || '').trim();
      if (/log\s*in|sign\s*in/i.test(t) && el.offsetHeight > 0) {
        el.click();
        return t;
      }
    }
    return null;
  });
  console.log('▶ clicked:', loginClicked);
  await sleep(2500);

  // Detect form fields after click
  const formAfter = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input')).filter((i) => i.offsetHeight > 0);
    return inputs.map((i) => ({
      type: i.type, name: i.name, id: i.id, placeholder: i.placeholder, cls: i.className.slice(0, 80),
    }));
  });
  console.log('FORM_AFTER_CLICK:', JSON.stringify(formAfter, null, 2));

  // Attempt login
  const emailSel = 'input[type="email"], input[name*="email" i], input[placeholder*="email" i], input[name*="user" i]';
  const passSel = 'input[type="password"]';
  const emailEl = await page.$(emailSel);
  const passEl = await page.$(passSel);
  if (!emailEl || !passEl) {
    console.log('✗ login inputs not found — probably already logged in or modal differs');
  } else {
    await emailEl.click({ clickCount: 3 });
    await emailEl.type(process.env.ODDSPEDIA_EMAIL, { delay: 40 });
    await passEl.click({ clickCount: 3 });
    await passEl.type(process.env.ODDSPEDIA_PASSWORD, { delay: 40 });
    await sleep(500);

    const submitClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"]')).filter((b) => b.offsetHeight > 0);
      for (const b of btns) {
        const t = (b.textContent || b.value || '').trim();
        if (/log\s*in|sign\s*in|continue|submit/i.test(t)) {
          b.click();
          return t;
        }
      }
      return null;
    });
    console.log('▶ submitted:', submitClicked);
    await sleep(6000);
  }

  // Check logged-in indicators
  const sessionShape = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    accountIndicators: Array.from(document.querySelectorAll('[class*="account"], [class*="user"], [class*="profile"], [class*="logout"]'))
      .filter((e) => e.offsetHeight > 0)
      .slice(0, 15)
      .map((e) => ({ tag: e.tagName, cls: e.className.slice(0, 100), text: (e.textContent || '').trim().slice(0, 60) })),
  }));
  console.log('SESSION_SHAPE:', JSON.stringify(sessionShape, null, 2));

  // Navigate to dropping odds
  console.log('▶ navigating to /dropping-odds');
  await page.goto('https://oddspedia.com/dropping-odds', { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(4000);

  const droppingShape = await page.evaluate(() => {
    const url = location.href;
    const title = document.title;
    // Find candidate row containers
    const candidates = [
      'table tbody tr',
      '[class*="dropping"] [class*="row"]',
      '[class*="dropping"] [class*="match"]',
      '[class*="match-row"]',
      '[class*="event-row"]',
      'a[href*="/match/"]',
      'a[href*="/football/"]',
    ];
    const found = {};
    for (const sel of candidates) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) found[sel] = els.length;
    }
    // Sample the first match-link if present
    const firstLink = document.querySelector('a[href*="/match/"], a[href*="/football/"]');
    const sampleHtml = firstLink ? (firstLink.closest('tr, li, [class*="row"]')?.outerHTML || firstLink.outerHTML).slice(0, 1500) : null;
    return { url, title, candidates: found, sampleHtml };
  });
  console.log('DROPPING_SHAPE:', JSON.stringify(droppingShape, null, 2));

  // Dump full HTML for inspection
  const html = await page.content();
  fs.writeFileSync('/tmp/oddspedia-dropping.html', html);
  console.log(`✓ saved full HTML (${html.length} bytes) → /tmp/oddspedia-dropping.html`);
} catch (err) {
  console.error('PROBE_ERROR:', err.message);
} finally {
  await browser.close();
}

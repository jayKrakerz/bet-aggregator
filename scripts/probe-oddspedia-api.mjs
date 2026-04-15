// Capture the full getDroppingOdds JSON response shape.

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const PROFILE_DIR = path.join(process.cwd(), 'data', 'oddspedia_profile');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: PROFILE_DIR,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  defaultViewport: null,
});

try {
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  );
  await page.goto('https://oddspedia.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2000));

  const data = await page.evaluate(async () => {
    const params = new URLSearchParams({
      markets: '',
      dropPercentage: '10.00,100.00',
      dropDuringPeriod: '1day',
      geoCode: '',
      geoState: '',
      sports: '1', // 1 = football
      bookmakers: '',
      wettsteuer: '0',
      sort: 'drop',
      page: '1',
      perPage: '50',
      language: 'en',
    });
    const r = await fetch(`https://oddspedia.com/api/v1/getDroppingOdds?${params}`);
    return { status: r.status, body: await r.json() };
  });

  console.log('STATUS:', data.status);
  console.log('TOP_KEYS:', Object.keys(data.body));
  if (Array.isArray(data.body.data)) {
    console.log('COUNT:', data.body.data.length);
    console.log('FIRST_ITEM_KEYS:', Object.keys(data.body.data[0] || {}));
    console.log('FIRST_ITEM:', JSON.stringify(data.body.data[0], null, 2));
    console.log('SECOND_ITEM:', JSON.stringify(data.body.data[1] || {}, null, 2));
  }
  fs.writeFileSync('/tmp/oddspedia-dropping.json', JSON.stringify(data.body, null, 2));
  console.log('✓ full response → /tmp/oddspedia-dropping.json');
} catch (err) {
  console.error('PROBE_ERROR:', err.message);
} finally {
  await browser.close();
}

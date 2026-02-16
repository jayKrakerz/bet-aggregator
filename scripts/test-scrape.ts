/**
 * Test scrape script: fetches a target site and analyzes its DOM structure.
 * Usage: npx tsx scripts/test-scrape.ts [url]
 * Default: https://www.covers.com/nba/picks
 */
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2] || 'https://www.covers.com/nba/picks';
const outDir = path.join('snapshots', '_test-scrapes');
fs.mkdirSync(outDir, { recursive: true });

async function scrape() {
  console.log(`\n=== Scraping: ${url} ===\n`);

  // Use Playwright (browser) to handle JS-rendered content
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  console.log('Navigating...');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log(`Page title: ${await page.title()}`);

  // Wait for content to render
  await page.waitForTimeout(5000);

  // Scroll to trigger lazy content
  await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
  await page.waitForTimeout(3000);
  await page.evaluate('window.scrollTo(0, 0)');

  const html = await page.content();
  await page.screenshot({ path: path.join(outDir, 'screenshot.png'), fullPage: true });
  await browser.close();

  // Save raw HTML
  const slug = new URL(url).hostname.replace(/\./g, '-');
  const htmlPath = path.join(outDir, `${slug}.html`);
  fs.writeFileSync(htmlPath, html, 'utf-8');
  console.log(`HTML saved: ${htmlPath} (${(html.length / 1024).toFixed(0)} KB)`);
  console.log(`Screenshot saved: ${path.join(outDir, 'screenshot.png')}`);

  // Analyze DOM structure
  const $ = cheerio.load(html);
  console.log(`\n=== DOM Analysis ===\n`);

  // Look for potential pick/prediction containers
  const searchPatterns = [
    // Class-based patterns
    '[class*="pick" i]',
    '[class*="Pick" i]',
    '[class*="prediction" i]',
    '[class*="tip" i]',
    '[class*="expert" i]',
    '[class*="consensus" i]',
    '[class*="matchup" i]',
    '[class*="game" i]',
    '[class*="spread" i]',
    '[class*="moneyline" i]',
    // Data attribute patterns
    '[data-testid]',
    '[data-pick]',
    '[data-game]',
    // Semantic patterns
    'article',
    'table',
    'time[datetime]',
  ];

  for (const sel of searchPatterns) {
    const matches = $(sel);
    if (matches.length > 0) {
      console.log(`\n--- ${sel}: ${matches.length} match(es) ---`);
      matches.slice(0, 3).each((i, el) => {
        const $el = $(el);
        const tag = el.type === 'tag' ? (el as cheerio.TagElement).tagName : '?';
        const cls = $el.attr('class') || '';
        const id = $el.attr('id') || '';
        const testId = $el.attr('data-testid') || '';
        const text = $el.text().trim().slice(0, 120);

        console.log(`  [${i}] <${tag}${id ? ` id="${id}"` : ''}${cls ? ` class="${cls.slice(0, 80)}"` : ''}${testId ? ` data-testid="${testId}"` : ''}>`);
        console.log(`       text: "${text}${text.length >= 120 ? '...' : ''}"`);

        // Show immediate children structure
        const children = $el.children();
        if (children.length > 0 && children.length <= 15) {
          const childSummary = children.toArray().map(c => {
            if (c.type !== 'tag') return '';
            const cTag = (c as cheerio.TagElement).tagName;
            const cCls = $(c).attr('class')?.slice(0, 50) || '';
            return `<${cTag}${cCls ? `.${cCls.split(' ')[0]}` : ''}>`;
          }).filter(Boolean).join(', ');
          console.log(`       children: ${childSummary}`);
        }
      });
    }
  }

  // Special: dump all unique class names containing pick/game/match keywords
  console.log(`\n=== Classes containing key terms ===\n`);
  const classSet = new Set<string>();
  $('[class]').each((_, el) => {
    const cls = $(el).attr('class') || '';
    cls.split(/\s+/).forEach(c => {
      if (/pick|game|match|team|spread|money|over|under|expert|tip|consensus|prediction/i.test(c)) {
        classSet.add(c);
      }
    });
  });
  const sorted = [...classSet].sort();
  console.log(sorted.join('\n'));

  // Dump __NEXT_DATA__ if present
  const nextData = $('#__NEXT_DATA__').html();
  if (nextData) {
    console.log(`\n=== __NEXT_DATA__ found (${(nextData.length / 1024).toFixed(0)} KB) ===`);
    try {
      const parsed = JSON.parse(nextData);
      console.log('Top-level keys:', Object.keys(parsed));
      if (parsed.props?.pageProps) {
        console.log('pageProps keys:', Object.keys(parsed.props.pageProps));
      }
    } catch { /* ignore */ }
    const nextDataPath = path.join(outDir, `${slug}-next-data.json`);
    fs.writeFileSync(nextDataPath, nextData, 'utf-8');
    console.log(`Saved to: ${nextDataPath}`);
  }
}

scrape().catch(err => {
  console.error('Scrape failed:', err);
  process.exit(1);
});

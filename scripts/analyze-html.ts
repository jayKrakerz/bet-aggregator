import * as cheerio from 'cheerio';
import fs from 'node:fs';

const htmlPath = process.argv[2] || 'snapshots/_test-scrapes/www-covers-com.html';
const html = fs.readFileSync(htmlPath, 'utf-8');
const $ = cheerio.load(html);

// Look at the no-picks-wrapper
console.log('=== no-picks-wrapper ===');
$('.no-picks-wrapper').each((_i, el) => {
  console.log($(el).html()?.trim().slice(0, 500));
});

// Look at articles structure
console.log('\n=== Articles (single-article-LH) ===');
$('article.single-article-LH').each((i, el) => {
  const a = $(el);
  const link = a.find('a').attr('href');
  const title = a.find('h3, h4, .title, [class*="title"]').text().trim();
  const spans = a.find('span').map((_j, s) => $(s).text().trim()).get().join(' | ');
  console.log(`[${i}] ${title || 'no-title'}`);
  console.log(`    link: ${link}`);
  console.log(`    spans: ${spans.slice(0, 200)}`);
});

// Look for headings about picks
console.log('\n=== Headers mentioning picks/expert/spread/consensus ===');
$('h1, h2, h3, h4').each((_i, el) => {
  const text = $(el).text().trim();
  if (/pick|consensus|expert|spread|moneyline|best.?bet|prediction|free/i.test(text)) {
    const tag = (el as cheerio.TagElement).tagName;
    console.log(`<${tag}> ${text.slice(0, 120)}`);
  }
});

// Check for links to actual pick pages
console.log('\n=== Links containing pick/prediction ===');
const linkSet = new Set<string>();
$('a[href]').each((_i, el) => {
  const href = $(el).attr('href') || '';
  if (/pick|prediction|consensus|best-bet/i.test(href) && !linkSet.has(href)) {
    linkSet.add(href);
    const text = $(el).text().trim().slice(0, 80);
    console.log(`${href}  ->  ${text}`);
  }
});

// Check for structured data
console.log('\n=== JSON-LD / Structured data ===');
$('script[type="application/ld+json"]').each((i, el) => {
  try {
    const data = JSON.parse($(el).html() || '');
    console.log(`[${i}] @type: ${data['@type']} | name: ${data.name?.slice(0, 80)}`);
  } catch { /* skip */ }
});

// Check for __NEXT_DATA__
const nextData = $('#__NEXT_DATA__').html();
if (nextData) {
  console.log(`\n=== __NEXT_DATA__ found (${(nextData.length / 1024).toFixed(0)} KB) ===`);
} else {
  console.log('\n=== No __NEXT_DATA__ ===');
}

// Look for any table or grid structure
console.log('\n=== Tables ===');
$('table').each((i, el) => {
  const cls = $(el).attr('class') || '';
  const rows = $(el).find('tr').length;
  console.log(`[${i}] class="${cls.slice(0, 80)}" rows=${rows}`);
  // Show first row content
  const firstRow = $(el).find('tr').first().text().trim().slice(0, 150);
  console.log(`    first row: ${firstRow}`);
});

// Look for game-specific elements
console.log('\n=== Elements with game/matchup/team classes ===');
$('[class*="game"], [class*="matchup"], [class*="team-list"]').slice(0, 10).each((i, el) => {
  const tag = (el as cheerio.TagElement).tagName;
  const cls = $(el).attr('class') || '';
  const text = $(el).text().trim().slice(0, 120);
  console.log(`[${i}] <${tag} class="${cls.slice(0, 80)}"> ${text}`);
});

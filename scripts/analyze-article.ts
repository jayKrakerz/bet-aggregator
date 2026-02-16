import * as cheerio from 'cheerio';
import fs from 'node:fs';

const html = fs.readFileSync('snapshots/_test-scrapes/www-covers-com.html', 'utf-8');
const $ = cheerio.load(html);

// Get article text sections
console.log('=== Article headline + author ===');
console.log('H1:', $('h1').text().trim());
console.log('Author:', $('[class*="authorName"]').text().trim());
console.log('Timestamp:', $('[class*="timeStamp"]').text().trim());

// Dump all tables
console.log('\n=== All Tables (Covers-CoversArticles-AdminArticleTable) ===');
$('table.Covers-CoversArticles-AdminArticleTable').each((i, el) => {
  console.log(`\n--- Table ${i} ---`);
  const table = $(el);

  // Header
  const headers = table.find('thead th').map((_j, th) => $(th).text().trim()).get();
  console.log('Headers:', headers);

  // Rows
  table.find('tbody tr').each((j, tr) => {
    const cells = $(tr).find('td').map((_k, td) => $(td).text().trim()).get();
    console.log(`  Row ${j}:`, cells);
  });
});

// Look at the article body text for pick-related sentences
console.log('\n=== Article body paragraphs mentioning picks/predictions ===');
$('.covers-CoversArticles-articleText p, .covers-CoversArticles-articleText h2, .covers-CoversArticles-articleText h3').each((i, el) => {
  const text = $(el).text().trim();
  if (/pick|predict|bet|spread|over|under|moneyline|best bet|lock|winner/i.test(text)) {
    const tag = (el as cheerio.TagElement).tagName;
    console.log(`\n[${i}] <${tag}> ${text.slice(0, 200)}`);
  }
});

// Look for "best bet" or "pick" callout boxes
console.log('\n=== Strong/bold text (possible pick callouts) ===');
$('.covers-CoversArticles-articleText strong, .covers-CoversArticles-articleText b').each((i, el) => {
  const text = $(el).text().trim();
  if (text.length > 5 && /pick|bet|prediction|play|take|lock|winner/i.test(text)) {
    console.log(`[${i}] ${text.slice(0, 150)}`);
  }
});

// Look for structured pick callout divs
console.log('\n=== Divs/sections with bet/pick/best classes ===');
$('[class*="bet" i], [class*="best" i], [class*="callout" i], [class*="highlight" i]').each((i, el) => {
  const cls = $(el).attr('class') || '';
  const text = $(el).text().trim().slice(0, 120);
  console.log(`[${i}] class="${cls}" -> ${text}`);
});

/**
 * Test the adapter parse logic against a saved fixture.
 * Usage: npx tsx scripts/test-parse.ts
 */
import { CoversComAdapter } from '../src/adapters/covers-com.js';
import fs from 'node:fs';

const adapter = new CoversComAdapter();

// Test discoverUrls on landing page
console.log('=== Landing page: discoverUrls ===\n');
const landingHtml = fs.readFileSync('test/fixtures/covers-com/nba-picks.html', 'utf-8');
const urls = adapter.discoverUrls!(landingHtml, 'nba');
console.log(`Found ${urls.length} article URLs:`);
urls.forEach((url, i) => console.log(`  [${i}] ${url}`));

// Test parse on article page
console.log('\n=== Article page: parse ===\n');
const articleHtml = fs.readFileSync('test/fixtures/covers-com/nba-article.html', 'utf-8');
const predictions = adapter.parse(articleHtml, 'nba', new Date('2026-02-14'));
console.log(`Parsed ${predictions.length} predictions:\n`);
predictions.forEach((p, i) => {
  console.log(`[${i}] ${p.pickType} | ${p.side} | value=${p.value}`);
  console.log(`    home: "${p.homeTeamRaw}" away: "${p.awayTeamRaw}"`);
  console.log(`    picker: ${p.pickerName} | conf: ${p.confidence}`);
  console.log(`    reasoning: "${p.reasoning?.slice(0, 100)}"`);
  console.log(`    date: ${p.gameDate}`);
  console.log();
});

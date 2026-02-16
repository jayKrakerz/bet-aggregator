/**
 * Test the OneMillionPredictions adapter parse logic against the saved fixture.
 * Usage: npx tsx scripts/test-parse-omp.ts
 */
import { OneMillionPredictionsAdapter } from '../src/adapters/onemillionpredictions.js';
import fs from 'node:fs';

const adapter = new OneMillionPredictionsAdapter();

const html = fs.readFileSync('test/fixtures/onemillionpredictions/btts.html', 'utf-8');
const predictions = adapter.parse(html, 'football', new Date('2026-02-16'));

console.log(`=== OneMillionPredictions Parse Results (BTTS page) ===\n`);
console.log(`Total: ${predictions.length} predictions\n`);

// Group by league (stored in reasoning)
const leagues = new Map<string, typeof predictions>();
for (const p of predictions) {
  const league = p.reasoning || 'Unknown';
  if (!leagues.has(league)) leagues.set(league, []);
  leagues.get(league)!.push(p);
}

for (const [league, picks] of leagues) {
  console.log(`--- ${league} (${picks.length} picks) ---`);
  for (const p of picks) {
    console.log(
      `  ${p.gameDate} ${(p.gameTime || '').padEnd(6)} ` +
      `${p.homeTeamRaw} vs ${p.awayTeamRaw} → ` +
      `${p.pickType}/${p.side} @ ${p.value}`,
    );
  }
  console.log();
}

// Also test discoverUrls
console.log('=== Discovered Sub-URLs ===');
const urls = adapter.discoverUrls(html, 'football');
for (const url of urls) {
  console.log(`  ${url}`);
}
console.log(`\nTotal: ${urls.length} sub-URLs`);

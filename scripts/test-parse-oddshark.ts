/**
 * Test the OddsShark adapter parse logic against the saved fixture.
 * Usage: npx tsx scripts/test-parse-oddshark.ts
 */
import { OddSharkAdapter } from '../src/adapters/oddshark.js';
import fs from 'node:fs';

const adapter = new OddSharkAdapter();

const html = fs.readFileSync('test/fixtures/oddshark/nba-picks.html', 'utf-8');
const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

const computerPicks = predictions.filter(p => p.pickerName === 'OddsShark Computer');
const expertPicks = predictions.filter(p => p.pickerName !== 'OddsShark Computer');

console.log(`=== OddsShark Parse Results ===\n`);
console.log(`Total: ${predictions.length} predictions (${computerPicks.length} computer, ${expertPicks.length} expert)\n`);

console.log('--- Computer Picks ---\n');

// Group by game
const games = new Map<string, typeof computerPicks>();
for (const p of computerPicks) {
  const key = `${p.awayTeamRaw} @ ${p.homeTeamRaw} (${p.gameDate})`;
  if (!games.has(key)) games.set(key, []);
  games.get(key)!.push(p);
}

for (const [matchup, picks] of games) {
  const date = picks[0]?.gameDate || '?';
  const time = picks[0]?.gameTime || '';
  console.log(`${matchup} | ${date} ${time}`);
  for (const p of picks) {
    console.log(`  ${p.pickType.padEnd(12)} | side=${p.side.padEnd(5)} | value=${p.value}`);
  }
  console.log();
}

if (expertPicks.length > 0) {
  console.log('--- Expert Picks ---\n');
  for (const p of expertPicks) {
    console.log(`[${p.pickerName}] ${p.pickType} | ${p.reasoning}`);
    console.log(`  teams: ${p.awayTeamRaw} @ ${p.homeTeamRaw} | odds: ${p.value} | date: ${p.gameDate}`);
    console.log();
  }
}

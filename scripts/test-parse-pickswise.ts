/**
 * Test the Pickswise adapter parse logic against the saved fixture.
 * Usage: npx tsx scripts/test-parse-pickswise.ts
 */
import { PickswiseAdapter } from '../src/adapters/pickswise.js';
import fs from 'node:fs';

const adapter = new PickswiseAdapter();

const html = fs.readFileSync('test/fixtures/pickswise/nba-picks.html', 'utf-8');
const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

console.log(`=== Pickswise Parse Results ===\n`);
console.log(`Total: ${predictions.length} predictions\n`);

for (const p of predictions) {
  console.log(`[${p.pickerName}] ${p.pickType} | side=${p.side} | value=${p.value}`);
  console.log(`  game: ${p.awayTeamRaw} @ ${p.homeTeamRaw}`);
  console.log(`  date: ${p.gameDate} ${p.gameTime || ''}`);
  console.log(`  confidence: ${p.confidence}`);
  console.log(`  reasoning: "${p.reasoning?.slice(0, 120)}${(p.reasoning?.length || 0) > 120 ? '...' : ''}"`);
  console.log();
}

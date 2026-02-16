/**
 * Print a summary of the database state.
 */
import { sql } from '../src/db/pool.js';

// Predictions by source
const bySrc = await sql`
  SELECT s.name, s.slug, count(*)::int as count
  FROM predictions p JOIN sources s ON s.id = p.source_id
  GROUP BY s.name, s.slug ORDER BY count DESC
`;
console.log('=== Predictions by Source ===');
for (const r of bySrc) console.log(`  ${r.name}: ${r.count}`);

// Predictions by pick type
const byType = await sql`
  SELECT pick_type, count(*)::int as count
  FROM predictions GROUP BY pick_type ORDER BY count DESC
`;
console.log('\n=== Predictions by Pick Type ===');
for (const r of byType) console.log(`  ${r.pick_type}: ${r.count}`);

// Matches
const matches = await sql`
  SELECT m.game_date, ht.abbreviation as home, at.abbreviation as away, m.game_time,
         count(p.id)::int as picks
  FROM matches m
  JOIN teams ht ON ht.id = m.home_team_id
  JOIN teams at ON at.id = m.away_team_id
  LEFT JOIN predictions p ON p.match_id = m.id
  GROUP BY m.game_date, ht.abbreviation, at.abbreviation, m.game_time
  ORDER BY m.game_date, m.game_time
`;
console.log(`\n=== Matches (${matches.length}) ===`);
for (const m of matches) {
  const date = new Date(m.game_date as string).toISOString().split('T')[0];
  console.log(`  ${date} ${(m.game_time || '').toString().padEnd(12)} ${m.away}@${m.home} (${m.picks} picks)`);
}

// Snapshots on disk
const fs = await import('node:fs');
const path = await import('node:path');
let snapCount = 0;
function countFiles(dir: string) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) countFiles(path.join(dir, entry.name));
    else if (entry.name.endsWith('.html')) snapCount++;
  }
}
countFiles('snapshots');
console.log(`\n=== Snapshots: ${snapCount} HTML files on disk ===`);

// Sources
const sources = await sql`
  SELECT slug, last_fetched_at FROM sources ORDER BY slug
`;
console.log('\n=== Sources ===');
for (const s of sources) {
  const fetched = s.last_fetched_at ? new Date(s.last_fetched_at as string).toISOString() : 'never';
  console.log(`  ${s.slug}: last_fetched=${fetched}`);
}

await sql.end();

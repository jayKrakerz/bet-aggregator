import { ForebetAdapter } from '../src/adapters/forebet.js';
import { OddsTraderAdapter } from '../src/adapters/oddstrader.js';
import * as fs from 'fs';
import { sql } from '../src/db/pool.js';

// Check what Forebet NBA names look like
const forebet = new ForebetAdapter();
const bball = fs.readFileSync('test/fixtures/forebet/basketball.html', 'utf-8');
const fbPreds = forebet.parse(bball, 'nba', new Date());
const fbTeams = new Set([...fbPreds.map(p => p.homeTeamRaw), ...fbPreds.map(p => p.awayTeamRaw)]);
console.log('=== Forebet NBA team names ===');
console.log([...fbTeams].sort().join('\n'));

// Check what Forebet football names look like
const football = fs.readFileSync('test/fixtures/forebet/football-1x2.html', 'utf-8');
const ffPreds = forebet.parse(football, 'football', new Date());
const ffTeams = new Set([...ffPreds.map(p => p.homeTeamRaw), ...ffPreds.map(p => p.awayTeamRaw)]);
console.log('\n=== Forebet football team names (first 20) ===');
console.log([...ffTeams].sort().slice(0, 20).join('\n'));

// Check what's in the DB
const teams = await sql`SELECT name, abbreviation FROM teams WHERE sport = 'nba' OR sport IS NULL ORDER BY name LIMIT 50`;
console.log('\n=== DB NBA teams ===');
for (const t of teams) {
  console.log(`  ${t.name} (${t.abbreviation})`);
}

// Check aliases
const aliases = await sql`SELECT ta.alias, t.name FROM team_aliases ta JOIN teams t ON t.id = ta.team_id ORDER BY ta.alias LIMIT 30`;
console.log('\n=== Sample DB aliases ===');
for (const a of aliases) {
  console.log(`  "${a.alias}" → ${a.name}`);
}

await sql.end();

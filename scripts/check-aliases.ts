import { sql } from '../src/db/pool.js';

const aliases = await sql<{ alias: string }[]>`SELECT alias FROM team_aliases ORDER BY alias`;
console.log(`Aliases (${aliases.length}):`);
console.log(aliases.map(a => a.alias).join(', '));
await sql.end();

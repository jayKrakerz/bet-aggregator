import { sql } from '../src/db/pool.js';
import { runMigrations } from '../migrations/runner.js';

console.log('Running migrations...');
await runMigrations(sql);
await sql.end();

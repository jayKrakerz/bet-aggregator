import fs from 'node:fs';
import path from 'node:path';
import type { Sql } from 'postgres';

const MIGRATIONS_DIR = path.dirname(new URL(import.meta.url).pathname);

export async function runMigrations(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const applied = await sql<{ name: string }[]>`SELECT name FROM _migrations ORDER BY id`;
  const appliedSet = new Set(applied.map((r) => r.name));

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`  skip: ${file} (already applied)`);
      continue;
    }
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    console.log(`  apply: ${file}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx.unsafe(`INSERT INTO _migrations (name) VALUES ('${file.replace(/'/g, "''")}')`);
    });
  }

  console.log('All migrations applied.');
}

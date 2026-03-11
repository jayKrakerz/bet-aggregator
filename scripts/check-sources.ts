/**
 * Check which sources are producing predictions.
 */
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL || 'postgres://betagg:betagg_dev@127.0.0.1:5433/bet_aggregator');

const rows = await sql`
  SELECT s.slug, s.last_fetched_at,
    COUNT(p.id) FILTER (WHERE p.created_at >= CURRENT_DATE) as today_count,
    COUNT(p.id) FILTER (WHERE p.created_at >= CURRENT_DATE - INTERVAL '7 days') as week_count
  FROM sources s
  LEFT JOIN predictions p ON p.source_id = s.id
  GROUP BY s.id, s.slug, s.last_fetched_at
  ORDER BY today_count DESC, week_count DESC
`;

console.log('Source'.padEnd(30) + 'Today'.padStart(8) + 'Week'.padStart(8) + '  Last Fetched');
console.log('-'.repeat(80));
for (const r of rows) {
  const lf = r.last_fetched_at ? new Date(r.last_fetched_at).toISOString().slice(0,19) : 'NEVER';
  const flag = Number(r.today_count) === 0 && Number(r.week_count) === 0 ? ' !!DEAD' : Number(r.today_count) === 0 ? ' *stale' : '';
  console.log(r.slug.padEnd(30) + String(r.today_count).padStart(8) + String(r.week_count).padStart(8) + '  ' + lf + flag);
}
await sql.end();

import type { FastifyPluginAsync } from 'fastify';
import { sql } from '../../db/pool.js';

export const predictionsRoutes: FastifyPluginAsync = async (app) => {
  // GET /predictions/stats — aggregate stats for dashboard
  app.get('/stats', async () => {
    const [stats] = await sql<
      {
        total_predictions: number;
        active_sources: number;
        total_matches: number;
        pick_types: number;
      }[]
    >`
      SELECT
        count(*)::int as total_predictions,
        count(DISTINCT p.source_id)::int as active_sources,
        count(DISTINCT p.match_id)::int as total_matches,
        count(DISTINCT p.pick_type)::int as pick_types
      FROM predictions p
    `;
    const bySport = await sql`
      SELECT sport, count(*)::int as count FROM predictions GROUP BY sport ORDER BY count DESC
    `;
    const bySource = await sql`
      SELECT s.name, s.slug, count(*)::int as count
      FROM predictions p JOIN sources s ON s.id = p.source_id
      GROUP BY s.name, s.slug ORDER BY count DESC
    `;
    const byPickType = await sql`
      SELECT pick_type, count(*)::int as count
      FROM predictions GROUP BY pick_type ORDER BY count DESC
    `;
    return { ...stats, bySport, bySource, byPickType };
  });

  // GET /predictions/matches — matches with prediction counts for card UI
  app.get('/matches', async (request) => {
    const { sport, date, source } = request.query as {
      sport?: string;
      date?: string;
      source?: string;
    };

    const matches = await sql`
      SELECT
        m.id,
        m.sport,
        m.game_date,
        m.game_time,
        ht.name as home_team,
        ht.abbreviation as home_abbr,
        att.name as away_team,
        att.abbreviation as away_abbr,
        count(p.id)::int as prediction_count,
        array_agg(DISTINCT s.slug) as sources,
        array_agg(DISTINCT p.pick_type) as pick_types
      FROM matches m
      JOIN teams ht ON ht.id = m.home_team_id
      JOIN teams att ON att.id = m.away_team_id
      LEFT JOIN predictions p ON p.match_id = m.id
      LEFT JOIN sources s ON s.id = p.source_id
      WHERE 1=1
        ${sport ? sql`AND m.sport = ${sport}` : sql``}
        ${date ? sql`AND m.game_date = ${date}` : sql``}
        ${source ? sql`AND s.slug = ${source}` : sql``}
      GROUP BY m.id, m.sport, m.game_date, m.game_time,
               ht.name, ht.abbreviation, att.name, att.abbreviation
      HAVING count(p.id) > 0
      ORDER BY m.game_date DESC, m.game_time ASC NULLS LAST
      LIMIT 200
    `;

    return { data: matches, count: matches.length };
  });

  // GET /predictions?sport=nba&date=2026-02-16&source=covers-com
  app.get('/', async (request) => {
    const { sport, date, source } = request.query as {
      sport?: string;
      date?: string;
      source?: string;
    };

    const predictions = await sql`
      SELECT
        p.id,
        p.sport,
        p.pick_type,
        p.side,
        p.value,
        p.picker_name,
        p.confidence,
        p.reasoning,
        p.fetched_at,
        p.created_at,
        s.name as source_name,
        s.slug as source_slug,
        s.base_url as source_url,
        ht.name as home_team_name,
        ht.abbreviation as home_team_abbr,
        att.name as away_team_name,
        att.abbreviation as away_team_abbr,
        m.game_date,
        m.game_time,
        m.id as match_id
      FROM predictions p
      JOIN sources s ON s.id = p.source_id
      JOIN teams ht ON ht.id = p.home_team_id
      JOIN teams att ON att.id = p.away_team_id
      JOIN matches m ON m.id = p.match_id
      WHERE 1=1
        ${sport ? sql`AND p.sport = ${sport}` : sql``}
        ${date ? sql`AND m.game_date = ${date}` : sql``}
        ${source ? sql`AND s.slug = ${source}` : sql``}
      ORDER BY m.game_date DESC, p.created_at DESC
      LIMIT 500
    `;

    return { data: predictions, count: predictions.length };
  });

  // GET /predictions/:matchId
  app.get<{ Params: { matchId: string } }>('/:matchId', async (request, reply) => {
    const { matchId } = request.params;

    const predictions = await sql`
      SELECT
        p.id,
        p.sport,
        p.pick_type,
        p.side,
        p.value,
        p.picker_name,
        p.confidence,
        p.reasoning,
        p.fetched_at,
        p.created_at,
        s.name as source_name,
        s.slug as source_slug,
        s.base_url as source_url
      FROM predictions p
      JOIN sources s ON s.id = p.source_id
      WHERE p.match_id = ${matchId}
      ORDER BY p.created_at DESC
    `;

    if (predictions.length === 0) {
      return reply.status(404).send({ error: 'No predictions found for this match' });
    }

    return { data: predictions, count: predictions.length };
  });
};

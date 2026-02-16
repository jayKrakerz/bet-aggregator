import type { FastifyPluginAsync } from 'fastify';
import { sql } from '../../db/pool.js';

export const predictionsRoutes: FastifyPluginAsync = async (app) => {
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
        at.name as away_team_name,
        at.abbreviation as away_team_abbr,
        m.game_date,
        m.game_time,
        m.id as match_id
      FROM predictions p
      JOIN sources s ON s.id = p.source_id
      JOIN teams ht ON ht.id = p.home_team_id
      JOIN teams at ON at.id = p.away_team_id
      JOIN matches m ON m.id = p.match_id
      WHERE 1=1
        ${sport ? sql`AND p.sport = ${sport}` : sql``}
        ${date ? sql`AND m.game_date = ${date}` : sql``}
        ${source ? sql`AND s.slug = ${source}` : sql``}
      ORDER BY m.game_date DESC, p.created_at DESC
      LIMIT 100
    `;

    return { data: predictions, count: predictions.length };
  });

  // GET /predictions/:matchId
  app.get<{ Params: { matchId: string } }>('/:matchId', async (request, reply) => {
    const { matchId } = request.params;

    const predictions = await sql`
      SELECT
        p.id,
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

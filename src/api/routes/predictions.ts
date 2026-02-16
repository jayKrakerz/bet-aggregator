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

  // GET /predictions/best-multis — best 2-leg parlay per day
  app.get('/best-multis', async () => {
    const picks = await sql<
      {
        game_date: string;
        game_time: string | null;
        sport: string;
        home_team: string;
        away_team: string;
        pick_type: string;
        side: string;
        value: number | null;
        source_name: string;
        picker_name: string;
        confidence: string | null;
        reasoning: string | null;
      }[]
    >`
      SELECT
        to_char(m.game_date, 'YYYY-MM-DD') as game_date,
        m.game_time,
        m.sport,
        ht.name as home_team,
        att.name as away_team,
        p.pick_type,
        p.side,
        p.value,
        s.name as source_name,
        p.picker_name,
        p.confidence,
        p.reasoning
      FROM predictions p
      JOIN matches m ON m.id = p.match_id
      JOIN teams ht ON ht.id = m.home_team_id
      JOIN teams att ON att.id = m.away_team_id
      JOIN sources s ON s.id = p.source_id
      WHERE p.pick_type = 'moneyline'
        AND p.value IS NOT NULL
      ORDER BY m.game_date, m.sport, p.value ASC
    `;

    // Group by date, compute best 2-leg multi per day
    type Pick = (typeof picks)[number];
    const byDate: Record<string, Pick[]> = {};
    for (const p of picks) {
      const raw = p.game_date.toString();
      const d = raw.includes('T') ? raw.split('T')[0]! : new Date(raw).toISOString().split('T')[0]!;
      if (!byDate[d]) byDate[d] = [];
      byDate[d]!.push(p);
    }

    const multis = [];
    for (const [date, dayPicks] of Object.entries(byDate)) {
      // Convert to decimal odds
      const withDecimal = dayPicks.map((p) => {
        let decOdds: number;
        if (p.sport === 'football') {
          decOdds = p.value!;
        } else if (p.value! < 0) {
          decOdds = 1 + 100 / Math.abs(p.value!);
        } else {
          decOdds = 1 + p.value! / 100;
        }
        return { ...p, decOdds, impliedProb: 1 / decOdds };
      });

      // Filter to strong favorites (decimal odds 1.05 - 1.60, i.e. ~63-95% implied)
      // then sort by implied probability descending
      const candidates = withDecimal
        .filter((p) => p.decOdds >= 1.05 && p.decOdds <= 1.60)
        .sort((a, b) => b.impliedProb - a.impliedProb);

      // Pick the best 2 from different matches, targeting combined odds ~1.4-1.8
      const legs: typeof withDecimal = [];
      const usedMatchups = new Set<string>();
      for (const p of candidates) {
        const key = `${p.home_team} vs ${p.away_team}`;
        if (usedMatchups.has(key)) continue;
        // If we already have one leg, prefer the pair that lands combined ~1.5-1.8
        if (legs.length === 1) {
          const combo = legs[0]!.decOdds * p.decOdds;
          // Skip if combined is too low (both legs too safe = bad payout)
          if (combo < 1.3) continue;
        }
        legs.push(p);
        usedMatchups.add(key);
        if (legs.length === 2) break;
      }

      // Fallback: if we couldn't find 2 in the sweet spot, just take top 2 favorites
      if (legs.length < 2) {
        legs.length = 0;
        usedMatchups.clear();
        const fallback = withDecimal.sort((a, b) => b.impliedProb - a.impliedProb);
        for (const p of fallback) {
          const key = `${p.home_team} vs ${p.away_team}`;
          if (usedMatchups.has(key)) continue;
          legs.push(p);
          usedMatchups.add(key);
          if (legs.length === 2) break;
        }
      }

      if (legs.length === 2) {
        const combinedOdds = legs[0]!.decOdds * legs[1]!.decOdds;
        const combinedProb = legs[0]!.impliedProb * legs[1]!.impliedProb;
        multis.push({
          date,
          combinedOdds: Math.round(combinedOdds * 100) / 100,
          combinedProb: Math.round(combinedProb * 1000) / 10,
          legs: legs.map((l) => ({
            sport: l.sport,
            homeTeam: l.home_team,
            awayTeam: l.away_team,
            side: l.side,
            decOdds: Math.round(l.decOdds * 100) / 100,
            impliedProb: Math.round(l.impliedProb * 1000) / 10,
            gameTime: l.game_time,
            source: l.source_name,
            picker: l.picker_name,
            confidence: l.confidence,
            league: l.reasoning,
          })),
        });
      }
    }

    return { data: multis };
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

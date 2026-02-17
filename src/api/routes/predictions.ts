import type { FastifyPluginAsync } from 'fastify';
import { sql } from '../../db/pool.js';
import { type MatchPick, type ScoredMatch, scoreMatch, groupByMatch } from '../scoring.js';
import { getAccuracyStats, getAccuracyHistory } from '../../db/queries.js';
import { getCached, setCached, computeETag } from '../cache.js';

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
        array_agg(DISTINCT p.pick_type) as pick_types,
        (SELECT coalesce(json_agg(json_build_object(
          'pick_type', sub.pick_type,
          'side', sub.side,
          'count', sub.cnt,
          'best_confidence', sub.best_confidence,
          'avg_value', sub.avg_value
        )), '[]'::json) FROM (
          SELECT
            p2.pick_type,
            p2.side,
            count(*)::int as cnt,
            CASE max(CASE p2.confidence
              WHEN 'best_bet' THEN 4 WHEN 'high' THEN 3
              WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END)
              WHEN 4 THEN 'best_bet' WHEN 3 THEN 'high'
              WHEN 2 THEN 'medium' WHEN 1 THEN 'low' ELSE null END
              as best_confidence,
            round(avg(p2.value)::numeric, 1) as avg_value
          FROM predictions p2
          WHERE p2.match_id = m.id
          GROUP BY p2.pick_type, p2.side
        ) sub) as tips
      FROM matches m
      JOIN teams ht ON ht.id = m.home_team_id
      JOIN teams att ON att.id = m.away_team_id
      LEFT JOIN predictions p ON p.match_id = m.id
      LEFT JOIN sources s ON s.id = p.source_id
      WHERE 1=1
        ${sport ? sql`AND m.sport = ${sport}` : sql``}
        ${date ? sql`AND m.game_date = ${date}` : sql`AND m.game_date >= CURRENT_DATE`}
        ${source ? sql`AND s.slug = ${source}` : sql``}
      GROUP BY m.id, m.sport, m.game_date, m.game_time,
               ht.name, ht.abbreviation, att.name, att.abbreviation
      HAVING count(p.id) > 0
      ORDER BY m.game_date ASC, m.game_time ASC NULLS LAST
      LIMIT 200
    `;

    return { data: matches, count: matches.length };
  });

  // Shared SQL query for fetching all upcoming predictions (with team IDs for scoring)
  async function fetchUpcomingPicks(sportFilter?: string, dateFilter?: string) {
    return sql<MatchPick[]>`
      SELECT
        m.id as match_id,
        to_char(m.game_date, 'YYYY-MM-DD') as game_date,
        m.game_time,
        m.sport,
        ht.name as home_team,
        att.name as away_team,
        m.home_team_id,
        m.away_team_id,
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
      WHERE 1=1
        ${dateFilter ? sql`AND m.game_date = ${dateFilter}` : sql`AND m.game_date >= CURRENT_DATE`}
        ${sportFilter ? sql`AND m.sport = ${sportFilter}` : sql``}
      ORDER BY m.game_date, m.id
    `;
  }

  // Score all matches (async), optionally filtering by minimum threshold
  async function scoreAllMatches(picks: MatchPick[], minScore: number): Promise<ScoredMatch[]> {
    const matchMap = groupByMatch(picks);
    const entries = [...matchMap.entries()];

    // Process in batches of 10 for concurrency control
    const scored: ScoredMatch[] = [];
    for (let i = 0; i < entries.length; i += 10) {
      const batch = entries.slice(i, i + 10);
      const results = await Promise.all(
        batch.map(([matchId, { info, picks: matchPicks }]) =>
          scoreMatch(matchId, info, matchPicks),
        ),
      );
      for (const result of results) {
        if (result && result.score >= minScore) scored.push(result);
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  // GET /predictions/top-picks — flat top-N picks sorted by score
  app.get('/top-picks', async (request, reply) => {
    const { sport, date, limit: limitStr } = request.query as {
      sport?: string;
      date?: string;
      limit?: string;
    };

    const limit = Math.min(Math.max(parseInt(limitStr || '5', 10) || 5, 1), 10);
    const cacheKey = [sport || 'all', date || 'upcoming', 'top-picks', String(limit)];

    const cached = await getCached<ReturnType<typeof formatTopPicks>>(cacheKey);
    if (cached) {
      const etag = computeETag(cached);
      if (request.headers['if-none-match'] === etag) {
        return reply.status(304).send();
      }
      void reply.header('Cache-Control', 'public, max-age=300');
      void reply.header('ETag', etag);
      return cached;
    }

    const picks = await fetchUpcomingPicks(sport, date);
    const scored = await scoreAllMatches(picks, 30);
    const topPicks = scored.slice(0, limit);
    const result = formatTopPicks(topPicks);

    await setCached(cacheKey, result);
    const etag = computeETag(result);
    void reply.header('Cache-Control', 'public, max-age=300');
    void reply.header('ETag', etag);
    return result;
  });

  function formatTopPicks(topPicks: ScoredMatch[]) {
    return {
      data: topPicks.map((s, i) => ({
        rank: i + 1,
        score: s.score,
        match: `${s.homeTeam} vs ${s.awayTeam}`,
        sport: s.sport,
        date: s.date,
        pick: s.recommendation,
        analysis: s.analysis,
        breakdown: {
          confidence: s.confidenceScore,
          margin: s.marginScore,
          sourceAgreement: s.sourceAgreement,
          odds: s.oddsValue,
          alignment: s.alignmentScore,
          form: s.formScore,
          h2h: s.h2hScore,
          homeAdvantage: s.homeAdvantage,
        },
      })),
      generatedAt: new Date().toISOString(),
    };
  }

  // GET /predictions/best-multis — intelligent best picks with scoring engine
  app.get('/best-multis', async (request, reply) => {
    const { sport, date } = request.query as { sport?: string; date?: string };
    const cacheKey = [sport || 'all', date || 'upcoming', 'best-multis'];

    const cached = await getCached<{ data: unknown }>(cacheKey);
    if (cached) {
      const etag = computeETag(cached);
      if (request.headers['if-none-match'] === etag) {
        return reply.status(304).send();
      }
      void reply.header('Cache-Control', 'public, max-age=300');
      void reply.header('ETag', etag);
      return cached;
    }

    const picks = await fetchUpcomingPicks(sport, date);
    const scored = await scoreAllMatches(picks, 50);

    const byDate: Record<string, ScoredMatch[]> = {};
    for (const s of scored) {
      if (!byDate[s.date]) byDate[s.date] = [];
      byDate[s.date]!.push(s);
    }

    const result = {
      data: Object.entries(byDate)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, dayPicks]) => ({
          date,
          picks: dayPicks.sort((a, b) => (a.gameTime ?? '').localeCompare(b.gameTime ?? '')),
        })),
    };

    await setCached(cacheKey, result);
    const etag = computeETag(result);
    void reply.header('Cache-Control', 'public, max-age=300');
    void reply.header('ETag', etag);
    return result;
  });

  // GET /predictions/accuracy — win/loss stats by sport/pickType
  app.get('/accuracy', async (request) => {
    const { sport, pickType } = request.query as { sport?: string; pickType?: string };
    const stats = await getAccuracyStats({ sport, pickType });

    // Summarize into { sport, pickType, wins, losses, pushes, voids, winRate }
    const grouped: Record<string, { wins: number; losses: number; pushes: number; voids: number }> = {};
    for (const row of stats) {
      const key = `${row.sport}:${row.pick_type}`;
      if (!grouped[key]) grouped[key] = { wins: 0, losses: 0, pushes: 0, voids: 0 };
      const g = grouped[key]!;
      if (row.grade === 'win') g.wins = row.count;
      else if (row.grade === 'loss') g.losses = row.count;
      else if (row.grade === 'push') g.pushes = row.count;
      else if (row.grade === 'void') g.voids = row.count;
    }

    const data = Object.entries(grouped).map(([key, g]) => {
      const [s, pt] = key.split(':');
      const decided = g.wins + g.losses;
      return {
        sport: s,
        pickType: pt,
        ...g,
        winRate: decided > 0 ? Math.round((g.wins / decided) * 1000) / 10 : null,
      };
    });

    return { data };
  });

  // GET /predictions/accuracy/history?days=30
  app.get('/accuracy/history', async (request) => {
    const { days: daysStr } = request.query as { days?: string };
    const days = Math.min(Math.max(parseInt(daysStr || '30', 10) || 30, 1), 365);
    const data = await getAccuracyHistory(days);
    return { data };
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

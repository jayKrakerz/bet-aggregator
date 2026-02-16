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

  // GET /predictions/best-multis — intelligent best picks with scoring engine
  app.get('/best-multis', async () => {
    // Fetch ALL predictions grouped by match (not just moneyline)
    const picks = await sql<
      {
        match_id: number;
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
        m.id as match_id,
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
      WHERE m.game_date >= CURRENT_DATE - INTERVAL '1 day'
      ORDER BY m.game_date, m.id
    `;

    type Pick = (typeof picks)[number];

    // --- Group by match ---
    const matchMap = new Map<
      number,
      { info: Pick; picks: Pick[] }
    >();
    for (const p of picks) {
      if (!matchMap.has(p.match_id)) {
        matchMap.set(p.match_id, { info: p, picks: [] });
      }
      matchMap.get(p.match_id)!.picks.push(p);
    }

    // --- Scoring functions ---
    // Weights: confidence 30, margin 25, source agreement 20, odds value 15, alignment 10

    function scoreSourceAgreement(matchPicks: Pick[]): { score: number; bestSide: string; sideCount: number; totalSources: number; disagreement: boolean } {
      const mlPicks = matchPicks.filter((p) => p.pick_type === 'moneyline');
      const sideSources: Record<string, Set<string>> = {};
      for (const p of mlPicks) {
        if (!sideSources[p.side]) sideSources[p.side] = new Set();
        sideSources[p.side]!.add(p.source_name);
      }

      let bestSide = '';
      let maxCount = 0;
      for (const [side, sources] of Object.entries(sideSources)) {
        if (sources.size > maxCount) {
          maxCount = sources.size;
          bestSide = side;
        }
      }

      const totalSources = new Set(mlPicks.map((p) => p.source_name)).size;
      // Check if sources actively disagree (different sides picked)
      const distinctSides = Object.keys(sideSources).length;
      const disagreement = distinctSides > 1;

      let score: number;
      if (disagreement) {
        // Penalize: sources disagree — subtract based on how split it is
        // e.g. 2 sources, each picking different side = -5
        const minority = totalSources - maxCount;
        score = Math.max(0, maxCount * 5 - minority * 8);
      } else if (maxCount >= 4) score = 20;
      else if (maxCount >= 3) score = 18;
      else if (maxCount >= 2) score = 14;
      else if (maxCount >= 1) score = 5;
      else score = 0;

      return { score, bestSide, sideCount: maxCount, totalSources, disagreement };
    }

    function scoreConfidence(matchPicks: Pick[], favSide: string): number {
      // Max 30 pts — most important signal since Forebet provides good confidence data
      const confValues: Record<string, number> = { best_bet: 30, high: 22, medium: 12, low: 4 };
      const sidePicks = matchPicks.filter((p) => p.side === favSide && p.confidence);
      if (!sidePicks.length) return 3; // no confidence data = almost no signal

      const scores = sidePicks.map((p) => confValues[p.confidence!] ?? 3);
      const highest = Math.max(...scores);
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      // Weighted: 70% highest, 30% average
      return Math.round(highest * 0.7 + avg * 0.3);
    }

    function extractAvgGoals(matchPicks: Pick[]): number | null {
      for (const p of matchPicks) {
        if (!p.reasoning) continue;
        const m = p.reasoning.match(/Avg goals:\s*([\d.]+)/i);
        if (m) return parseFloat(m[1]!);
      }
      return null;
    }

    function extractPredictedMargin(matchPicks: Pick[], sport: string): { margin: number | null; details: string[]; predictedDraw: boolean } {
      const details: string[] = [];
      let totalMargin = 0;
      let count = 0;
      let predictedDraw = false;
      const seen = new Set<string>();

      for (const p of matchPicks) {
        if (!p.reasoning) continue;
        const predMatch = p.reasoning.match(/Predicted:\s*(\d{1,3})\s*-\s*(\d{1,3})/i);
        if (!predMatch) continue;

        const home = parseInt(predMatch[1]!, 10);
        const away = parseInt(predMatch[2]!, 10);
        // Deduplicate: same source can have multiple pick types with same predicted score
        const key = `${p.source_name}:${home}-${away}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Filter by sport: football scores are small, basketball scores are large
        if (sport === 'football' && (home > 20 || away > 20)) continue;
        if (sport === 'nba' && (home < 50 || away < 50)) continue;

        const margin = Math.abs(home - away);
        if (margin === 0) predictedDraw = true;
        totalMargin += margin;
        count++;
        details.push(`${p.source_name}: ${home}-${away}`);
      }

      if (!count) return { margin: null, details, predictedDraw };
      return { margin: totalMargin / count, details, predictedDraw };
    }

    function scoreMargin(margin: number | null, sport: string, predictedDraw: boolean): number {
      // Max 25 pts
      if (margin === null) return 5;
      if (predictedDraw) return 2; // predicted draw = low confidence in winner
      if (sport === 'football') {
        if (margin >= 3) return 25;
        if (margin >= 2) return 20;
        if (margin >= 1) return 12;
        return 3;
      }
      // nba
      if (margin >= 12) return 25;
      if (margin >= 8) return 20;
      if (margin >= 5) return 15;
      return 8;
    }

    function toDecimalOdds(value: number | null, sport: string): number | null {
      if (value == null) return null;
      if (sport === 'football') return value;
      if (value < 0) return 1 + 100 / Math.abs(value);
      return 1 + value / 100;
    }

    function scoreOddsValue(matchPicks: Pick[], favSide: string, sport: string): { score: number; bestOdds: number | null; impliedProb: number | null } {
      // Max 15 pts
      const sidePicks = matchPicks.filter((p) => p.side === favSide && p.value != null);
      if (!sidePicks.length) return { score: 3, bestOdds: null, impliedProb: null };

      const decOddsList = sidePicks
        .map((p) => toDecimalOdds(p.value, sport))
        .filter((d): d is number => d !== null);

      if (!decOddsList.length) return { score: 3, bestOdds: null, impliedProb: null };

      const bestOdds = Math.min(...decOddsList);
      const impliedProb = Math.round((1 / bestOdds) * 1000) / 10;

      let score: number;
      if (sport === 'football') {
        if (bestOdds >= 1.20 && bestOdds <= 1.70) score = 15;
        else if (bestOdds > 1.70 && bestOdds <= 2.20) score = 12;
        else if (bestOdds > 2.20) score = 8;
        else score = 5; // < 1.20, too heavy
      } else {
        if (bestOdds >= 1.33 && bestOdds <= 2.0) score = 15;
        else if (bestOdds < 1.33) score = 5;
        else score = 8;
      }

      return { score, bestOdds: Math.round(bestOdds * 100) / 100, impliedProb };
    }

    function scoreAlignment(matchPicks: Pick[], favSide: string, avgGoals: number | null): number {
      // Max 10 pts — cross-pick-type validation
      let score = 0;

      // ML + spread agree
      const mlPicks = matchPicks.filter((p) => p.pick_type === 'moneyline' && p.side === favSide);
      const spreadPicks = matchPicks.filter((p) => p.pick_type === 'spread' && p.side === favSide);
      if (mlPicks.length > 0 && spreadPicks.length > 0) score += 3;

      // BTTS + O/U cross-validation
      const bttsPicks = matchPicks.filter((p) => p.pick_type === 'prop');
      const ouPicks = matchPicks.filter((p) => p.pick_type === 'over_under');
      const bttsYes = bttsPicks.some((p) => p.side === 'yes');
      const bttsNo = bttsPicks.some((p) => p.side === 'no');
      const ouOver = ouPicks.some((p) => p.side === 'over');
      const ouUnder = ouPicks.some((p) => p.side === 'under');

      // BTTS=yes + over agree = high-scoring game signal
      if (bttsYes && ouOver) score += 3;
      // BTTS=no + under agree = low-scoring game signal
      else if (bttsNo && ouUnder) score += 3;
      // BTTS and O/U conflict = weaker signal
      else if ((bttsYes && ouUnder) || (bttsNo && ouOver)) score += 0;
      // At least one O/U or BTTS exists
      else if (ouPicks.length > 0 || bttsPicks.length > 0) score += 1;

      // Avg goals corroborates O/U direction
      if (avgGoals !== null) {
        if (ouOver && avgGoals >= 2.5) score += 2;
        else if (ouUnder && avgGoals < 2.0) score += 2;
        else if (avgGoals >= 2.0 && avgGoals < 2.5) score += 1;
      }

      return Math.min(score, 10);
    }

    function generateAnalysis(
      info: Pick,
      favSide: string,
      srcAgreement: { sideCount: number; totalSources: number; disagreement: boolean },
      marginDetails: string[],
      matchPicks: Pick[],
      compositeScore: number,
      avgGoals: number | null,
    ): string {
      const parts: string[] = [];
      const teamName = favSide === 'home' ? info.home_team : favSide === 'away' ? info.away_team : 'Draw';

      // Source consensus or disagreement
      if (srcAgreement.disagreement) {
        parts.push(
          `${srcAgreement.sideCount} of ${srcAgreement.totalSources} sources back ${teamName} (sources split).`,
        );
      } else if (srcAgreement.sideCount >= 2) {
        parts.push(
          `${srcAgreement.sideCount} of ${srcAgreement.totalSources} sources back ${teamName}.`,
        );
      } else if (srcAgreement.totalSources > 0) {
        const source = matchPicks.find((p) => p.side === favSide)?.source_name;
        parts.push(`Picked by ${source ?? 'one source'}.`);
      }

      // Predicted scores (deduplicated)
      if (marginDetails.length > 0) {
        parts.push(`Predicted: ${marginDetails.join(', ')}.`);
      }

      // Best confidence signal
      const bestConfPick = matchPicks
        .filter((p) => p.side === favSide && p.confidence)
        .sort((a, b) => {
          const order: Record<string, number> = { best_bet: 4, high: 3, medium: 2, low: 1 };
          return (order[b.confidence!] ?? 0) - (order[a.confidence!] ?? 0);
        })[0];

      if (bestConfPick) {
        const confLabel = bestConfPick.confidence!.replace('_', ' ');
        parts.push(`Rated '${confLabel}' by ${bestConfPick.source_name}.`);
      }

      // Avg goals context
      if (avgGoals !== null && info.sport === 'football') {
        parts.push(`Avg goals: ${avgGoals.toFixed(1)}/game.`);
      }

      // BTTS + O/U alignment
      const bttsYes = matchPicks.some((p) => p.pick_type === 'prop' && p.side === 'yes');
      const ouOver = matchPicks.some((p) => p.pick_type === 'over_under' && p.side === 'over');
      const bttsNo = matchPicks.some((p) => p.pick_type === 'prop' && p.side === 'no');
      const ouUnder = matchPicks.some((p) => p.pick_type === 'over_under' && p.side === 'under');
      if (bttsYes && ouOver) parts.push('BTTS and over agree — expect goals.');
      else if (bttsNo && ouUnder) parts.push('BTTS=no and under agree — tight game expected.');

      if (!parts.length) {
        parts.push(`Score ${compositeScore}/100 based on available signals.`);
      }

      return parts.join(' ');
    }

    // --- Score each match ---
    interface ScoredMatch {
      matchId: number;
      date: string;
      sport: string;
      homeTeam: string;
      awayTeam: string;
      gameTime: string | null;
      recommendation: string;
      pickType: string;
      score: number;
      sourceAgreement: number;
      confidenceScore: number;
      marginScore: number;
      oddsValue: number;
      alignmentScore: number;
      analysis: string;
      sources: { name: string; side: string; confidence: string | null; detail: string }[];
      bestOdds: number | null;
      impliedProb: number | null;
    }

    const scored: ScoredMatch[] = [];

    for (const [matchId, { info, picks: matchPicks }] of matchMap) {
      const srcResult = scoreSourceAgreement(matchPicks);
      if (!srcResult.bestSide) continue; // no moneyline picks at all

      const favSide = srcResult.bestSide;
      const confScore = scoreConfidence(matchPicks, favSide);
      const avgGoals = extractAvgGoals(matchPicks);
      const { margin, details: marginDetails, predictedDraw } = extractPredictedMargin(matchPicks, info.sport);
      const mrgScore = scoreMargin(margin, info.sport, predictedDraw);
      const oddsResult = scoreOddsValue(matchPicks, favSide, info.sport);
      const alignScore = scoreAlignment(matchPicks, favSide, avgGoals);

      const composite = srcResult.score + confScore + mrgScore + oddsResult.score + alignScore;

      // Minimum quality threshold: only show picks with strong signal
      if (composite < 50) continue;

      // Determine best pick type — prefer moneyline, but use spread if no ML
      const hasMl = matchPicks.some((p) => p.pick_type === 'moneyline' && p.side === favSide);
      const pickType = hasMl ? 'moneyline' : 'spread';

      const analysis = generateAnalysis(info, favSide, srcResult, marginDetails, matchPicks, composite, avgGoals);

      // Build sources list
      const sources = matchPicks
        .filter((p) => p.side === favSide || p.pick_type === 'over_under')
        .reduce<ScoredMatch['sources']>((acc, p) => {
          // Deduplicate by source
          if (acc.some((s) => s.name === p.source_name && s.side === p.side)) return acc;
          let detail = '';
          if (p.pick_type === 'moneyline' && p.value != null) {
            detail = `ML: ${p.value}`;
          } else if (p.pick_type === 'spread' && p.value != null) {
            detail = `Spread: ${p.value > 0 ? '+' : ''}${p.value}`;
          } else if (p.pick_type === 'over_under' && p.value != null) {
            detail = `${p.side} ${p.value}`;
          }
          if (p.reasoning) {
            const predMatch = p.reasoning.match(/Predicted:\s*[\d]+-[\d]+/i);
            if (predMatch) detail += detail ? ` | ${predMatch[0]}` : predMatch[0];
          }
          acc.push({
            name: p.source_name,
            side: p.side,
            confidence: p.confidence,
            detail,
          });
          return acc;
        }, []);

      const dateStr = info.game_date.toString();
      const date = dateStr.includes('T') ? dateStr.split('T')[0]! : dateStr;

      scored.push({
        matchId,
        date,
        sport: info.sport,
        homeTeam: info.home_team,
        awayTeam: info.away_team,
        gameTime: info.game_time,
        recommendation: favSide,
        pickType,
        score: composite,
        sourceAgreement: srcResult.score,
        confidenceScore: confScore,
        marginScore: mrgScore,
        oddsValue: oddsResult.score,
        alignmentScore: alignScore,
        analysis,
        sources,
        bestOdds: oddsResult.bestOdds,
        impliedProb: oddsResult.impliedProb,
      });
    }

    // --- Group by date, show all qualifying picks ---
    scored.sort((a, b) => b.score - a.score);

    const byDate: Record<string, ScoredMatch[]> = {};
    for (const s of scored) {
      if (!byDate[s.date]) byDate[s.date] = [];
      byDate[s.date]!.push(s);
    }

    const result = Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, dayPicks]) => ({
        date,
        picks: dayPicks.sort((a, b) => b.score - a.score),
      }));

    return { data: result };
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

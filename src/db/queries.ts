import { sql } from './pool.js';
import type { NormalizedPrediction } from '../types/prediction.js';
import type { MatchStatus, Grade } from '../types/result.js';

interface FindOrCreateMatchInput {
  sport: string;
  homeTeamId: number;
  awayTeamId: number;
  gameDate: string;
  gameTime: string | null;
}

export async function findOrCreateMatch(input: FindOrCreateMatchInput): Promise<number> {
  const [existing] = await sql<{ id: number }[]>`
    SELECT id FROM matches
    WHERE sport = ${input.sport}
      AND home_team_id = ${input.homeTeamId}
      AND away_team_id = ${input.awayTeamId}
      AND game_date = ${input.gameDate}
  `;

  if (existing) return existing.id;

  const [created] = await sql<{ id: number }[]>`
    INSERT INTO matches (sport, home_team_id, away_team_id, game_date, game_time)
    VALUES (${input.sport}, ${input.homeTeamId}, ${input.awayTeamId}, ${input.gameDate}, ${input.gameTime})
    ON CONFLICT (sport, home_team_id, away_team_id, game_date) DO UPDATE SET game_date = EXCLUDED.game_date
    RETURNING id
  `;

  return created!.id;
}

export async function insertPrediction(pred: NormalizedPrediction): Promise<boolean> {
  // Look up the numeric source ID from the slug
  const [source] = await sql<{ id: number }[]>`
    SELECT id FROM sources WHERE slug = ${pred.sourceId}
  `;
  if (!source) return false;

  const result = await sql`
    INSERT INTO predictions (
      source_id, match_id, sport, home_team_id, away_team_id,
      pick_type, side, value, picker_name, confidence,
      reasoning, dedup_key, fetched_at
    )
    VALUES (
      ${source.id}, ${pred.matchId}, ${pred.sport},
      ${pred.homeTeamId}, ${pred.awayTeamId},
      ${pred.pickType}, ${pred.side}, ${pred.value},
      ${pred.pickerName}, ${pred.confidence},
      ${pred.reasoning}, ${pred.dedupKey}, ${pred.fetchedAt}
    )
    ON CONFLICT (dedup_key) DO NOTHING
  `;

  return result.count > 0;
}

export async function getSourceBySlug(slug: string) {
  const [source] = await sql`
    SELECT id, slug, name, base_url, fetch_method, is_active, last_fetched_at, created_at
    FROM sources WHERE slug = ${slug}
  `;
  return source ?? null;
}

export async function updateSourceLastFetched(slug: string): Promise<void> {
  await sql`
    UPDATE sources SET last_fetched_at = NOW() WHERE slug = ${slug}
  `;
}

/**
 * Create a team and its lowercase alias in one go.
 * Used for auto-creating football teams that aren't in the curated seed data.
 * Uses team name as abbreviation since football teams don't have standard abbreviations.
 */
export async function createTeamWithAlias(name: string, sport: string): Promise<number> {
  const [team] = await sql<{ id: number }[]>`
    INSERT INTO teams (name, abbreviation, sport)
    VALUES (${name}, ${name}, ${sport})
    ON CONFLICT (abbreviation, sport) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;

  const teamId = team!.id;

  await sql`
    INSERT INTO team_aliases (team_id, alias)
    VALUES (${teamId}, ${name.toLowerCase()})
    ON CONFLICT (alias, team_id) DO NOTHING
  `;

  return teamId;
}

// ===== Match Results & Grading =====

export async function insertMatchResult(input: {
  matchId: number;
  homeScore: number;
  awayScore: number;
  status: MatchStatus;
  resultSource?: string;
}): Promise<boolean> {
  const result = await sql`
    INSERT INTO match_results (match_id, home_score, away_score, status, result_source)
    VALUES (${input.matchId}, ${input.homeScore}, ${input.awayScore}, ${input.status}, ${input.resultSource ?? 'espn'})
    ON CONFLICT (match_id) DO UPDATE SET
      home_score = EXCLUDED.home_score,
      away_score = EXCLUDED.away_score,
      status = EXCLUDED.status,
      settled_at = NOW()
  `;
  return result.count > 0;
}

export async function getUngradedPredictions(matchId: number) {
  return sql<{
    id: number;
    pick_type: string;
    side: string;
    value: number | null;
  }[]>`
    SELECT id, pick_type, side, value
    FROM predictions
    WHERE match_id = ${matchId} AND grade IS NULL
  `;
}

export async function updatePredictionGrade(
  predictionId: number,
  grade: Grade,
): Promise<void> {
  await sql`
    UPDATE predictions SET grade = ${grade}, graded_at = NOW()
    WHERE id = ${predictionId}
  `;
}

export async function getAccuracyStats(filters?: {
  sport?: string;
  pickType?: string;
}) {
  return sql<{
    sport: string;
    pick_type: string;
    grade: string;
    count: number;
  }[]>`
    SELECT sport, pick_type, grade, count(*)::int as count
    FROM predictions
    WHERE grade IS NOT NULL
      ${filters?.sport ? sql`AND sport = ${filters.sport}` : sql``}
      ${filters?.pickType ? sql`AND pick_type = ${filters.pickType}` : sql``}
    GROUP BY sport, pick_type, grade
    ORDER BY sport, pick_type, grade
  `;
}

export async function getAccuracyHistory(days: number = 30) {
  return sql<{
    date: string;
    wins: number;
    losses: number;
    pushes: number;
    total: number;
  }[]>`
    SELECT
      to_char(graded_at::date, 'YYYY-MM-DD') as date,
      count(*) FILTER (WHERE grade = 'win')::int as wins,
      count(*) FILTER (WHERE grade = 'loss')::int as losses,
      count(*) FILTER (WHERE grade = 'push')::int as pushes,
      count(*)::int as total
    FROM predictions
    WHERE grade IS NOT NULL AND graded_at >= NOW() - make_interval(days => ${days})
    GROUP BY graded_at::date
    ORDER BY graded_at::date DESC
  `;
}

export async function getTeamForm(teamId: number, limit: number = 10) {
  return sql<{
    match_id: number;
    is_home: boolean;
    home_score: number;
    away_score: number;
    game_date: string;
  }[]>`
    SELECT
      mr.match_id,
      (m.home_team_id = ${teamId}) as is_home,
      mr.home_score,
      mr.away_score,
      to_char(m.game_date, 'YYYY-MM-DD') as game_date
    FROM match_results mr
    JOIN matches m ON m.id = mr.match_id
    WHERE mr.status = 'final'
      AND (m.home_team_id = ${teamId} OR m.away_team_id = ${teamId})
    ORDER BY m.game_date DESC
    LIMIT ${limit}
  `;
}

export async function getH2HResults(homeTeamId: number, awayTeamId: number, limit: number = 10) {
  return sql<{
    home_score: number;
    away_score: number;
    game_date: string;
  }[]>`
    SELECT mr.home_score, mr.away_score, to_char(m.game_date, 'YYYY-MM-DD') as game_date
    FROM match_results mr
    JOIN matches m ON m.id = mr.match_id
    WHERE mr.status = 'final'
      AND m.home_team_id = ${homeTeamId} AND m.away_team_id = ${awayTeamId}
    ORDER BY m.game_date DESC
    LIMIT ${limit}
  `;
}

export async function getHomeSplit(teamId: number) {
  return sql<{ wins: number; total: number }[]>`
    SELECT
      count(*) FILTER (WHERE mr.home_score > mr.away_score)::int as wins,
      count(*)::int as total
    FROM match_results mr
    JOIN matches m ON m.id = mr.match_id
    WHERE mr.status = 'final' AND m.home_team_id = ${teamId}
  `;
}

export async function getAwaySplit(teamId: number) {
  return sql<{ wins: number; total: number }[]>`
    SELECT
      count(*) FILTER (WHERE mr.away_score > mr.home_score)::int as wins,
      count(*)::int as total
    FROM match_results mr
    JOIN matches m ON m.id = mr.match_id
    WHERE mr.status = 'final' AND m.away_team_id = ${teamId}
  `;
}

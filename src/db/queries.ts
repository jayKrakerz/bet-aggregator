import { sql } from './pool.js';
import type { NormalizedPrediction } from '../types/prediction.js';

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

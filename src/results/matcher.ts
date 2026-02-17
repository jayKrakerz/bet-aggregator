import { sql } from '../db/pool.js';
import { resolveTeamId } from '../pipeline/team-resolver.js';
import type { RawGameResult } from '../types/result.js';
import { logger } from '../utils/logger.js';

interface MatchedResult {
  matchId: number;
  homeScore: number;
  awayScore: number;
  status: RawGameResult['status'];
}

/**
 * Match ESPN results to internal match records via team alias resolution.
 */
export async function matchResults(results: RawGameResult[]): Promise<MatchedResult[]> {
  const matched: MatchedResult[] = [];

  for (const r of results) {
    const homeTeamId = resolveTeamId(r.homeTeamName);
    const awayTeamId = resolveTeamId(r.awayTeamName);

    if (!homeTeamId || !awayTeamId) {
      logger.debug(
        { home: r.homeTeamName, away: r.awayTeamName },
        'Could not resolve ESPN team names to internal IDs',
      );
      continue;
    }

    const [match] = await sql<{ id: number }[]>`
      SELECT id FROM matches
      WHERE sport = ${r.sport}
        AND home_team_id = ${homeTeamId}
        AND away_team_id = ${awayTeamId}
        AND game_date = ${r.gameDate}
    `;

    if (!match) {
      logger.debug(
        { sport: r.sport, homeTeamId, awayTeamId, date: r.gameDate },
        'No matching internal match found for ESPN result',
      );
      continue;
    }

    matched.push({
      matchId: match.id,
      homeScore: r.homeScore,
      awayScore: r.awayScore,
      status: r.status,
    });
  }

  logger.info({ input: results.length, matched: matched.length }, 'ESPN results matched');
  return matched;
}

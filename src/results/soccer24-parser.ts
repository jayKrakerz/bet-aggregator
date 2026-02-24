import type { RawGameResult, MatchStatus } from '../types/result.js';

/**
 * Parser for Soccer24/Flashscore pipe-delimited feed format.
 *
 * The feed uses these delimiters:
 *   ~ separates blocks (league headers vs match records)
 *   ¬ separates fields within a block
 *   ÷ separates field code from value
 */

// Field codes used in Soccer24/Flashscore feeds
const FIELD = {
  MATCH_ID: 'AA',
  STATUS: 'AB',
  TIMESTAMP: 'AD',
  HOME_TEAM: 'AE',
  AWAY_TEAM: 'AF',
  HOME_SCORE: 'AG',
  AWAY_SCORE: 'AH',
} as const;

// Soccer24 status codes → internal MatchStatus
const STATUS_MAP: Record<string, MatchStatus | null> = {
  '3': 'final',       // Finished (regular time)
  '4': 'final',       // After extra time
  '5': 'final',       // After penalties
  '9': 'postponed',
  '10': 'cancelled',
  '11': 'cancelled',  // Abandoned
};

export interface Soccer24Match {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  status: MatchStatus;
  timestamp: number;
  gameDate: string;
}

/**
 * Parse a pipe-delimited feed string into structured match objects.
 * Only returns completed/postponed/cancelled matches.
 */
export function parseSoccer24Feed(feedData: string): Soccer24Match[] {
  const matches: Soccer24Match[] = [];
  const blocks = feedData.split('~');

  for (const block of blocks) {
    const fields = parseFields(block);

    // Skip league header blocks (no match ID)
    const matchId = fields.get(FIELD.MATCH_ID);
    if (!matchId) continue;

    const statusCode = fields.get(FIELD.STATUS);
    if (!statusCode) continue;

    const status = STATUS_MAP[statusCode];
    if (!status) continue; // skip in-progress, not started, etc.

    const homeTeam = fields.get(FIELD.HOME_TEAM);
    const awayTeam = fields.get(FIELD.AWAY_TEAM);
    const homeScoreStr = fields.get(FIELD.HOME_SCORE);
    const awayScoreStr = fields.get(FIELD.AWAY_SCORE);
    const timestampStr = fields.get(FIELD.TIMESTAMP);

    if (!homeTeam || !awayTeam || homeScoreStr == null || awayScoreStr == null) continue;

    const homeScore = parseInt(homeScoreStr, 10);
    const awayScore = parseInt(awayScoreStr, 10);
    if (isNaN(homeScore) || isNaN(awayScore)) continue;

    const timestamp = timestampStr ? parseInt(timestampStr, 10) : 0;
    const gameDate = timestamp
      ? new Date(timestamp * 1000).toISOString().split('T')[0]!
      : '';

    matches.push({
      matchId,
      homeTeam,
      awayTeam,
      homeScore,
      awayScore,
      status,
      timestamp,
      gameDate,
    });
  }

  return matches;
}

/**
 * Convert parsed Soccer24 matches to the standard RawGameResult format.
 */
export function toRawGameResults(matches: Soccer24Match[]): RawGameResult[] {
  return matches.map((m) => ({
    sport: 'football',
    homeTeamName: m.homeTeam,
    awayTeamName: m.awayTeam,
    homeScore: m.homeScore,
    awayScore: m.awayScore,
    gameDate: m.gameDate,
    status: m.status,
  }));
}

function parseFields(block: string): Map<string, string> {
  const fields = new Map<string, string>();
  const parts = block.split('¬');
  for (const part of parts) {
    const sepIdx = part.indexOf('÷');
    if (sepIdx > 0) {
      fields.set(part.slice(0, sepIdx), part.slice(sepIdx + 1));
    }
  }
  return fields;
}

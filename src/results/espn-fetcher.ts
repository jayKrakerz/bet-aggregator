import { request } from 'undici';
import type { RawGameResult, MatchStatus } from '../types/result.js';
import { logger } from '../utils/logger.js';

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

const SPORT_PATHS: Record<string, string> = {
  nba: 'basketball/nba',
  nfl: 'football/nfl',
  nhl: 'hockey/nhl',
  mlb: 'baseball/mlb',
  ncaab: 'basketball/mens-college-basketball',
};

interface EspnCompetitor {
  homeAway: 'home' | 'away';
  team: { displayName: string };
  score: string;
}

interface EspnStatus {
  type: { name: string; completed: boolean };
}

interface EspnEvent {
  competitions: Array<{
    competitors: EspnCompetitor[];
    status: EspnStatus;
    date: string;
  }>;
}

interface EspnResponse {
  events?: EspnEvent[];
}

function mapStatus(statusName: string): MatchStatus | null {
  if (statusName === 'STATUS_FINAL') return 'final';
  if (statusName === 'STATUS_POSTPONED') return 'postponed';
  if (statusName === 'STATUS_CANCELED' || statusName === 'STATUS_CANCELLED') return 'cancelled';
  return null;
}

/**
 * Fetch game results from ESPN public scoreboard API for a given sport and date.
 * Returns only completed/postponed/cancelled games.
 */
export async function fetchEspnResults(sport: string, dateStr: string): Promise<RawGameResult[]> {
  const sportPath = SPORT_PATHS[sport];
  if (!sportPath) return [];

  const dateParam = dateStr.replace(/-/g, '');
  const url = `${ESPN_BASE}/${sportPath}/scoreboard?dates=${dateParam}`;

  const log = logger.child({ sport, date: dateStr });

  let data: EspnResponse;
  try {
    const res = await request(url, {
      headers: { 'User-Agent': 'bet-aggregator/1.0' },
    });
    data = (await res.body.json()) as EspnResponse;
  } catch (err) {
    log.warn({ err, url }, 'ESPN fetch failed');
    return [];
  }

  const results: RawGameResult[] = [];

  for (const event of data.events ?? []) {
    const comp = event.competitions[0];
    if (!comp) continue;

    const status = mapStatus(comp.status.type.name);
    if (!status) continue;

    const home = comp.competitors.find((c) => c.homeAway === 'home');
    const away = comp.competitors.find((c) => c.homeAway === 'away');
    if (!home || !away) continue;

    const homeScore = parseInt(home.score, 10);
    const awayScore = parseInt(away.score, 10);
    if (isNaN(homeScore) || isNaN(awayScore)) continue;

    const gameDate = comp.date ? comp.date.split('T')[0]! : dateStr;

    results.push({
      sport,
      homeTeamName: home.team.displayName,
      awayTeamName: away.team.displayName,
      homeScore,
      awayScore,
      gameDate,
      status,
    });
  }

  log.info({ count: results.length }, 'ESPN results fetched');
  return results;
}

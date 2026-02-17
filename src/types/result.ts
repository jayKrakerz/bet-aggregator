export type MatchStatus = 'final' | 'postponed' | 'cancelled';
export type Grade = 'win' | 'loss' | 'push' | 'void';

export interface MatchResult {
  id: number;
  matchId: number;
  homeScore: number;
  awayScore: number;
  status: MatchStatus;
  resultSource: string;
  settledAt: Date;
  createdAt: Date;
}

/** Raw game result from ESPN or similar */
export interface RawGameResult {
  sport: string;
  homeTeamName: string;
  awayTeamName: string;
  homeScore: number;
  awayScore: number;
  gameDate: string;
  status: MatchStatus;
}

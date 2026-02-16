export interface Team {
  id: number;
  name: string;
  abbreviation: string;
  sport: string;
}

export interface TeamAlias {
  id: number;
  teamId: number;
  alias: string;
}

export interface Match {
  id: number;
  sport: string;
  homeTeamId: number;
  awayTeamId: number;
  gameDate: string;
  gameTime: string | null;
  externalId: string | null;
  createdAt: Date;
}

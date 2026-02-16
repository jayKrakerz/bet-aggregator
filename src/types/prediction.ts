export type PickType = 'spread' | 'moneyline' | 'over_under' | 'prop' | 'parlay';
export type Side = 'home' | 'away' | 'over' | 'under' | 'draw' | 'yes' | 'no';
export type Confidence = 'low' | 'medium' | 'high' | 'best_bet';

/** Directly extracted from site HTML. Minimal normalization. */
export interface RawPrediction {
  sourceId: string;
  sport: string;
  homeTeamRaw: string;
  awayTeamRaw: string;
  /** ISO date string, e.g. '2026-02-16' */
  gameDate: string;
  /** Raw time string, e.g. '7:30 PM ET' */
  gameTime: string | null;
  pickType: PickType;
  side: Side;
  /** Spread value, total, or moneyline odds */
  value: number | null;
  pickerName: string;
  confidence: Confidence | null;
  reasoning: string | null;
  fetchedAt: Date;
}

/** After normalization: team IDs resolved, match linked, dedup key computed. */
export interface NormalizedPrediction
  extends Omit<RawPrediction, 'homeTeamRaw' | 'awayTeamRaw'> {
  homeTeamId: number;
  awayTeamId: number;
  matchId: number;
  dedupKey: string;
}

import { z } from 'zod';
import { VFL_TEAMS } from './constants.js';

export const VflTeamSchema = z.enum(VFL_TEAMS);
export type VflTeam = z.infer<typeof VflTeamSchema>;

export const MatchResultSchema = z.object({
  home: VflTeamSchema,
  away: VflTeamSchema,
  homeScore: z.number().int().min(0).max(9),
  awayScore: z.number().int().min(0).max(9),
}).refine(d => d.home !== d.away, { message: 'Home and away must be different teams' });

export type MatchResult = z.infer<typeof MatchResultSchema>;

export const WeekResultsSchema = z.object({
  week: z.number().int().min(1).max(38),
  league: z.string().min(1).max(50),
  matches: z.array(MatchResultSchema).min(1).max(10),
});

export type WeekResults = z.infer<typeof WeekResultsSchema>;

export const LeagueDataSchema = z.object({
  league: z.string(),
  weeks: z.array(z.object({
    week: z.number(),
    matches: z.array(z.object({
      home: VflTeamSchema,
      away: VflTeamSchema,
      homeScore: z.number(),
      awayScore: z.number(),
    })),
  })),
  createdAt: z.string(),
});

export type LeagueData = z.infer<typeof LeagueDataSchema>;

export const VflStoreSchema = z.object({
  leagues: z.array(LeagueDataSchema),
});

export type VflStore = z.infer<typeof VflStoreSchema>;

export type FormResult = 'W' | 'D' | 'L';

export interface ScoreForm {
  scored: number;
  conceded: number;
  total: number;
  isOver: boolean;
  isGG: boolean;
}

export interface TeamStats {
  team: VflTeam;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsScored: number;
  goalsConceded: number;
  goalDifference: number;
  points: number;
  position: number;
  form: FormResult[];
  scoringForm: ScoreForm[];
  overStreak: number;
  underStreak: number;
  ggStreak: number;
  ngStreak: number;
  overRate: number;
  ggRate: number;
}

export type DiscType = 'CORD' | 'MULTI_CORD' | 'BANK' | 'UNKNOWN';

export interface DiscDetection {
  type: DiscType;
  confidence: number;
  reasons: string[];
}

export interface Alert {
  team: VflTeam;
  type: 'OVER_ENTRY' | 'SCORING_FORM_VS_ACTIVATOR' | 'LONG_UNDER_EXIT';
  message: string;
  week: number;
}

export interface Pick {
  team: VflTeam;
  opponent: VflTeam;
  isHome: boolean;
  suggestion: 'TRIO' | 'OVER_2.5' | 'STRAIGHT_WIN' | 'SKIP';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  criteriaPass: number;
  reasons: string[];
}

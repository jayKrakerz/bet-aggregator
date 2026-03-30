export const VFL_TEAMS = [
  'MNC', 'LIV', 'ARS', 'CHE', 'MNU', 'TOT', 'EVE', 'LEI', 'SOU', 'WHU',
  'CRY', 'WOL', 'BRI', 'BUR', 'LEE', 'WBA', 'ASV', 'NWC', 'SHU', 'FUL',
] as const;

export const MAJOR_TEAMS = ['MNC', 'LIV', 'ARS', 'EVE'] as const;

export const STRONG_TEAMS = ['MNC', 'LIV', 'ARS', 'CHE', 'MNU', 'TOT'] as const;
export const BALANCE_TEAMS = ['EVE', 'LEI', 'SOU', 'WHU', 'CRY', 'WOL'] as const;
export const WEAK_TEAMS = ['BRI', 'BUR', 'LEE', 'WBA', 'ASV', 'NWC', 'SHU', 'FUL'] as const;

// Default Predators: teams that tend to produce UNDER results
export const GENERAL_PREDATORS = ['SOU', 'WHU', 'LEI', 'TOT'] as const;
// Default Activators: teams that tend to produce OVER results
export const GENERAL_ACTIVATORS = ['BRI', 'BUR', 'NWC', 'LEE'] as const;

// Per-major-team Predators & Activators from VFL Mentor 3
export const TEAM_PREDATORS: Record<string, readonly string[]> = {
  MNC: ['SOU', 'WHU', 'LEI', 'CHE'],
  LIV: ['SOU', 'LEI', 'CHE', 'WBA'],
  ARS: ['WHU', 'TOT', 'WOL', 'CRY'],
  EVE: ['WHU', 'WBA', 'TOT', 'WOL'],
};

export const TEAM_ACTIVATORS: Record<string, readonly string[]> = {
  MNC: ['BRI', 'LEE', 'BUR', 'SHU'],
  LIV: ['FUL', 'LEE', 'BRI', 'NWC'],
  ARS: ['NWC', 'LEE', 'EVE', 'BRI'],
  EVE: ['BRI', 'ARS', 'LEE', 'FUL'],
};

// Targeted teams (best matchups for wins)
export const TARGETED_TEAMS: Record<string, readonly string[]> = {
  MNC: ['CRY', 'MNU', 'NWC', 'TOT'],
  LIV: ['LEE', 'ARS', 'BUR', 'FUL'],
  ARS: ['NWC', 'EVE', 'LEE', 'SHU'],
  EVE: ['BRI', 'SOU', 'ARS', 'CRY'],
};

// 22 possible scorelines in VFL (RNG processor)
export const VFL_SCORELINES = [
  '0:0', '1:0', '0:1', '1:1', '2:0', '0:2', '2:1', '1:2',
  '2:2', '3:0', '0:3', '3:1', '1:3', '3:2', '2:3', '3:3',
  '4:0', '0:4', '4:1', '1:4', '4:2', '2:4',
] as const;

export const TEAM_FULL_NAMES: Record<string, string> = {
  MNC: 'Man City', LIV: 'Liverpool', MNU: 'Man United', CHE: 'Chelsea',
  ARS: 'Arsenal', TOT: 'Tottenham', EVE: 'Everton', LEI: 'Leicester',
  SOU: 'Southampton', WHU: 'West Ham', CRY: 'Crystal Palace', WOL: 'Wolverhampton',
  BRI: 'Brighton', BUR: 'Burnley', LEE: 'Leeds United', WBA: 'West Brom',
  ASV: 'Aston Villa', NWC: 'Newcastle', SHU: 'Sheffield United', FUL: 'Fulham',
};

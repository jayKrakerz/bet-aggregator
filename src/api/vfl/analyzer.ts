import { getLeague } from './store.js';
import { VFL_TEAMS, MAJOR_TEAMS, GENERAL_PREDATORS, GENERAL_ACTIVATORS, TEAM_PREDATORS, TEAM_ACTIVATORS } from './constants.js';
import type { VflTeam, TeamStats, FormResult, ScoreForm, DiscType, DiscDetection, Alert, LeagueData } from './types.js';

interface MatchFlat {
  home: VflTeam;
  away: VflTeam;
  homeScore: number;
  awayScore: number;
  week: number;
}

function flattenMatches(league: LeagueData): MatchFlat[] {
  const matches: MatchFlat[] = [];
  for (const w of league.weeks) {
    for (const m of w.matches) {
      matches.push({ ...m, week: w.week });
    }
  }
  return matches;
}

function getTeamMatches(matches: MatchFlat[], team: VflTeam): Array<MatchFlat & { scored: number; conceded: number; result: FormResult }> {
  return matches
    .filter(m => m.home === team || m.away === team)
    .sort((a, b) => a.week - b.week)
    .map(m => {
      const isHome = m.home === team;
      const scored = isHome ? m.homeScore : m.awayScore;
      const conceded = isHome ? m.awayScore : m.homeScore;
      const result: FormResult = scored > conceded ? 'W' : scored < conceded ? 'L' : 'D';
      return { ...m, scored, conceded, result };
    });
}

export function getTeamStats(leagueId: string, team: VflTeam): TeamStats | null {
  const league = getLeague(leagueId);
  if (!league) return null;

  const all = flattenMatches(league);
  const teamMatches = getTeamMatches(all, team);

  if (teamMatches.length === 0) {
    return {
      team, played: 0, won: 0, drawn: 0, lost: 0,
      goalsScored: 0, goalsConceded: 0, goalDifference: 0,
      points: 0, position: 0, form: [], scoringForm: [],
      overStreak: 0, underStreak: 0, ggStreak: 0, ngStreak: 0,
      overRate: 0, ggRate: 0,
    };
  }

  let won = 0, drawn = 0, lost = 0, gs = 0, gc = 0;
  let overCount = 0, ggCount = 0;

  for (const m of teamMatches) {
    if (m.result === 'W') won++;
    else if (m.result === 'D') drawn++;
    else lost++;
    gs += m.scored;
    gc += m.conceded;
    if (m.scored + m.conceded > 2) overCount++;
    if (m.scored > 0 && m.conceded > 0) ggCount++;
  }

  // Last 5 form
  const last5 = teamMatches.slice(-5);
  const form: FormResult[] = last5.map(m => m.result);
  const scoringForm: ScoreForm[] = last5.map(m => ({
    scored: m.scored,
    conceded: m.conceded,
    total: m.scored + m.conceded,
    isOver: m.scored + m.conceded > 2,
    isGG: m.scored > 0 && m.conceded > 0,
  }));

  // Streak calculation (walk backwards)
  let overStreak = 0, underStreak = 0, ggStreak = 0, ngStreak = 0;

  for (let i = teamMatches.length - 1; i >= 0; i--) {
    const m = teamMatches[i]!;
    const total = m.scored + m.conceded;
    if (total > 2) {
      if (underStreak === 0) overStreak++;
      else break;
    } else {
      if (overStreak === 0) underStreak++;
      else break;
    }
  }

  for (let i = teamMatches.length - 1; i >= 0; i--) {
    const m = teamMatches[i]!;
    const isGG = m.scored > 0 && m.conceded > 0;
    if (isGG) {
      if (ngStreak === 0) ggStreak++;
      else break;
    } else {
      if (ggStreak === 0) ngStreak++;
      else break;
    }
  }

  return {
    team,
    played: teamMatches.length,
    won, drawn, lost,
    goalsScored: gs,
    goalsConceded: gc,
    goalDifference: gs - gc,
    points: won * 3 + drawn,
    position: 0, // set by getLeagueTable
    form,
    scoringForm,
    overStreak, underStreak,
    ggStreak, ngStreak,
    overRate: teamMatches.length > 0 ? overCount / teamMatches.length : 0,
    ggRate: teamMatches.length > 0 ? ggCount / teamMatches.length : 0,
  };
}

export function getLeagueTable(leagueId: string): TeamStats[] {
  const stats = VFL_TEAMS.map(t => getTeamStats(leagueId, t)).filter((s): s is TeamStats => s !== null && s.played > 0);

  stats.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.goalDifference !== a.goalDifference) return b.goalDifference - a.goalDifference;
    return b.goalsScored - a.goalsScored;
  });

  stats.forEach((s, i) => { s.position = i + 1; });
  return stats;
}

export function classifyTeams(leagueId: string): { predators: VflTeam[]; activators: VflTeam[]; observed: Record<string, { overRate: number; role: string }> } {
  const league = getLeague(leagueId);
  if (!league || league.weeks.length < 3) {
    return {
      predators: [...GENERAL_PREDATORS] as VflTeam[],
      activators: [...GENERAL_ACTIVATORS] as VflTeam[],
      observed: {},
    };
  }

  const all = flattenMatches(league);
  const observed: Record<string, { overRate: number; role: string }> = {};
  const predators: VflTeam[] = [];
  const activators: VflTeam[] = [];

  for (const team of VFL_TEAMS) {
    const matches = getTeamMatches(all, team);
    if (matches.length < 3) continue;

    const overCount = matches.filter(m => m.scored + m.conceded > 2).length;
    const overRate = overCount / matches.length;

    let role = 'neutral';
    if (overRate >= 0.6) {
      role = 'activator';
      activators.push(team);
    } else if (overRate <= 0.4) {
      role = 'predator';
      predators.push(team);
    }
    observed[team] = { overRate, role };
  }

  return { predators, activators, observed };
}

export function detectDisc(leagueId: string): DiscDetection {
  const league = getLeague(leagueId);
  if (!league || league.weeks.length < 5) {
    return { type: 'UNKNOWN', confidence: 0, reasons: ['Need at least 5 weeks of data'] };
  }

  const table = getLeagueTable(leagueId);
  const reasons: string[] = [];
  let cordScore = 0, multiCordScore = 0, bankScore = 0;

  // Check 1: Are major teams in top positions?
  const majorPositions = MAJOR_TEAMS.map(t => table.find(s => s.team === t)?.position ?? 20);
  const avgMajorPos = majorPositions.reduce((a, b) => a + b, 0) / majorPositions.length;

  if (avgMajorPos <= 5) {
    cordScore += 3;
    reasons.push(`Major teams avg position: ${avgMajorPos.toFixed(1)} (top 5 = CORD signal)`);
  } else if (avgMajorPos <= 8) {
    multiCordScore += 2;
    reasons.push(`Major teams avg position: ${avgMajorPos.toFixed(1)} (mid = MULTI-CORD signal)`);
  } else {
    bankScore += 3;
    reasons.push(`Major teams avg position: ${avgMajorPos.toFixed(1)} (low = BANK signal)`);
  }

  // Check 2: MNC position specifically (should be 1st or 2nd in CORD)
  const mncPos = table.find(s => s.team === 'MNC')?.position ?? 20;
  if (mncPos <= 2) {
    cordScore += 2;
    reasons.push(`MNC at position ${mncPos} (CORD: director on top)`);
  } else if (mncPos >= 6) {
    bankScore += 2;
    reasons.push(`MNC at position ${mncPos} (BANK: director out of top 5)`);
  }

  // Check 3: Score pattern analysis
  const all = flattenMatches(league);
  const majorMatches = all.filter(m => (MAJOR_TEAMS as readonly string[]).includes(m.home) || (MAJOR_TEAMS as readonly string[]).includes(m.away));
  const majorOverRate = majorMatches.filter(m => m.homeScore + m.awayScore > 2).length / (majorMatches.length || 1);

  if (majorOverRate >= 0.4 && majorOverRate <= 0.6) {
    cordScore += 1;
    reasons.push(`Major teams OVER rate: ${(majorOverRate * 100).toFixed(0)}% (balanced = CORD)`);
  } else if (majorOverRate > 0.6 || majorOverRate < 0.3) {
    bankScore += 1;
    reasons.push(`Major teams OVER rate: ${(majorOverRate * 100).toFixed(0)}% (extreme = BANK)`);
  }

  // Check 4: Do major teams have consistent form or chaotic?
  const majorForms = MAJOR_TEAMS.map(t => {
    const stats = table.find(s => s.team === t);
    if (!stats || stats.form.length < 3) return 0;
    const wins = stats.form.filter(f => f === 'W').length;
    return wins / stats.form.length;
  });
  const avgWinRate = majorForms.reduce((a, b) => a + b, 0) / majorForms.length;

  if (avgWinRate >= 0.5) {
    cordScore += 1;
    reasons.push(`Major teams win rate: ${(avgWinRate * 100).toFixed(0)}% (strong = CORD/MULTI-CORD)`);
  } else {
    bankScore += 1;
    reasons.push(`Major teams win rate: ${(avgWinRate * 100).toFixed(0)}% (weak = BANK)`);
  }

  // Check 5: Score repetition (MULTI-CORD indicator)
  const majorScorelines = all
    .filter(m => (MAJOR_TEAMS as readonly string[]).includes(m.home) || (MAJOR_TEAMS as readonly string[]).includes(m.away))
    .map(m => `${m.homeScore}-${m.awayScore}`);
  const scoreFreq = new Map<string, number>();
  for (const s of majorScorelines) scoreFreq.set(s, (scoreFreq.get(s) ?? 0) + 1);
  const repeatedScores = [...scoreFreq.values()].filter(v => v >= 3).length;

  if (repeatedScores >= 2) {
    multiCordScore += 2;
    reasons.push(`${repeatedScores} scorelines repeated 3+ times (MULTI-CORD: repeating pattern)`);
  }

  // Determine disc type
  const maxScore = Math.max(cordScore, multiCordScore, bankScore);
  const totalScore = cordScore + multiCordScore + bankScore;
  let type: DiscType;

  if (maxScore === bankScore && bankScore >= 3) type = 'BANK';
  else if (maxScore === multiCordScore) type = 'MULTI_CORD';
  else if (maxScore === cordScore) type = 'CORD';
  else type = 'UNKNOWN';

  return {
    type,
    confidence: totalScore > 0 ? Math.round((maxScore / totalScore) * 100) : 0,
    reasons,
  };
}

export function getAlerts(leagueId: string): Alert[] {
  const league = getLeague(leagueId);
  if (!league || league.weeks.length < 3) return [];

  const alerts: Alert[] = [];
  const all = flattenMatches(league);
  const currentWeek = Math.max(...league.weeks.map(w => w.week));
  const { activators } = classifyTeams(leagueId);

  for (const team of MAJOR_TEAMS) {
    const matches = getTeamMatches(all, team);
    if (matches.length < 4) continue;

    // Check for UNDER exit: 3+ UNDER then first OVER
    const recent = matches.slice(-5);
    const lastMatch = recent.at(-1);
    if (!lastMatch) continue;
    const isLastOver = lastMatch.scored + lastMatch.conceded > 2;

    if (isLastOver) {
      const priorUnder = recent.slice(0, -1).filter(m => m.scored + m.conceded <= 2).length;
      if (priorUnder >= 3) {
        alerts.push({
          team,
          type: 'LONG_UNDER_EXIT',
          message: `${team} just exited ${priorUnder} UNDER streak with ${lastMatch.scored}-${lastMatch.conceded}. Likely to continue OVER.`,
          week: currentWeek,
        });
      }
    }

    // Check scoring form vs activator in next fixture
    const scoringCount = recent.filter(m => m.scored > 0).length;
    if (scoringCount >= 3) {
      // Find next week's fixture for this team
      const nextWeek = league.weeks.find(w => w.week === currentWeek + 1);
      if (nextWeek) {
        const nextMatch = nextWeek.matches.find(m => m.home === team || m.away === team);
        if (nextMatch) {
          const opponent = nextMatch.home === team ? nextMatch.away : nextMatch.home;
          if ((activators as string[]).includes(opponent)) {
            alerts.push({
              team,
              type: 'SCORING_FORM_VS_ACTIVATOR',
              message: `${team} in scoring form (${scoringCount}/5) meets activator ${opponent}. High OVER potential.`,
              week: currentWeek + 1,
            });
          }
        }
      }
    }
  }

  return alerts;
}

export function getTeamPredatorActivatorContext(leagueId: string, team: VflTeam): {
  predators: string[];
  activators: string[];
  observedPredators: string[];
  observedActivators: string[];
} {
  const defaultPreds = TEAM_PREDATORS[team] ?? GENERAL_PREDATORS;
  const defaultActs = TEAM_ACTIVATORS[team] ?? GENERAL_ACTIVATORS;

  const league = getLeague(leagueId);
  if (!league || league.weeks.length < 5) {
    return {
      predators: [...defaultPreds],
      activators: [...defaultActs],
      observedPredators: [],
      observedActivators: [],
    };
  }

  const all = flattenMatches(league);
  const teamMatches = getTeamMatches(all, team);
  const opponentStats = new Map<string, { over: number; total: number }>();

  for (const m of teamMatches) {
    const opp = m.home === team ? m.away : m.home;
    const stat = opponentStats.get(opp) ?? { over: 0, total: 0 };
    stat.total++;
    if (m.scored + m.conceded > 2) stat.over++;
    opponentStats.set(opp, stat);
  }

  const observedPredators: string[] = [];
  const observedActivators: string[] = [];

  for (const [opp, stat] of opponentStats) {
    if (stat.total < 2) continue;
    const overRate = stat.over / stat.total;
    if (overRate <= 0.35) observedPredators.push(opp);
    else if (overRate >= 0.65) observedActivators.push(opp);
  }

  return {
    predators: [...defaultPreds],
    activators: [...defaultActs],
    observedPredators,
    observedActivators,
  };
}

export function getGoalConcedingAnalysis(leagueId: string): {
  topScorers: Array<{ team: VflTeam; goals: number; conceded: number }>;
  topConceders: Array<{ team: VflTeam; goals: number; conceded: number }>;
} {
  const table = getLeagueTable(leagueId);

  const sorted = [...table].sort((a, b) => b.goalsScored - a.goalsScored);
  const topScorers = sorted.slice(0, 5).map(s => ({ team: s.team, goals: s.goalsScored, conceded: s.goalsConceded }));

  const concedeSorted = [...table].sort((a, b) => b.goalsConceded - a.goalsConceded);
  const topConceders = concedeSorted.slice(0, 5).map(s => ({ team: s.team, goals: s.goalsScored, conceded: s.goalsConceded }));

  return { topScorers, topConceders };
}

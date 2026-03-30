import { getLeague } from './store.js';
import { getTeamStats, getLeagueTable, classifyTeams, detectDisc, getGoalConcedingAnalysis } from './analyzer.js';
import { MAJOR_TEAMS, TEAM_PREDATORS, TEAM_ACTIVATORS } from './constants.js';
import type { VflTeam, Pick } from './types.js';

interface UpcomingMatch {
  home: VflTeam;
  away: VflTeam;
  week: number;
}

function getUpcomingMatches(leagueId: string, week: number): UpcomingMatch[] {
  // If the week already has results, return those fixtures
  const league = getLeague(leagueId);
  if (!league) return [];

  const weekData = league.weeks.find(w => w.week === week);
  if (weekData) {
    return weekData.matches.map(m => ({ home: m.home, away: m.away, week }));
  }
  return [];
}

function checkCriteria(leagueId: string, team: VflTeam, opponent: VflTeam, isHome: boolean, table: ReturnType<typeof getLeagueTable>): {
  criteriaPass: number;
  reasons: string[];
  suggestion: Pick['suggestion'];
  confidence: Pick['confidence'];
} {
  const stats = table.find(s => s.team === team) ?? getTeamStats(leagueId, team);
  const oppStats = table.find(s => s.team === opponent) ?? getTeamStats(leagueId, opponent);
  const disc = detectDisc(leagueId);
  const { predators, activators } = classifyTeams(leagueId);

  const reasons: string[] = [];
  let pass = 0;

  if (!stats || stats.played < 3) {
    return { criteriaPass: 0, reasons: ['Not enough data'], suggestion: 'SKIP', confidence: 'LOW' };
  }

  // Criterion 1: In winning form (2+ wins in last 5)
  const recentWins = stats.form.filter(f => f === 'W').length;
  if (recentWins >= 2) {
    pass++;
    reasons.push(`Winning form: ${recentWins}/5 wins`);
  }

  // Criterion 2: In scoring form (scored in 3+ of last 5)
  const scoringMatches = stats.scoringForm.filter(s => s.scored > 0).length;
  if (scoringMatches >= 3) {
    pass++;
    reasons.push(`Scoring form: scored in ${scoringMatches}/5 matches`);
  }

  // Criterion 3: Not meeting a predator (or meeting an activator)
  const teamPreds = TEAM_PREDATORS[team] ?? [];
  const teamActs = TEAM_ACTIVATORS[team] ?? [];
  const isPredator = (teamPreds as readonly string[]).includes(opponent) || (predators as string[]).includes(opponent);
  const isActivator = (teamActs as readonly string[]).includes(opponent) || (activators as string[]).includes(opponent);

  if (isActivator) {
    pass++;
    reasons.push(`Opponent ${opponent} is an ACTIVATOR (OVER likely)`);
  } else if (!isPredator) {
    pass++;
    reasons.push(`Opponent ${opponent} is neutral (not a predator)`);
  } else {
    reasons.push(`WARNING: Opponent ${opponent} is a PREDATOR (UNDER risk)`);
  }

  // Criterion 4: Fighting for league table position (top 4)
  if (stats.position <= 4) {
    pass++;
    reasons.push(`Position ${stats.position} (fighting for top spot)`);
  }

  // Criterion 5: Favorable goal context
  const justExitedUnder = stats.underStreak === 0 && stats.scoringForm.length > 0 &&
    stats.scoringForm[stats.scoringForm.length - 1]?.isOver;
  const longUnder = stats.underStreak >= 3;

  if (justExitedUnder || longUnder) {
    pass++;
    if (longUnder) reasons.push(`${stats.underStreak} UNDER streak - due for OVER`);
    else reasons.push('Just entered scoring form after UNDER period');
  } else if (stats.overStreak >= 1 && stats.overStreak <= 3) {
    pass++;
    reasons.push(`OVER streak: ${stats.overStreak} (within 2-4 balance range)`);
  }

  // Disc check
  if (disc.type === 'BANK') {
    return {
      criteriaPass: 0,
      reasons: ['RNG BANK disc detected - SKIP ALL'],
      suggestion: 'SKIP',
      confidence: 'LOW',
    };
  }

  // Extra signals
  if (oppStats && oppStats.goalsConceded > oppStats.goalsScored * 1.5) {
    reasons.push(`Opponent ${opponent} concedes heavily (${oppStats.goalsConceded} GA in ${oppStats.played} games)`);
  }

  // Determine suggestion
  let suggestion: Pick['suggestion'];
  let confidence: Pick['confidence'];

  if (pass >= 4) {
    suggestion = isActivator ? 'TRIO' : 'OVER_2.5';
    confidence = pass >= 5 ? 'HIGH' : 'MEDIUM';
  } else if (pass >= 3) {
    suggestion = isPredator ? 'STRAIGHT_WIN' : 'OVER_2.5';
    confidence = 'MEDIUM';
  } else if (pass >= 2 && !isPredator) {
    suggestion = 'STRAIGHT_WIN';
    confidence = 'LOW';
  } else {
    suggestion = 'SKIP';
    confidence = 'LOW';
    reasons.push('Not enough criteria met');
  }

  return { criteriaPass: pass, reasons, suggestion, confidence };
}

export function generatePicks(leagueId: string, week: number): { picks: Pick[]; disc: ReturnType<typeof detectDisc>; skipWeek: boolean } {
  const disc = detectDisc(leagueId);

  if (disc.type === 'BANK') {
    return {
      picks: [],
      disc,
      skipWeek: true,
    };
  }

  const upcoming = getUpcomingMatches(leagueId, week);
  const table = getLeagueTable(leagueId);
  const picks: Pick[] = [];

  // Analyze all major teams
  for (const team of MAJOR_TEAMS) {
    const match = upcoming.find(m => m.home === team || m.away === team);
    if (!match) {
      // No fixture found - try to generate pick based on form alone
      const stats = getTeamStats(leagueId, team);
      if (!stats || stats.played < 3) continue;

      picks.push({
        team,
        opponent: 'TBD' as VflTeam,
        isHome: true,
        suggestion: 'SKIP',
        confidence: 'LOW',
        criteriaPass: 0,
        reasons: [`No fixture data for week ${week}. Enter results or check fixtures.`],
      });
      continue;
    }

    const isHome = match.home === team;
    const opponent = isHome ? match.away : match.home;
    const { criteriaPass, reasons, suggestion, confidence } = checkCriteria(leagueId, team, opponent, isHome, table);

    picks.push({
      team,
      opponent,
      isHome,
      suggestion,
      confidence,
      criteriaPass,
      reasons,
    });
  }

  // Sort: highest criteria pass first
  picks.sort((a, b) => b.criteriaPass - a.criteriaPass);

  return { picks, disc, skipWeek: false };
}

export function generateProAnalysis(leagueId: string): {
  jargua: Array<{ team: VflTeam; goals: number }>;
  prey: Array<{ team: VflTeam; conceded: number }>;
} {
  const { topScorers, topConceders } = getGoalConcedingAnalysis(leagueId);
  return {
    jargua: topScorers.slice(0, 2).map(s => ({ team: s.team, goals: s.goals })),
    prey: topConceders.slice(0, 2).map(s => ({ team: s.team, conceded: s.conceded })),
  };
}

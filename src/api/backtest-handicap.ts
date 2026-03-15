/**
 * Backtest: 1st Half Handicap Model
 *
 * For each match in the 2025-26 season:
 * 1. Build team stats using ONLY matches played BEFORE this match
 * 2. Predict FH score using Poisson model
 * 3. Check if the handicap bet would have won
 * 4. Report accuracy by handicap value and confidence tier
 *
 * This gives us real, honest accuracy numbers.
 */

// ===== POISSON =====

function factorial(n: number): number {
  if (n <= 1) return 1;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

function scoreMatrix(lH: number, lA: number, max = 6): number[][] {
  const m: number[][] = [];
  for (let h = 0; h <= max; h++) {
    m[h] = [];
    for (let a = 0; a <= max; a++) {
      m[h]![a] = poissonPmf(h, lH) * poissonPmf(a, lA);
    }
  }
  // Dixon-Coles correction: boost P(0-0) and P(1-1), reduce P(1-0) and P(0-1)
  const rho = -0.13; // typical DC rho for low-scoring matches
  if (lH > 0 && lA > 0) {
    m[0]![0]! *= (1 + rho / (lH * lA) * m[0]![0]!);
    m[1]![0]! *= (1 - rho / lA * m[1]![0]!);
    m[0]![1]! *= (1 - rho / lH * m[0]![1]!);
    m[1]![1]! *= (1 + rho * m[1]![1]!);
  }
  return m;
}

function handicapResult(matrix: number[][], handicap: number, side: 'home' | 'away') {
  let win = 0, push = 0, loss = 0;
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h]!.length; a++) {
      const p = matrix[h]![a]!;
      const diff = side === 'away' ? (a + handicap) - h : (h + handicap) - a;
      if (diff > 0) win += p;
      else if (diff === 0) push += p;
      else loss += p;
    }
  }
  return { win, push, loss };
}

// ===== CSV PARSING =====

interface MatchRow {
  date: string;
  homeTeam: string;
  awayTeam: string;
  ftHome: number;
  ftAway: number;
  htHome: number;
  htAway: number;
  ahLine: number | null;
  ahOddsHome: number | null;
  ahOddsAway: number | null;
}

function parseCsv(text: string): MatchRow[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  let header = lines[0]!;
  if (header.charCodeAt(0) === 0xFEFF) header = header.slice(1);
  const cols = header.split(',');
  const idx = (name: string) => cols.indexOf(name);

  const rows: MatchRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const v = lines[i]!.split(',');
    const htH = parseInt(v[idx('HTHG')] || '');
    const htA = parseInt(v[idx('HTAG')] || '');
    if (isNaN(htH) || isNaN(htA)) continue;

    rows.push({
      date: v[idx('Date')] || '',
      homeTeam: v[idx('HomeTeam')] || '',
      awayTeam: v[idx('AwayTeam')] || '',
      ftHome: parseInt(v[idx('FTHG')] || '0'),
      ftAway: parseInt(v[idx('FTAG')] || '0'),
      htHome: htH,
      htAway: htA,
      ahLine: parseFloat(v[idx('AHh')] || '') || null,
      ahOddsHome: parseFloat(v[idx('B365AHH')] || '') || null,
      ahOddsAway: parseFloat(v[idx('B365AHA')] || '') || null,
    });
  }
  return rows;
}

// ===== TEAM STATS WITH RECENCY WEIGHTING =====

interface TeamAcc {
  fhScoredHome: { val: number; weight: number }[];
  fhScoredAway: { val: number; weight: number }[];
  fhConcededHome: { val: number; weight: number }[];
  fhConcededAway: { val: number; weight: number }[];
}

function weightedAvg(arr: { val: number; weight: number }[]): number {
  if (arr.length === 0) return 0;
  const totalW = arr.reduce((s, x) => s + x.weight, 0);
  return arr.reduce((s, x) => s + x.val * x.weight, 0) / totalW;
}

/**
 * Build team FH stats using only matches BEFORE a given index.
 * Uses exponential decay: recent games weighted more heavily.
 * decay = 0.95 means each older game is worth 95% of the next newer game.
 */
function buildTeamStats(
  matches: MatchRow[],
  beforeIdx: number,
  teamName: string,
  decay = 0.95,
): TeamAcc | null {
  const acc: TeamAcc = {
    fhScoredHome: [], fhScoredAway: [],
    fhConcededHome: [], fhConcededAway: [],
  };

  // Walk backwards from beforeIdx to weight recent games higher
  let weight = 1.0;
  for (let i = beforeIdx - 1; i >= 0; i--) {
    const m = matches[i]!;
    if (m.homeTeam === teamName) {
      acc.fhScoredHome.push({ val: m.htHome, weight });
      acc.fhConcededHome.push({ val: m.htAway, weight });
    } else if (m.awayTeam === teamName) {
      acc.fhScoredAway.push({ val: m.htAway, weight });
      acc.fhConcededAway.push({ val: m.htHome, weight });
    }
    weight *= decay;
  }

  const total = acc.fhScoredHome.length + acc.fhScoredAway.length;
  if (total < 5) return null; // need at least 5 prior games
  return acc;
}

// ===== BACKTEST =====

interface BetResult {
  matchIdx: number;
  homeTeam: string;
  awayTeam: string;
  actualHTHome: number;
  actualHTAway: number;
  handicap: number;
  pickSide: 'home' | 'away';
  predictedWinProb: number;
  outcome: 'win' | 'push' | 'loss';
  hasRealData: boolean; // whether both teams had stats
}

export async function runBacktest(leagueUrl: string, leagueName: string): Promise<{
  league: string;
  totalMatches: number;
  testedMatches: number;
  results: Record<string, { wins: number; pushes: number; losses: number; total: number; winRate: number; roi: number }>;
  byConfidence: Record<string, Record<string, { wins: number; total: number; winRate: number }>>;
}> {
  const res = await fetch(leagueUrl, { signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  const matches = parseCsv(text);

  const leagueAvgFHHome = 0.62;
  const leagueAvgFHAway = 0.47;
  const leagueAvgConceded = (leagueAvgFHHome + leagueAvgFHAway) / 2;

  const bets: BetResult[] = [];

  // For each match (starting from match 60+ so teams have enough history)
  for (let i = 60; i < matches.length; i++) {
    const m = matches[i]!;

    // Build stats for both teams using ONLY prior matches
    const homeStats = buildTeamStats(matches, i, m.homeTeam);
    const awayStats = buildTeamStats(matches, i, m.awayTeam);

    if (!homeStats || !awayStats) continue;

    // Estimate FH lambdas
    const homeAttackHome = weightedAvg(homeStats.fhScoredHome);
    const homeConcededHome = weightedAvg(homeStats.fhConcededHome);
    const awayAttackAway = weightedAvg(awayStats.fhScoredAway);
    const awayConcededAway = weightedAvg(awayStats.fhConcededAway);

    let lambdaHome = homeAttackHome * (awayConcededAway / leagueAvgConceded);
    let lambdaAway = awayAttackAway * (homeConcededHome / leagueAvgConceded);

    // Clamp
    lambdaHome = Math.max(0.05, Math.min(2.5, lambdaHome));
    lambdaAway = Math.max(0.05, Math.min(2.5, lambdaAway));

    const matrix = scoreMatrix(lambdaHome, lambdaAway);

    // Test each handicap value
    for (const hcVal of [1, 1.5, 2]) {
      const awayProb = handicapResult(matrix, hcVal, 'away');
      const homeProb = handicapResult(matrix, hcVal, 'home');

      // Pick better side
      const pickAway = awayProb.win >= homeProb.win;
      const chosen = pickAway ? awayProb : homeProb;
      const pickSide = pickAway ? 'away' as const : 'home' as const;

      const winProb = chosen.win * 100;
      if (winProb < 55) continue; // skip low confidence

      // Check actual result
      const diff = pickSide === 'away'
        ? (m.htAway + hcVal) - m.htHome
        : (m.htHome + hcVal) - m.htAway;

      const outcome = diff > 0 ? 'win' : diff === 0 ? 'push' : 'loss';

      bets.push({
        matchIdx: i,
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
        actualHTHome: m.htHome,
        actualHTAway: m.htAway,
        handicap: hcVal,
        pickSide,
        predictedWinProb: Math.round(winProb * 10) / 10,
        outcome,
        hasRealData: true,
      });
    }
  }

  // Aggregate results
  const results: Record<string, { wins: number; pushes: number; losses: number; total: number; winRate: number; roi: number }> = {};
  const byConfidence: Record<string, Record<string, { wins: number; total: number; winRate: number }>> = {};

  for (const hcKey of ['H1', 'H1.5', 'H2']) {
    const hcVal = parseFloat(hcKey.replace('H', ''));
    const hcBets = bets.filter(b => b.handicap === hcVal);
    const wins = hcBets.filter(b => b.outcome === 'win').length;
    const pushes = hcBets.filter(b => b.outcome === 'push').length;
    const losses = hcBets.filter(b => b.outcome === 'loss').length;
    const total = hcBets.length;
    const decided = wins + losses;

    results[hcKey] = {
      wins, pushes, losses, total,
      winRate: decided > 0 ? Math.round((wins / decided) * 1000) / 10 : 0,
      // ROI assuming average odds: H1≈1.25, H1.5≈1.08, H2≈1.04
      roi: 0, // calculated below
    };

    // By confidence bands
    byConfidence[hcKey] = {};
    for (const [label, minProb, maxProb] of [
      ['55-65%', 55, 65], ['65-75%', 65, 75], ['75-85%', 75, 85], ['85-95%', 85, 95], ['95%+', 95, 100],
    ] as const) {
      const band = hcBets.filter(b => b.predictedWinProb >= minProb && b.predictedWinProb < maxProb);
      const bWins = band.filter(b => b.outcome === 'win').length;
      const bTotal = band.length;
      byConfidence[hcKey]![label] = {
        wins: bWins,
        total: bTotal,
        winRate: bTotal > 0 ? Math.round((bWins / bTotal) * 1000) / 10 : 0,
      };
    }
  }

  return {
    league: leagueName,
    totalMatches: matches.length,
    testedMatches: bets.length / 3, // each match has 3 handicap bets
    results,
    byConfidence,
  };
}

// Run backtest across multiple leagues
export async function runFullBacktest(): Promise<string> {
  const leagues = [
    { url: 'https://www.football-data.co.uk/mmz4281/2526/E0.csv', name: 'Premier League' },
    { url: 'https://www.football-data.co.uk/mmz4281/2526/SP1.csv', name: 'La Liga' },
    { url: 'https://www.football-data.co.uk/mmz4281/2526/D1.csv', name: 'Bundesliga' },
    { url: 'https://www.football-data.co.uk/mmz4281/2526/I1.csv', name: 'Serie A' },
    { url: 'https://www.football-data.co.uk/mmz4281/2526/F1.csv', name: 'Ligue 1' },
    { url: 'https://www.football-data.co.uk/mmz4281/2526/N1.csv', name: 'Eredivisie' },
  ];

  const results = await Promise.all(
    leagues.map(l => runBacktest(l.url, l.name).catch(() => null)),
  );

  // Aggregate across all leagues
  const totals: Record<string, { wins: number; pushes: number; losses: number; total: number }> = {
    H1: { wins: 0, pushes: 0, losses: 0, total: 0 },
    'H1.5': { wins: 0, pushes: 0, losses: 0, total: 0 },
    H2: { wins: 0, pushes: 0, losses: 0, total: 0 },
  };

  const confTotals: Record<string, Record<string, { wins: number; total: number }>> = {};

  let report = '=== 1ST HALF HANDICAP BACKTEST (2025-26 SEASON) ===\n\n';

  for (const r of results) {
    if (!r) continue;
    report += `--- ${r.league} (${r.totalMatches} matches, ${Math.round(r.testedMatches)} tested) ---\n`;
    for (const [hk, data] of Object.entries(r.results)) {
      const decided = data.wins + data.losses;
      report += `  ${hk}: ${data.wins}W / ${data.pushes}P / ${data.losses}L = ${data.winRate}% win rate (${data.total} bets, ${decided} decided)\n`;
      totals[hk]!.wins += data.wins;
      totals[hk]!.pushes += data.pushes;
      totals[hk]!.losses += data.losses;
      totals[hk]!.total += data.total;
    }
    report += '\n';

    // Aggregate confidence bands
    for (const [hk, bands] of Object.entries(r.byConfidence)) {
      if (!confTotals[hk]) confTotals[hk] = {};
      for (const [band, data] of Object.entries(bands)) {
        if (!confTotals[hk]![band]) confTotals[hk]![band] = { wins: 0, total: 0 };
        confTotals[hk]![band]!.wins += data.wins;
        confTotals[hk]![band]!.total += data.total;
      }
    }
  }

  report += '=== TOTALS ACROSS ALL LEAGUES ===\n';
  for (const [hk, data] of Object.entries(totals)) {
    const decided = data.wins + data.losses;
    const winRate = decided > 0 ? Math.round((data.wins / decided) * 1000) / 10 : 0;
    report += `  ${hk}: ${data.wins}W / ${data.pushes}P / ${data.losses}L = ${winRate}% win rate (${data.total} bets)\n`;
  }

  report += '\n=== WIN RATE BY CONFIDENCE BAND ===\n';
  for (const [hk, bands] of Object.entries(confTotals)) {
    report += `\n  ${hk}:\n`;
    for (const [band, data] of Object.entries(bands)) {
      const wr = data.total > 0 ? Math.round((data.wins / data.total) * 1000) / 10 : 0;
      report += `    ${band}: ${data.wins}/${data.total} = ${wr}% actual win rate\n`;
    }
  }

  return report;
}

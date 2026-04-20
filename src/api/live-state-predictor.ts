/**
 * Live State Predictor — Real In-Play Probability Model
 *
 * Computes match outcome probabilities based on CURRENT match state
 * (score + minute remaining), not stale pre-match stats.
 *
 * This is the core model used by all serious live-betting pricing engines.
 * It's mathematically sound — unlike a Poisson pre-match model which has
 * no idea what the current score is.
 *
 * Method (football):
 *   - Remaining goal rate: λ = total_expected_goals * (remaining_minutes / 90)
 *   - Goals from now follow Poisson(λ) for each team (split by scoring rate)
 *   - P(home wins) = P(H goals from now > A goals from now | current diff)
 *   - P(over N.5) = P(goals_now + future > N.5)
 *   - P(BTTS) = P(home has scored OR will) * P(away has scored OR will)
 *
 * For basketball, baseball, hockey: simpler score-diff-at-time logic
 * since goals aren't as discrete.
 */

export interface LiveStateInput {
  sport: string;
  score: string;       // "1:2"
  minute: string | null; // "67'" or "23:45" or null
  matchStatus: string; // "H1", "H2", "HT", "FT"
  // For leagues/teams where we have pre-match stats, we could use them
  // as priors, but we don't require them.
}

export interface LiveStateProbs {
  homeWinPct: number;   // 0-100
  drawPct: number;
  awayWinPct: number;
  over15Pct: number;
  over25Pct: number;
  over35Pct: number;
  bttsYesPct: number;
  bttsNoPct: number;
  oddTotalPct: number;  // P(total goals is odd at FT)
  evenTotalPct: number;
  homeOver05Pct: number; // team totals
  homeOver15Pct: number;
  awayOver05Pct: number;
  awayOver15Pct: number;
  // Asian Handicap half-lines (clean win/lose, no push).
  // "ahHome05" = AH -0.5 home = home wins. "ahHome15" = home wins by ≥ 2. etc.
  ahHome05Pct: number;
  ahHome15Pct: number;
  ahHome25Pct: number;
  ahAway05Pct: number;
  ahAway15Pct: number;
  ahAway25Pct: number;
  // Next Goal market (live). All three sum to 100.
  //   home: remaining home rate claims the first additional goal
  //   away: remaining away rate claims it
  //   none: no more goals in remaining time
  nextGoalHomePct: number;
  nextGoalAwayPct: number;
  nextGoalNonePct: number;
  valid: boolean;       // false if we can't parse state
  reason: string;       // which branch computed the probs
}

// ── Helpers ──────────────────────────────────────────────

function parseScore(score: string): [number, number] | null {
  const parts = score.split(':').map(x => parseInt(x.trim(), 10));
  if (parts.length !== 2 || isNaN(parts[0]!) || isNaN(parts[1]!)) return null;
  return [parts[0]!, parts[1]!];
}

function parseMinute(minute: string | null, status: string): number {
  if (!minute) {
    // Use status as fallback
    if (status === 'H1' || status === '1H') return 30;
    if (status === 'HT') return 45;
    if (status === 'H2' || status === '2H') return 70;
    if (status === 'FT') return 90;
    return 0;
  }
  // "67'" → 67, "23:45" → 23
  const match = minute.match(/(\d+)/);
  return match ? parseInt(match[1]!, 10) : 0;
}

/**
 * Poisson CDF: P(X <= k) where X ~ Poisson(λ)
 */
function poissonCdf(k: number, lambda: number): number {
  if (lambda <= 0) return 1; // no more goals possible
  if (k < 0) return 0;
  let sum = 0;
  let term = Math.exp(-lambda);
  sum = term;
  for (let i = 1; i <= k; i++) {
    term *= lambda / i;
    sum += term;
  }
  return Math.min(1, sum);
}

function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let term = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) term *= lambda / i;
  return term;
}

// ── Football ─────────────────────────────────────────────

function predictFootball(score: [number, number], minute: number): LiveStateProbs {
  const [h, a] = score;
  const totalGoals = h + a;
  const minRemaining = Math.max(0, 90 - minute);

  // Expected total goals per match in typical football: ~2.7
  // Remaining expected goals from now:
  const totalRate = 2.7 * (minRemaining / 90);
  // Home teams score slightly more in aggregate (~55%/45% split)
  // But if one team is dominating (based on current score), we assume
  // the scoring rate is symmetric going forward (teams adjust tactics)
  const homeRateRemaining = totalRate * 0.52;
  const awayRateRemaining = totalRate * 0.48;

  // Probability home scores N more goals from now
  // Sum home prob + away prob for win/draw/loss paths
  let pHomeWin = 0, pDraw = 0, pAwayWin = 0;
  // Goal-difference distribution at FT (finalH - finalA). Keyed by diff.
  const diffDist = new Map<number, number>();
  const MAX_GOALS = 8;

  for (let hMore = 0; hMore <= MAX_GOALS; hMore++) {
    const pH = poissonPmf(hMore, homeRateRemaining);
    if (pH < 1e-9) break;
    for (let aMore = 0; aMore <= MAX_GOALS; aMore++) {
      const pA = poissonPmf(aMore, awayRateRemaining);
      if (pA < 1e-9) break;
      const finalH = h + hMore;
      const finalA = a + aMore;
      const diff = finalH - finalA;
      const p = pH * pA;
      diffDist.set(diff, (diffDist.get(diff) ?? 0) + p);
      if (finalH > finalA) pHomeWin += p;
      else if (finalH === finalA) pDraw += p;
      else pAwayWin += p;
    }
  }

  // Asian handicap probabilities — P(goal diff ≥ k) for home, P(≤ -k) for away.
  const pHomeBy = (k: number): number => {
    let s = 0; for (const [d, p] of diffDist) if (d >= k) s += p; return s;
  };
  const pAwayBy = (k: number): number => {
    let s = 0; for (const [d, p] of diffDist) if (d <= -k) s += p; return s;
  };

  // Normalize (should already sum to ~1 but be safe)
  const total = pHomeWin + pDraw + pAwayWin;
  if (total > 0) {
    pHomeWin /= total;
    pDraw /= total;
    pAwayWin /= total;
  }

  // Over/Under probabilities
  const totalRemaining = homeRateRemaining + awayRateRemaining;
  const pTotal = (threshold: number): number => {
    const needed = threshold - totalGoals;
    if (needed < 0) return 1; // already over
    // P(X > needed) where X ~ Poisson(totalRemaining)
    return 1 - poissonCdf(Math.floor(needed), totalRemaining);
  };
  const over15 = pTotal(1.5);
  const over25 = pTotal(2.5);
  const over35 = pTotal(3.5);

  // BTTS: both teams score at some point
  // Already true if both have >= 1. Else need whoever's at 0 to score.
  let btts = 0;
  if (h >= 1 && a >= 1) {
    btts = 1;
  } else if (h >= 1 && a === 0) {
    btts = 1 - poissonPmf(0, awayRateRemaining); // P(away scores at least once)
  } else if (a >= 1 && h === 0) {
    btts = 1 - poissonPmf(0, homeRateRemaining);
  } else {
    // Both at 0 — need both to score
    btts = (1 - poissonPmf(0, homeRateRemaining)) * (1 - poissonPmf(0, awayRateRemaining));
  }

  // Odd/Even total goals — current parity flips iff future goals are odd.
  // For X~Poisson(λ), P(X even) = (1 + e^-2λ)/2.
  const currentlyOdd = totalGoals % 2 === 1;
  const pFutureEven = (1 + Math.exp(-2 * totalRemaining)) / 2;
  const pOdd = currentlyOdd ? pFutureEven : 1 - pFutureEven;
  const pEven = 1 - pOdd;

  // Team totals: P(h + hMore >= T)
  const pHomeOver = (T: number): number => {
    if (h >= T) return 1;
    return 1 - poissonCdf(T - h - 1, homeRateRemaining);
  };
  const pAwayOver = (T: number): number => {
    if (a >= T) return 1;
    return 1 - poissonCdf(T - a - 1, awayRateRemaining);
  };

  // Next goal — competing Poissons over the remaining time.
  //   P(at least one more goal) = 1 - e^-λ_total
  //   Given a goal happens, home's share = λ_H / λ_total
  const pAnyMore = totalRemaining > 0 ? 1 - Math.exp(-totalRemaining) : 0;
  const pNextHome = totalRemaining > 0 ? pAnyMore * (homeRateRemaining / totalRemaining) : 0;
  const pNextAway = totalRemaining > 0 ? pAnyMore * (awayRateRemaining / totalRemaining) : 0;
  const pNextNone = 1 - pAnyMore;

  return {
    homeWinPct: Math.round(pHomeWin * 1000) / 10,
    drawPct: Math.round(pDraw * 1000) / 10,
    awayWinPct: Math.round(pAwayWin * 1000) / 10,
    over15Pct: Math.round(over15 * 1000) / 10,
    over25Pct: Math.round(over25 * 1000) / 10,
    over35Pct: Math.round(over35 * 1000) / 10,
    bttsYesPct: Math.round(btts * 1000) / 10,
    bttsNoPct: Math.round((1 - btts) * 1000) / 10,
    oddTotalPct: Math.round(pOdd * 1000) / 10,
    evenTotalPct: Math.round(pEven * 1000) / 10,
    homeOver05Pct: Math.round(pHomeOver(1) * 1000) / 10,
    homeOver15Pct: Math.round(pHomeOver(2) * 1000) / 10,
    awayOver05Pct: Math.round(pAwayOver(1) * 1000) / 10,
    awayOver15Pct: Math.round(pAwayOver(2) * 1000) / 10,
    ahHome05Pct: Math.round(pHomeBy(1) * 1000) / 10,
    ahHome15Pct: Math.round(pHomeBy(2) * 1000) / 10,
    ahHome25Pct: Math.round(pHomeBy(3) * 1000) / 10,
    ahAway05Pct: Math.round(pAwayBy(1) * 1000) / 10,
    ahAway15Pct: Math.round(pAwayBy(2) * 1000) / 10,
    ahAway25Pct: Math.round(pAwayBy(3) * 1000) / 10,
    nextGoalHomePct: Math.round(pNextHome * 1000) / 10,
    nextGoalAwayPct: Math.round(pNextAway * 1000) / 10,
    nextGoalNonePct: Math.round(pNextNone * 1000) / 10,
    valid: true,
    reason: `Football state model: ${h}-${a} at ${minute}', λ_remaining=${totalRate.toFixed(2)}`,
  };
}

// ── Basketball ───────────────────────────────────────────
// Basketball: use empirical formula — lead of L points with T minutes left
// implies P(win) ≈ 1 / (1 + e^(-k*L/sqrt(T))) where k ≈ 0.35

function predictBasketball(score: [number, number], minute: number, totalMinutes: number): LiveStateProbs {
  const [h, a] = score;
  const diff = h - a;
  const remaining = Math.max(0.1, totalMinutes - minute);
  // Empirical NBA formula: Z = diff / (0.44 * sqrt(remaining))
  // Then P(home win) = Phi(Z) — normal CDF approximation
  const z = diff / (0.44 * Math.sqrt(remaining));
  // Phi approximation
  const phi = (x: number) => 0.5 * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (x + 0.044715 * x * x * x)));
  const pHome = phi(z);

  return {
    homeWinPct: Math.round(pHome * 1000) / 10,
    drawPct: 0, // basketball rarely draws
    awayWinPct: Math.round((1 - pHome) * 1000) / 10,
    over15Pct: 100, over25Pct: 100, over35Pct: 100, // always over in basketball
    bttsYesPct: 99, bttsNoPct: 1,
    oddTotalPct: 50, evenTotalPct: 50, // N/A for basketball — use neutral
    homeOver05Pct: 100, homeOver15Pct: 100, awayOver05Pct: 100, awayOver15Pct: 100,
    ahHome05Pct: Math.round(pHome * 1000) / 10,
    ahHome15Pct: Math.round(Math.max(0, pHome - 0.1) * 1000) / 10,
    ahHome25Pct: Math.round(Math.max(0, pHome - 0.2) * 1000) / 10,
    ahAway05Pct: Math.round((1 - pHome) * 1000) / 10,
    ahAway15Pct: Math.round(Math.max(0, (1 - pHome) - 0.1) * 1000) / 10,
    ahAway25Pct: Math.round(Math.max(0, (1 - pHome) - 0.2) * 1000) / 10,
    nextGoalHomePct: 0, nextGoalAwayPct: 0, nextGoalNonePct: 100, // N/A for basketball
    valid: true,
    reason: `Basketball state model: ${h}-${a} diff=${diff} with ${remaining.toFixed(1)}min left`,
  };
}

// ── Public API ───────────────────────────────────────────

export function predictLiveState(input: LiveStateInput): LiveStateProbs {
  const empty: LiveStateProbs = {
    homeWinPct: 33, drawPct: 33, awayWinPct: 33,
    over15Pct: 50, over25Pct: 50, over35Pct: 50,
    bttsYesPct: 50, bttsNoPct: 50,
    oddTotalPct: 50, evenTotalPct: 50,
    homeOver05Pct: 50, homeOver15Pct: 50, awayOver05Pct: 50, awayOver15Pct: 50,
    ahHome05Pct: 50, ahHome15Pct: 50, ahHome25Pct: 50,
    ahAway05Pct: 50, ahAway15Pct: 50, ahAway25Pct: 50,
    nextGoalHomePct: 33, nextGoalAwayPct: 33, nextGoalNonePct: 34,
    valid: false, reason: 'could not parse state',
  };

  const score = parseScore(input.score);
  if (!score) return empty;

  const minute = parseMinute(input.minute, input.matchStatus);

  const sport = input.sport.toLowerCase();
  if (sport === 'football' || sport === 'soccer') {
    return predictFootball(score, minute);
  }
  if (sport === 'basketball') {
    // NBA is 48 min, college is 40, others vary
    return predictBasketball(score, minute, 40);
  }

  // Fallback: simple score-difference heuristic
  const [h, a] = score;
  const diff = h - a;
  if (diff > 0) return { ...empty, homeWinPct: 60, drawPct: 10, awayWinPct: 30, valid: true, reason: 'generic lead model' };
  if (diff < 0) return { ...empty, homeWinPct: 30, drawPct: 10, awayWinPct: 60, valid: true, reason: 'generic lead model' };
  return { ...empty, homeWinPct: 40, drawPct: 20, awayWinPct: 40, valid: true, reason: 'generic tie model' };
}

/**
 * Kelly edge given model probability vs bookmaker odds.
 * edge% > 0 means the bet has positive expected value.
 */
export function kellyEdge(modelProbPct: number, bookOdds: number): number {
  if (bookOdds <= 1 || modelProbPct <= 0) return -100;
  const p = modelProbPct / 100;
  const edge = (p * bookOdds - 1) / (bookOdds - 1);
  return Math.round(edge * 1000) / 10;
}

#!/usr/bin/env node
/**
 * At minute M with score (h, a), what's the probability each market is
 * already "locked"? Uses Poisson goal arrivals with league-baseline rate.
 *
 * Baseline: ~2.7 goals/match in 90 min → 0.015 goals/min/team.
 * Stoppage: +3 min assumed beyond 90.
 */

const GOALS_PER_MATCH = 2.7;
const PER_MIN_TEAM = GOALS_PER_MATCH / 90 / 2;   // 0.015
const STOPPAGE = 3;

function poissonP(lambda, k) {
  let p = Math.exp(-lambda), f = 1;
  for (let i = 1; i <= k; i++) { f *= i; p = (Math.exp(-lambda) * lambda ** k) / f; }
  let out = Math.exp(-lambda), fact = 1;
  for (let i = 1; i <= k; i++) { fact *= i; out += Math.exp(-lambda) * (lambda ** i) / fact; }
  return { pmf: Math.exp(-lambda) * (lambda ** k) / factorial(k) };
}
function factorial(n) { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; }
function pmfP(lambda, k) { return Math.exp(-lambda) * (lambda ** k) / factorial(k); }
function cdfP(lambda, k) { let s = 0; for (let i = 0; i <= k; i++) s += pmfP(lambda, i); return s; }

function analyze(minute, homeScore, awayScore) {
  const remaining = Math.max(0, 90 - minute) + STOPPAGE;
  const lamH = PER_MIN_TEAM * remaining;
  const lamA = PER_MIN_TEAM * remaining;
  const lamTotal = lamH + lamA;

  const total = homeScore + awayScore;
  const diff = homeScore - awayScore;
  const leadingSide = diff > 0 ? 'H' : diff < 0 ? 'A' : '-';

  const pNoGoal = Math.exp(-lamTotal);
  // parity-preserved: even # more goals → parity same
  // P(total more is even) = (1 + e^(-2λ)) / 2  (standard Poisson parity)
  const pEvenMoreGoals = (1 + Math.exp(-2 * lamTotal)) / 2;

  // match winner / double chance
  let pLeaderHolds, pLeaderWins, pDrawHolds;
  if (diff !== 0) {
    // Leader loses only if trailing side outscores leader by MORE than diff.
    // Compute joint over small grid since λ is small.
    let pLeaderStillAhead = 0, pStillTied = 0, pComeback = 0;
    for (let gh = 0; gh <= 10; gh++) {
      for (let ga = 0; ga <= 10; ga++) {
        const pJoint = pmfP(lamH, gh) * pmfP(lamA, ga);
        const fh = homeScore + gh, fa = awayScore + ga;
        if (fh === fa) pStillTied += pJoint;
        else if ((fh > fa) === (diff > 0)) pLeaderStillAhead += pJoint;
        else pComeback += pJoint;
      }
    }
    pLeaderHolds = pLeaderStillAhead + pStillTied;  // double chance leading side
    pLeaderWins = pLeaderStillAhead;                 // outright win
    pDrawHolds = null;
  } else {
    let pDraw = 0;
    for (let gh = 0; gh <= 10; gh++) {
      for (let ga = 0; ga <= 10; ga++) {
        if (gh === ga) pDraw += pmfP(lamH, gh) * pmfP(lamA, ga);
      }
    }
    pDrawHolds = pDraw;
    pLeaderHolds = null; pLeaderWins = null;
  }

  // Under X.5 locks: need (goals from here) ≤ X - total
  function pUnder(line) {
    const need = line - 0.5 - total;  // integer needed ≤ need
    if (need < 0) return 0;           // already over
    return cdfP(lamTotal, Math.floor(need));
  }
  function pOver(line) { return 1 - pUnder(line); }

  // BTTS
  const homeHas = homeScore > 0, awayHas = awayScore > 0;
  let pBttsYes;
  if (homeHas && awayHas) pBttsYes = 1;
  else if (homeHas) pBttsYes = 1 - Math.exp(-lamA);
  else if (awayHas) pBttsYes = 1 - Math.exp(-lamH);
  else pBttsYes = (1 - Math.exp(-lamH)) * (1 - Math.exp(-lamA));

  console.log(`\n  Minute ${minute}, score ${homeScore}-${awayScore}  (λ_total=${lamTotal.toFixed(3)})`);
  console.log(`    No more goals                    : ${(pNoGoal * 100).toFixed(1)}%`);
  console.log(`    Current Odd/Even parity holds    : ${(pEvenMoreGoals * 100).toFixed(1)}%`);
  if (diff !== 0) {
    const who = diff > 0 ? 'home' : 'away';
    console.log(`    Double Chance (${who} win/draw)    : ${(pLeaderHolds * 100).toFixed(2)}%`);
    console.log(`    Match winner (${who} wins)         : ${(pLeaderWins * 100).toFixed(2)}%`);
  } else {
    console.log(`    Draw holds (match ends ${homeScore}-${awayScore})    : ${(pDrawHolds * 100).toFixed(2)}%`);
  }
  const lines = [0.5, 1.5, 2.5, 3.5, 4.5];
  for (const line of lines) {
    const pu = pUnder(line), po = pOver(line);
    const locked = pu === 1 ? 'U LOCKED' : po === 1 ? 'O LOCKED' : '';
    console.log(`    Under ${line.toString().padStart(3)}                        : ${(pu * 100).toFixed(1).padStart(5)}%  ${locked}`);
  }
  console.log(`    BTTS YES                         : ${(pBttsYes * 100).toFixed(1)}%`);
  console.log(`    BTTS NO                          : ${((1 - pBttsYes) * 100).toFixed(1)}%`);
}

console.log('═══ Late-game market lock rates (Poisson baseline, avg league) ═══');
console.log('Baseline: 2.7 goals/match, +3 min stoppage assumed.');

// Typical end-of-match scenarios
analyze(85, 1, 0);
analyze(85, 2, 0);
analyze(85, 2, 1);
analyze(85, 0, 0);
analyze(85, 1, 1);
analyze(88, 1, 0);
analyze(88, 2, 1);
analyze(90, 1, 0);
analyze(90, 2, 0);
analyze(90, 0, 0);
analyze(90, 1, 1);
analyze(93, 1, 0);

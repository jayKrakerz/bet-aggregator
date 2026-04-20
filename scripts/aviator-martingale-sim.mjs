#!/usr/bin/env node
/**
 * Simulate three strategies on a fair Spribe-style crash RNG:
 *   A) Flat bet at 2x every round
 *   B) Martingale to 2x, start any time
 *   C) Martingale to 2x, ONLY start after 15 consecutive sub-2x rounds
 *
 * If the "wait for 15 sub-2x" trigger adds an edge, strategy C beats B.
 * If each round is independent, C and B converge to the same per-bet EV;
 * C just bets less often.
 */

const HOUSE_EDGE = 0.01;           // 1% — standard Spribe
const TARGET = 2.0;                // cashout multiplier
const BASE_BET = 1;
const MAX_STEPS = 10;              // martingale cap (bankroll / table limit)
const BANKROLL_START = 1024;       // covers 10 doublings
const ROUNDS = 1_000_000;
const SEED_TRIALS = 5;

function fairCrash() {
  // Spribe formula: 1/33 of rounds instant-crash at 1.00
  if (Math.random() * 33 < 1) return 1.00;
  const u = Math.random();
  // crash = (100-edge) / (100*(1-u)) — canonical provably-fair with edge
  return Math.max(1.00, Math.floor(((100 - HOUSE_EDGE * 100) / (100 * (1 - u))) * 100) / 100);
}

function simulate(label, triggerFn) {
  let bankroll = BANKROLL_START;
  let bets = 0, wins = 0, losses = 0;
  let step = 0;                 // current martingale step (0 = not in a run)
  let inRun = false;
  let subStreak = 0;
  let ruinCount = 0;
  let maxDrawdown = 0;
  let peak = bankroll;

  for (let i = 0; i < ROUNDS; i++) {
    const crash = fairCrash();
    const triggerOk = triggerFn(subStreak);

    if (!inRun && triggerOk) { inRun = true; step = 0; }

    if (inRun) {
      const bet = BASE_BET * 2 ** step;
      if (bet > bankroll) { ruinCount++; bankroll = BANKROLL_START; inRun = false; step = 0; }
      else {
        bets++;
        if (crash >= TARGET) {
          bankroll += bet;       // net +bet (we get 2×bet back, paid bet)
          wins++;
          inRun = false; step = 0;
        } else {
          bankroll -= bet;
          losses++;
          step++;
          if (step > MAX_STEPS) { inRun = false; step = 0; } // cap + eat loss
        }
      }
    }

    // streak tracking runs on ALL rounds, bet or not
    if (crash < TARGET) subStreak++; else subStreak = 0;
    if (bankroll > peak) peak = bankroll;
    const dd = peak - bankroll;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const netUnits = bankroll - BANKROLL_START - ruinCount * BANKROLL_START;
  // ruinCount * BANKROLL_START = extra capital we "printed" on reset
  const evPerBet = bets ? netUnits / bets : 0;
  console.log(
    `  ${label.padEnd(42)}` +
    ` bets=${String(bets).padStart(7)}` +
    ` win%=${(100 * wins / Math.max(1, bets)).toFixed(1).padStart(4)}` +
    ` net=${netUnits.toFixed(0).padStart(7)}` +
    ` EV/bet=${evPerBet.toFixed(4).padStart(8)}` +
    ` ruin=${ruinCount}` +
    ` maxDD=${maxDrawdown}`
  );
  return { bets, wins, netUnits, evPerBet, ruinCount };
}

console.log(`Simulating ${ROUNDS.toLocaleString()} rounds, ${SEED_TRIALS} trials each`);
console.log(`Fair crash: Spribe formula, ${(HOUSE_EDGE * 100).toFixed(1)}% house edge`);
console.log(`Martingale: base=1, cap=${MAX_STEPS} doublings (max bet ${2 ** MAX_STEPS})`);
console.log(`Bankroll per run: ${BANKROLL_START} (resets on ruin, counted as capital injection)\n`);

for (let trial = 1; trial <= SEED_TRIALS; trial++) {
  console.log(`── Trial ${trial} ──`);
  simulate('A) flat 2x every round',                    () => true);
  simulate('B) martingale, start anytime',              () => true);
  simulate('C) martingale, start after 15 sub-2x',      (s) => s >= 15);
  simulate('D) martingale, start after 5 sub-2x',       (s) => s >= 5);
  console.log();
}

#!/usr/bin/env node
/**
 * Long-run focus on strategy C: "wait for 15 sub-2x, then martingale to 2x".
 *
 * In a 1M-round sample, C only triggers ~60 times — too few for its rare ruin
 * events to show up, which makes it look like free money. Run 100M rounds so
 * the law of large numbers catches up.
 */
const HOUSE_EDGE = 0.01;
const TARGET = 2.0;
const BASE_BET = 1;
const MAX_STEPS = 10;              // cap = 10 doublings (max bet 1024)
const ROUNDS = 100_000_000;

function fairCrash() {
  if (Math.random() * 33 < 1) return 1.00;
  const u = Math.random();
  return Math.max(1.00, Math.floor(((100 - HOUSE_EDGE * 100) / (100 * (1 - u))) * 100) / 100);
}

function run(waitThreshold) {
  let pnl = 0, bets = 0, wins = 0, ruins = 0;
  let step = 0, inRun = false, subStreak = 0;

  for (let i = 0; i < ROUNDS; i++) {
    const crash = fairCrash();
    if (!inRun && subStreak >= waitThreshold) { inRun = true; step = 0; }

    if (inRun) {
      const bet = BASE_BET * 2 ** step;
      bets++;
      if (crash >= TARGET) {
        pnl += bet; wins++;
        inRun = false; step = 0;
      } else {
        pnl -= bet;
        step++;
        if (step > MAX_STEPS) { ruins++; inRun = false; step = 0; }
      }
    }
    if (crash < TARGET) subStreak++; else subStreak = 0;
  }
  return { bets, wins, pnl, ruins };
}

console.log(`Long run: ${ROUNDS.toLocaleString()} rounds per strategy\n`);

for (const w of [0, 5, 10, 15, 20]) {
  const r = run(w);
  const evPerBet = r.pnl / Math.max(1, r.bets);
  console.log(
    `  wait ≥${String(w).padStart(2)} sub-2x:` +
    ` bets=${String(r.bets).padStart(9)}` +
    ` win%=${(100 * r.wins / Math.max(1, r.bets)).toFixed(2)}` +
    ` ruins=${String(r.ruins).padStart(4)}` +
    ` pnl=${String(r.pnl).padStart(8)}` +
    ` EV/bet=${evPerBet.toFixed(4)}` +
    ` pnl/round=${(r.pnl / ROUNDS).toFixed(6)}`
  );
}

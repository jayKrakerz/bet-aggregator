#!/usr/bin/env node
/**
 * Offline smoke-test: drop a synthetic 88' match into the scanner's
 * Poisson model and see what it would pick from Sportybet odds. Uses
 * the REAL shape returned by the Sportybet API.
 */
import { readFileSync } from 'node:fs';

// Reimplement the core Poisson math here (mirror of late-lock-scanner.ts)
const STOPPAGE = 3;
const LEAGUE_GOALS = 2.7;

function fact(n) { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; }
function pmf(l, k) { return Math.exp(-l) * l ** k / fact(k); }
function cdf(l, k) { let s = 0; for (let i = 0; i <= k; i++) s += pmf(l, i); return Math.min(1, s); }

// Synthetic match: 88', score 1-0 home
const match = {
  homeTeamName: 'Team A',
  awayTeamName: 'Team B',
  score: '1:0',
  minute: "88'",
  matchStatus: 'H2',
  // Realistic Sportybet odds at 88' score 1-0:
  markets: [
    { id: '1', specifier: '', outcomes: [
      { id: '1', odds: '1.12', isActive: 1 },   // Home
      { id: '2', odds: '8.00', isActive: 1 },   // Draw
      { id: '3', odds: '26.00', isActive: 1 },  // Away
    ]},
    { id: '10', specifier: '', outcomes: [
      { id: '9', odds: '1.03', isActive: 1 },   // 1X
      { id: '10', odds: '1.08', isActive: 1 },  // 12
      { id: '11', odds: '5.50', isActive: 1 },  // X2
    ]},
    { id: '18', specifier: 'total=1.5', outcomes: [
      { id: '12', odds: '8.00', isActive: 1 },  // Over
      { id: '13', odds: '1.08', isActive: 1 },  // Under 1.5
    ]},
    { id: '18', specifier: 'total=2.5', outcomes: [
      { id: '12', odds: '30.00', isActive: 1 }, // Over
      { id: '13', odds: '1.01', isActive: 1 },  // Under 2.5
    ]},
    { id: '26', specifier: '', outcomes: [
      // Realistic lagged price — Sportybet slow to tighten odd/even after parity flips
      { id: '70', odds: '1.18', isActive: 1 },  // Odd (current total = 1, parity = odd)
      { id: '72', odds: '4.50', isActive: 1 },  // Even
    ]},
  ],
};

const min = parseInt(match.minute.match(/\d+/)[0]);
const [h, a] = match.score.split(':').map(Number);
const total = h + a;
const diff = h - a;
const remain = Math.max(0, 90 - min) + STOPPAGE;
const lam = LEAGUE_GOALS * (remain / 90);
const lamHalf = lam / 2;

function findOdds(markets, mid, oid, spec = '') {
  for (const m of markets) {
    if (m.id !== mid) continue;
    if (spec && m.specifier !== spec) continue;
    for (const o of m.outcomes) {
      if (o.id === oid && o.isActive === 1) return parseFloat(o.odds);
    }
  }
  return null;
}

console.log(`Synthetic match: ${match.homeTeamName} ${match.score} ${match.awayTeamName} at ${match.minute}`);
console.log(`λ_total = ${lam.toFixed(3)}, stoppage = ${STOPPAGE}min\n`);

const picks = [];

// Odd/Even
const parity = total % 2 === 0 ? 'even' : 'odd';
const pHold = (1 + Math.exp(-2 * lam)) / 2;
const oeOdds = findOdds(match.markets, '26', parity === 'odd' ? '70' : '72');
if (oeOdds) {
  const ev = pHold * oeOdds - 1;
  picks.push({ market: `Odd/Even ${parity}`, odds: oeOdds, prob: pHold, ev });
}

// Unders
for (const extra of [0.5, 1.5, 2.5]) {
  const line = total + extra;
  const spec = `total=${line.toFixed(1)}`;
  const o = findOdds(match.markets, '18', '13', spec);
  if (!o) continue;
  const pUnder = cdf(lam, Math.floor(extra));
  const ev = pUnder * o - 1;
  picks.push({ market: `Under ${line}`, odds: o, prob: pUnder, ev });
}

// Double Chance on leader
if (diff !== 0) {
  let pLeader = 0;
  for (let hm = 0; hm <= 8; hm++)
    for (let am = 0; am <= 8; am++) {
      const fh = h + hm, fa = a + am;
      if ((fh >= fa && diff > 0) || (fa >= fh && diff < 0))
        pLeader += pmf(lamHalf, hm) * pmf(lamHalf, am);
    }
  const oid = diff > 0 ? '9' : '11';
  const dc = findOdds(match.markets, '10', oid);
  if (dc) {
    const ev = pLeader * dc - 1;
    picks.push({ market: `Double Chance ${diff > 0 ? '1X' : 'X2'}`, odds: dc, prob: pLeader, ev });
  }
}

// Sort by EV
picks.sort((a, b) => b.ev - a.ev);

console.log('Available picks (sorted by EV):');
console.log('  Market'.padEnd(28) + 'odds   p(win)   implied   EV%');
for (const p of picks) {
  const ev = (p.ev * 100).toFixed(2);
  const evStr = p.ev >= 0 ? `+${ev}%` : `${ev}%`;
  console.log(
    `  ${p.market.padEnd(26)} ${p.odds.toFixed(2).padStart(5)}` +
    `  ${(p.prob * 100).toFixed(1).padStart(5)}%` +
    `   ${(100 / p.odds).toFixed(1).padStart(5)}%` +
    `   ${evStr.padStart(7)}`
  );
}

console.log('\nScanner would return picks with EV >= +0.5% and odds >= 1.05:');
for (const p of picks) {
  if (p.ev * 100 >= 0.5 && p.odds >= 1.05) {
    console.log(`  ✓ ${p.market} @ ${p.odds} (EV +${(p.ev * 100).toFixed(2)}%)`);
  }
}

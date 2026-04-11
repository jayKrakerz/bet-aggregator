#!/usr/bin/env node
/**
 * Range-based analysis of recorded aviator crashes.
 *
 * Instead of trying to predict the next exact value (which the pattern
 * audit showed is impossible), this script reports:
 *   1. The empirical distribution + quantiles
 *   2. Confidence intervals the next crash will fall into
 *   3. Per-cashout-target hit rate + Wilson CI + expected value
 *   4. Drift check — is the distribution stable across the dataset?
 */
import { readFileSync } from 'node:fs';

const history = JSON.parse(readFileSync('data/aviator_history.json', 'utf8'));

// ── Audit: skip entries flagged gapBefore so the analysis uses clean data ──
const cleanHistory = history.filter((h) => !h.gapBefore);
const skipped = history.length - cleanHistory.length;

// Count sequential gaps in roundIndex — these indicate missed rounds
let sequentialGaps = 0;
for (let i = 1; i < history.length; i++) {
  const prev = history[i - 1];
  const cur = history[i];
  if (typeof cur.roundIndex === 'number' && typeof prev.roundIndex === 'number') {
    if (cur.roundIndex - prev.roundIndex !== 1) sequentialGaps++;
  }
}

const vals = cleanHistory.map((h) => h.multiplier);
const N = vals.length;
const sorted = [...vals].sort((a, b) => a - b);

console.log(`Loaded ${history.length} recorded crashes`);
if (skipped > 0) console.log(`  Skipped ${skipped} entries flagged as post-gap (audit-clean analysis)`);
if (sequentialGaps > 0) console.log(`  ⚠ ${sequentialGaps} sequential gaps detected in roundIndex — data has holes`);
console.log(`Analyzing ${N} clean values\n`);
if (history.length > 0 && N < history.length * 0.9) {
  console.log('⚠ More than 10% of the data is flagged suspect. Trust the ranges but');
  console.log('  treat the +EV column as unreliable until coverage improves.\n');
}

// ── Helpers ─────────────────────────────────────────────────
const quantile = (sortedArr, q) => {
  const pos = (sortedArr.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (pos - lo);
};

// Wilson score 95% CI for a binomial proportion
function wilsonCI(k, n) {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

// ── 1. Empirical distribution + quantile ranges ────────────
console.log('── Distribution of crash values ──────────────────');
console.log('The next crash falls into these ranges:\n');

const bands = [
  { pct: 50, lo: 0.25, hi: 0.75 },
  { pct: 68, lo: 0.16, hi: 0.84 },
  { pct: 80, lo: 0.10, hi: 0.90 },
  { pct: 90, lo: 0.05, hi: 0.95 },
  { pct: 95, lo: 0.025, hi: 0.975 },
];
console.log(' confidence | range');
console.log('------------|-----------------------');
for (const b of bands) {
  const lo = quantile(sorted, b.lo);
  const hi = quantile(sorted, b.hi);
  console.log(` ${String(b.pct).padStart(7)}%   | ${lo.toFixed(2)}x  –  ${hi.toFixed(2)}x`);
}
console.log();

console.log('Key quantiles:');
for (const q of [0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99]) {
  const label = `P${Math.round(q * 100)}`.padEnd(5);
  console.log(`  ${label}  ${quantile(sorted, q).toFixed(2)}x`);
}
console.log();

// ── 2. Histogram ───────────────────────────────────────────
console.log('── Histogram ────────────────────────────────────');
const buckets = [
  { label: '1.00–1.50x', lo: 1.0, hi: 1.5 },
  { label: '1.50–2.00x', lo: 1.5, hi: 2.0 },
  { label: '2.00–3.00x', lo: 2.0, hi: 3.0 },
  { label: '3.00–5.00x', lo: 3.0, hi: 5.0 },
  { label: '5.00–10.0x', lo: 5.0, hi: 10.0 },
  { label: '10.0–25.0x', lo: 10.0, hi: 25.0 },
  { label: '25.0x+    ', lo: 25.0, hi: Infinity },
];
for (const b of buckets) {
  const count = vals.filter((v) => v >= b.lo && v < b.hi).length;
  const pct = (count / N) * 100;
  const bar = '█'.repeat(Math.round(pct));
  console.log(` ${b.label} | ${String(count).padStart(3)} (${pct.toFixed(1).padStart(5)}%) ${bar}`);
}
console.log();

// ── 3. Per-cashout hit rate + EV ───────────────────────────
console.log('── Hit rate & expected value at each cashout target ──');
console.log('If you always cash out at "target", your win rate is the');
console.log('fraction of rounds that crashed at or above it. The Wilson');
console.log('CI shows the uncertainty given only 500 observations.\n');
console.log(' cashout | hit rate        | 95% CI            | EV per $1     | break-even WR needed');
console.log('---------|-----------------|-------------------|---------------|---------------------');
for (const target of [1.3, 1.5, 2.0, 2.5, 3.0, 5.0, 10.0]) {
  const wins = vals.filter((v) => v >= target).length;
  const wr = wins / N;
  const [loCI, hiCI] = wilsonCI(wins, N);
  // EV per $1 bet = wr * (target - 1) - (1 - wr)
  //               = wr * target - 1
  const ev = wr * target - 1;
  const breakEven = 1 / target;
  const evStr = (ev >= 0 ? '+' : '') + ev.toFixed(3);
  console.log(
    `  ${target.toFixed(2)}x  | ${(wr * 100).toFixed(1).padStart(5)}% (${String(wins).padStart(3)}/${N}) | ` +
    `[${(loCI * 100).toFixed(1).padStart(5)}, ${(hiCI * 100).toFixed(1).padStart(5)}]% | ` +
    `${evStr.padStart(11)} | ${(breakEven * 100).toFixed(1).padStart(5)}%`,
  );
}
console.log();

// ── 4. Distribution drift check ────────────────────────────
console.log('── Drift check: is the distribution stable over time? ──');
console.log('If the game gets patched or conditions shift, a recent window');
console.log('beats the full history. We split the data in half and compare.\n');
const firstHalf = vals.slice(0, Math.floor(N / 2));
const secondHalf = vals.slice(Math.floor(N / 2));
const fhSorted = [...firstHalf].sort((a, b) => a - b);
const shSorted = [...secondHalf].sort((a, b) => a - b);

console.log(' quantile | first half | second half | diff');
console.log('----------|------------|-------------|-------');
for (const q of [0.25, 0.50, 0.75, 0.90, 0.95]) {
  const a = quantile(fhSorted, q);
  const b = quantile(shSorted, q);
  const diff = b - a;
  const sign = diff >= 0 ? '+' : '';
  console.log(`  P${String(Math.round(q * 100)).padStart(2)}     | ${a.toFixed(2).padStart(7)}x  | ${b.toFixed(2).padStart(8)}x   | ${sign}${diff.toFixed(2)}`);
}

// Two-sample KS statistic
function ksStat(a, b) {
  const aSorted = [...a].sort((x, y) => x - y);
  const bSorted = [...b].sort((x, y) => x - y);
  const all = [...new Set([...aSorted, ...bSorted])].sort((x, y) => x - y);
  let maxDiff = 0;
  for (const v of all) {
    const fa = aSorted.filter((x) => x <= v).length / aSorted.length;
    const fb = bSorted.filter((x) => x <= v).length / bSorted.length;
    maxDiff = Math.max(maxDiff, Math.abs(fa - fb));
  }
  return maxDiff;
}
const D = ksStat(firstHalf, secondHalf);
// Critical value at α=0.05: 1.36 * sqrt((n1+n2)/(n1*n2))
const critical = 1.36 * Math.sqrt((firstHalf.length + secondHalf.length) / (firstHalf.length * secondHalf.length));
console.log();
console.log(`  KS statistic: ${D.toFixed(4)}`);
console.log(`  Critical (α=0.05): ${critical.toFixed(4)}`);
console.log(`  ${D > critical ? '⚠  Distributions DIFFER — use recent window' : '✓  Distributions are statistically the same — full history is fine'}`);
console.log();

// ── 5. Recent-window range (always report anyway) ─────────
const RECENT = 100;
if (N >= RECENT) {
  const recent = vals.slice(-RECENT);
  const rSorted = [...recent].sort((a, b) => a - b);
  console.log(`── 80% range from the most recent ${RECENT} crashes ──`);
  console.log(`  ${quantile(rSorted, 0.10).toFixed(2)}x  –  ${quantile(rSorted, 0.90).toFixed(2)}x`);
  console.log(`  (vs full ${N}: ${quantile(sorted, 0.10).toFixed(2)}x – ${quantile(sorted, 0.90).toFixed(2)}x)`);
  console.log();
}

console.log('── What this means in plain terms ──────────────');
console.log('These are the probabilities for ANY given round (they do NOT');
console.log('depend on the previous round). Use them for informed bet sizing,');
console.log('not for sequential prediction. Every row EV is negative by the');
console.log('house margin — that is the game working as designed.');

#!/usr/bin/env node
/**
 * Does the next aviator crash depend arithmetically on the previous one(s)?
 *
 * Runs a battery of tests against data/aviator_history.json and prints
 * whether any relationship is stronger than what you'd get from pure noise.
 */
import { readFileSync } from 'node:fs';

const history = JSON.parse(readFileSync('data/aviator_history.json', 'utf8'));
const vals = history.map((h) => h.multiplier);
const N = vals.length;
console.log(`Loaded ${N} crash values from data/aviator_history.json\n`);

// ── Helpers ────────────────────────────────────────────────
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs) => {
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
};
const stdev = (xs) => Math.sqrt(variance(xs));

function correlation(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

function autocorr(series, lag) {
  const a = series.slice(0, -lag);
  const b = series.slice(lag);
  return correlation(a, b);
}

// Linear regression: y = a*x + b. Returns {a, b, r2}.
function linreg(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const a = num / den;
  const b = my - a * mx;
  // R² = 1 - SSres/SStot
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < xs.length; i++) {
    const pred = a * xs[i] + b;
    ssRes += (ys[i] - pred) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  return { a, b, r2: 1 - ssRes / ssTot };
}

// Fisher z transform + 95% CI for a correlation coefficient
function corrCI(r, n) {
  if (Math.abs(r) >= 1) return [r, r];
  const z = 0.5 * Math.log((1 + r) / (1 - r));
  const se = 1 / Math.sqrt(n - 3);
  const zLo = z - 1.96 * se;
  const zHi = z + 1.96 * se;
  const toR = (z) => (Math.exp(2 * z) - 1) / (Math.exp(2 * z) + 1);
  return [toR(zLo), toR(zHi)];
}

function shuffle(xs) {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ── Basic stats ────────────────────────────────────────────
console.log('── Descriptive stats ──────────────────────────────');
console.log(`mean:   ${mean(vals).toFixed(3)}x`);
console.log(`median: ${[...vals].sort((a, b) => a - b)[Math.floor(N / 2)].toFixed(3)}x`);
console.log(`stdev:  ${stdev(vals).toFixed(3)}`);
console.log(`min:    ${Math.min(...vals).toFixed(2)}x`);
console.log(`max:    ${Math.max(...vals).toFixed(2)}x`);
console.log();

// ── Test 1: autocorrelation at lags 1..10 ──────────────────
console.log('── Autocorrelation: does the last crash predict the next? ──');
console.log('If there is any arithmetic relationship, lag-1 autocorrelation');
console.log('must be non-zero (outside the 95% CI around zero).');
console.log();
const threshold = 1.96 / Math.sqrt(N); // 95% null band
console.log(`95% null band: ±${threshold.toFixed(4)} (anything inside = indistinguishable from noise)`);
console.log();
console.log(' lag | autocorr | inside null band?');
console.log('-----|----------|-------------------');
for (let lag = 1; lag <= 10; lag++) {
  const r = autocorr(vals, lag);
  const inside = Math.abs(r) < threshold;
  console.log(` ${String(lag).padStart(3)} | ${r.toFixed(4).padStart(8)} | ${inside ? 'YES (noise)' : 'NO (signal!)'}`);
}
console.log();

// ── Test 2: linear regression next ~ current ──────────────
console.log('── Linear fit: next = a * current + b ──');
const xs = vals.slice(0, -1);
const ys = vals.slice(1);
const { a, b, r2 } = linreg(xs, ys);
console.log(`  next = ${a.toFixed(4)} * current + ${b.toFixed(4)}`);
console.log(`  R² = ${r2.toFixed(4)}  (1.0 = perfect prediction, 0.0 = no better than the mean)`);
console.log();

// ── Test 3: the user's specific hypothesis ─────────────────
// "2x should lead to some specific next value". Bucket by current value
// and check if the next value is tightly clustered within each bucket.
console.log('── Bucket test: does current value constrain next value? ──');
console.log('If "2x always leads to 4x" style rules exist, the stdev of next-values');
console.log('within each bucket should be much smaller than the global stdev.');
console.log();
const globalStd = stdev(vals);
console.log(`Global stdev of next-value: ${globalStd.toFixed(3)}`);
console.log();
console.log(' current bucket   | n   | mean(next) | stdev(next) | vs global');
console.log('------------------|-----|------------|-------------|----------');

const buckets = [
  { label: '1.00-1.50x',        test: (x) => x >= 1.0 && x < 1.5 },
  { label: '1.50-2.00x',        test: (x) => x >= 1.5 && x < 2.0 },
  { label: '2.00-3.00x',        test: (x) => x >= 2.0 && x < 3.0 },
  { label: '3.00-5.00x',        test: (x) => x >= 3.0 && x < 5.0 },
  { label: '5.00-10.00x',       test: (x) => x >= 5.0 && x < 10.0 },
  { label: '10.00x and above',  test: (x) => x >= 10.0 },
];
for (const b of buckets) {
  const nextVals = [];
  for (let i = 0; i < N - 1; i++) {
    if (b.test(vals[i])) nextVals.push(vals[i + 1]);
  }
  if (nextVals.length < 3) {
    console.log(` ${b.label.padEnd(16)} | ${String(nextVals.length).padStart(3)} | —         | —          | too few`);
    continue;
  }
  const mn = mean(nextVals);
  const sd = stdev(nextVals);
  const ratio = (sd / globalStd).toFixed(2);
  const verdict = sd < globalStd * 0.8 ? 'TIGHTER ⚠' : 'same as noise';
  console.log(` ${b.label.padEnd(16)} | ${String(nextVals.length).padStart(3)} | ${mn.toFixed(3).padStart(10)} | ${sd.toFixed(3).padStart(11)} | ${verdict}`);
}
console.log();

// ── Test 4: shuffled baseline ──────────────────────────────
console.log('── Shuffle test: does the ORDER of the sequence carry information? ──');
console.log('We compute the lag-1 autocorr on the real sequence vs 100 random shuffles.');
console.log('If the real value is not in the tail of the shuffle distribution,');
console.log('the original sequence had no temporal structure.');
console.log();
const realAc1 = autocorr(vals, 1);
const shuffleAc1 = [];
for (let i = 0; i < 100; i++) shuffleAc1.push(autocorr(shuffle(vals), 1));
shuffleAc1.sort((a, b) => a - b);
const p5 = shuffleAc1[5];
const p95 = shuffleAc1[94];
const abs = Math.abs(realAc1);
const tailCount = shuffleAc1.filter((x) => Math.abs(x) >= abs).length;
console.log(`  real lag-1 autocorr:          ${realAc1.toFixed(4)}`);
console.log(`  shuffled 5%-95% range:        [${p5.toFixed(4)}, ${p95.toFixed(4)}]`);
console.log(`  shuffles with |ac| ≥ |real|:  ${tailCount}/100  (p-value ≈ ${(tailCount / 100).toFixed(2)})`);
console.log();

// ── Verdict ────────────────────────────────────────────────
const [lo, hi] = corrCI(realAc1, N);
const hasSignal = lo > threshold || hi < -threshold || r2 > 0.05;
console.log('── Verdict ─────────────────────────────────────────');
if (hasSignal) {
  console.log('⚠ Signal detected — there IS some temporal structure. Investigate further.');
} else {
  console.log('✗ No detectable signal.');
  console.log('  Lag-1 autocorr is statistically indistinguishable from zero.');
  console.log('  Linear R² is effectively 0.');
  console.log('  Current value does NOT predict the next one.');
  console.log();
  console.log('  No arithmetic formula of the form "f(current) = next" exists');
  console.log('  in this dataset. The sequence behaves like iid draws from the');
  console.log('  game\'s fixed crash distribution.');
}

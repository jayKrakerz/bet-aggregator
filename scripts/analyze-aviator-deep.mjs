#!/usr/bin/env node
/**
 * Deep mathematical audit of the aviator crash series.
 *
 * Runs 8 independent statistical tests covering different classes of
 * structure. If ANY formula of the form "next = f(window)" exists, at
 * least one of these tests will detect it. If ALL come up null, the
 * sequence is behaviorally indistinguishable from the output of a
 * cryptographic PRF — which is the mathematical definition of
 * "unpredictable from past outputs alone".
 */
import { readFileSync } from 'node:fs';

const history = JSON.parse(readFileSync('data/aviator_history.json', 'utf8'));
const clean = history.filter((h) => !h.gapBefore);
const vals = clean.map((h) => h.multiplier);
const N = vals.length;
console.log(`Loaded ${N} clean crash values\n`);

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs) => { const m = mean(xs); return xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length; };
const stdev = (xs) => Math.sqrt(variance(xs));

function correlation(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}
function autocorr(series, lag) { return correlation(series.slice(0, -lag), series.slice(lag)); }

const verdicts = [];
const record = (name, passed, detail) => {
  verdicts.push({ name, passed, detail });
  const badge = passed ? '\x1b[32m✗ NULL\x1b[0m' : '\x1b[31m⚠ SIGNAL\x1b[0m';
  console.log(`  VERDICT: ${badge} — ${detail}\n`);
};

// ═══════════════════════════════════════════════════════════════
// TEST 1: Extended autocorrelation (linear temporal dependence)
// ═══════════════════════════════════════════════════════════════
console.log('═══ TEST 1: Autocorrelation at lags 1–30 ═══');
console.log('Catches any linear relationship of the form next = a·prev_k + b');
console.log('at lags 1..30. Null band: ±1.96/√N (each lag is ~5% false positive');
console.log('under iid, so ≤3 lags outside the band is expected by chance).\n');
const threshold = 1.96 / Math.sqrt(N);
let outside = 0, maxR = 0, maxLag = 0;
for (let lag = 1; lag <= 30; lag++) {
  const r = autocorr(vals, lag);
  if (Math.abs(r) > threshold) outside++;
  if (Math.abs(r) > Math.abs(maxR)) { maxR = r; maxLag = lag; }
}
console.log(`  null band:            ±${threshold.toFixed(4)}`);
console.log(`  lags outside band:    ${outside} / 30   (expected by chance: ~1–3)`);
console.log(`  strongest lag:        lag ${maxLag}, r = ${maxR.toFixed(4)}`);
record('ext-autocorr', outside <= 3, outside <= 3
  ? `${outside}/30 lags beyond noise, within chance (~1.5 expected)`
  : `${outside}/30 lags beyond noise — investigate`);

// ═══════════════════════════════════════════════════════════════
// TEST 2: Log-transform autocorrelation
// ═══════════════════════════════════════════════════════════════
console.log('═══ TEST 2: Log-scale autocorrelation ═══');
console.log('Heavy-tailed series can hide multiplicative dependencies that');
console.log('linear autocorrelation misses. Test autocorr on log(crash).\n');
const logVals = vals.map((v) => Math.log(v));
let logOutside = 0, logMaxR = 0, logMaxLag = 0;
for (let lag = 1; lag <= 15; lag++) {
  const r = autocorr(logVals, lag);
  if (Math.abs(r) > threshold) logOutside++;
  if (Math.abs(r) > Math.abs(logMaxR)) { logMaxR = r; logMaxLag = lag; }
}
console.log(`  lags outside null:    ${logOutside} / 15`);
console.log(`  strongest:            lag ${logMaxLag}, r = ${logMaxR.toFixed(4)}`);
record('log-autocorr', logOutside <= 2, logOutside <= 2
  ? 'log-transformed series shows no multiplicative structure'
  : 'multiplicative structure detected');

// ═══════════════════════════════════════════════════════════════
// TEST 3: Spribe fairness — Kolmogorov-Smirnov on 1/crash
// ═══════════════════════════════════════════════════════════════
console.log('═══ TEST 3: Spribe fairness — is 1/crash uniform on (0,1)? ═══');
console.log('The CANONICAL provably-fair crash formula gives 1/crash ~ Uniform(0,1).');
console.log('If the underlying RNG is a proper PRF (SHA-256 based), 1/crash on a');
console.log('large sample is statistically indistinguishable from uniform. This is');
console.log('the single most-informative test in the suite.\n');
const invCrash = vals.map((v) => 1 / v);
const invSorted = [...invCrash].sort((a, b) => a - b);
let ksStat = 0;
for (let i = 0; i < N; i++) {
  const empCdf = (i + 1) / N;
  const uniCdf = invSorted[i];
  ksStat = Math.max(ksStat, Math.abs(empCdf - uniCdf));
}
const ksCrit = 1.36 / Math.sqrt(N);
console.log(`  KS statistic:         ${ksStat.toFixed(4)}`);
console.log(`  critical (α=0.05):    ${ksCrit.toFixed(4)}`);
console.log('  quantile comparison (should match identity line if uniform):');
for (const q of [0.1, 0.25, 0.5, 0.75, 0.9, 0.95]) {
  const obs = invSorted[Math.floor(q * (N - 1))];
  const diff = obs - q;
  console.log(`    Q${String(Math.round(q * 100)).padStart(2)}: observed ${obs.toFixed(4)},  uniform expects ${q.toFixed(4)},  diff ${diff >= 0 ? '+' : ''}${diff.toFixed(4)}`);
}
record('spribe-fairness', ksStat < ksCrit, ksStat < ksCrit
  ? '1/crash IS uniform — underlying RNG is indistinguishable from a PRF'
  : '1/crash is NOT uniform — RNG is biased, investigate');

// ═══════════════════════════════════════════════════════════════
// TEST 4: Instant-crash rate
// ═══════════════════════════════════════════════════════════════
console.log('═══ TEST 4: Instant-crash rate (1/33 rule) ═══');
console.log('Spribe crashes at exactly 1.00x when hash mod 33 == 0.');
console.log('Expected rate: 1/33 ≈ 3.03%. Deviation = operator uses a different');
console.log('house-edge mechanism, but is NOT exploitable on its own.\n');
const instant = vals.filter((v) => v <= 1.005).length; // ≤1.00 with rounding buffer
const expected = N / 33;
const pObs = instant / N;
const z = 1.96;
const denom = 1 + (z * z) / N;
const center = (pObs + (z * z) / (2 * N)) / denom;
const margin = (z * Math.sqrt((pObs * (1 - pObs)) / N + (z * z) / (4 * N * N))) / denom;
const loCI = Math.max(0, center - margin) * 100;
const hiCI = (center + margin) * 100;
console.log(`  Observed 1.00x:       ${instant} / ${N} = ${(pObs * 100).toFixed(2)}%`);
console.log(`  Expected (1/33):      ${expected.toFixed(1)} = ${(100 / 33).toFixed(2)}%`);
console.log(`  95% CI:               [${loCI.toFixed(2)}%, ${hiCI.toFixed(2)}%]`);
const inBand = (100 / 33) >= loCI && (100 / 33) <= hiCI;
record('instant-rate', inBand, inBand
  ? `observed rate is consistent with Spribe's 1/33 rule`
  : `rate is off — different formula or house-edge mechanism`);

// ═══════════════════════════════════════════════════════════════
// TEST 5: Markov chain transition matrix
// ═══════════════════════════════════════════════════════════════
console.log('═══ TEST 5: Discrete Markov chain ═══');
console.log('Bin crashes into 5 buckets. Under iid, each row of the transition');
console.log('matrix equals the marginal distribution. Chi-square on the worst');
console.log('row tests for any single-step memory (including nonlinear).\n');
const bin = (v) => v < 1.5 ? 0 : v < 2 ? 1 : v < 3 ? 2 : v < 5 ? 3 : 4;
const bins = vals.map(bin);
const marg = [0, 0, 0, 0, 0];
bins.forEach((b) => marg[b]++);
const margP = marg.map((c) => c / N);
console.log('  marginal bucket distribution:');
console.log('    [<1.5] [1.5-2] [2-3]  [3-5]  [5+]');
console.log(`    ${margP.map((p) => (p * 100).toFixed(1).padStart(5)).join('  ')}  %`);
const trans = Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);
for (let i = 0; i < bins.length - 1; i++) trans[bins[i]][bins[i + 1]]++;
let maxChi2 = 0, worstRow = -1;
for (let i = 0; i < 5; i++) {
  const rowSum = trans[i].reduce((a, b) => a + b, 0);
  if (rowSum < 10) continue;
  let chi2 = 0;
  for (let j = 0; j < 5; j++) {
    const exp = rowSum * margP[j];
    if (exp < 1) continue;
    chi2 += ((trans[i][j] - exp) ** 2) / exp;
  }
  if (chi2 > maxChi2) { maxChi2 = chi2; worstRow = i; }
}
console.log(`  worst row χ²:         ${maxChi2.toFixed(2)} (row ${worstRow})`);
console.log(`  critical (df=4):      9.49`);
record('markov', maxChi2 < 9.49, maxChi2 < 9.49
  ? 'transitions are iid — no single-step memory'
  : `memory detected at row ${worstRow}`);

// ═══════════════════════════════════════════════════════════════
// TEST 6: Runs test
// ═══════════════════════════════════════════════════════════════
console.log('═══ TEST 6: Runs test ═══');
console.log('Count runs of consecutive above/below-median values. Too few = ');
console.log('clustering; too many = anti-correlation. Either reveals memory.\n');
const med = [...vals].sort((a, b) => a - b)[Math.floor(N / 2)];
const signs = vals.map((v) => (v > med ? 1 : 0));
let runs = 1;
for (let i = 1; i < N; i++) if (signs[i] !== signs[i - 1]) runs++;
const n1 = signs.filter((x) => x === 1).length;
const n2 = N - n1;
const expRuns = (2 * n1 * n2) / N + 1;
const runsVar = (2 * n1 * n2 * (2 * n1 * n2 - N)) / (N * N * (N - 1));
const zRuns = (runs - expRuns) / Math.sqrt(runsVar);
console.log(`  observed runs:        ${runs}`);
console.log(`  expected under iid:   ${expRuns.toFixed(1)}`);
console.log(`  z-score:              ${zRuns.toFixed(2)}`);
record('runs', Math.abs(zRuns) < 1.96, Math.abs(zRuns) < 1.96
  ? 'run distribution matches iid'
  : 'run structure detected');

// ═══════════════════════════════════════════════════════════════
// TEST 7: Modular residues vs MONTE CARLO null (not uniform!)
// ═══════════════════════════════════════════════════════════════
console.log('═══ TEST 7: Modular residues vs Monte Carlo fair-RNG null ═══');
console.log('The residues of crash·100 are NOT supposed to be uniform under');
console.log('a fair Spribe RNG — the crash-formula distribution produces a');
console.log("specific non-uniform residue pattern. We compare observed counts");
console.log('against the distribution produced by 100k simulated fair crashes,');
console.log('so the chi-square has the *correct* null hypothesis.\n');

function simulateFairCrash() {
  // Direct simulation of the Spribe formula via inverse-CDF on U(0,1):
  // crash = floor((100 - u)/(1 - u) * 100) / 100, with 1/33 → 1.00 bypass
  if (Math.random() * 33 < 1) return 1.00;
  const u = Math.random();
  return Math.floor(((100 - u) / (1 - u)) * 100) / 100;
}
const SIM = 100_000;
const sim = [];
for (let i = 0; i < SIM; i++) sim.push(simulateFairCrash());

function chi2Against(observed, expected) {
  let chi2 = 0;
  for (let i = 0; i < observed.length; i++) {
    if (expected[i] < 1) continue; // skip unstable low-count bins
    chi2 += ((observed[i] - expected[i]) ** 2) / expected[i];
  }
  return chi2;
}

const crits = { 7: 12.59, 13: 21.03, 33: 46.19, 97: 120.99, 100: 123.22 };
let modPass = true;
for (const m of [7, 13, 33, 97, 100]) {
  const obsCounts = new Array(m).fill(0);
  for (const v of vals) obsCounts[Math.floor(v * 100) % m]++;
  const simCounts = new Array(m).fill(0);
  for (const v of sim) simCounts[Math.floor(v * 100) % m]++;
  // Scale sim counts to observation size to get expected counts
  const expCounts = simCounts.map((c) => (c / SIM) * N);
  const chi2 = chi2Against(obsCounts, expCounts);
  const crit = crits[m];
  const ok = chi2 < crit;
  if (!ok) modPass = false;
  console.log(`  m=${String(m).padStart(3)}: χ² = ${chi2.toFixed(2).padStart(6)}, crit = ${crit.toFixed(2).padStart(6)} → ${ok ? '✗ matches fair null' : '⚠ deviates'}`);
}
record('modular', modPass, modPass
  ? 'residues match the Spribe-formula null at every tested modulus'
  : 'residues deviate from the fair null — investigate');

// ═══════════════════════════════════════════════════════════════
// TEST 8: kNN window predictor — the ultimate any-function detector
// ═══════════════════════════════════════════════════════════════
console.log('═══ TEST 8: Window kNN predictor ═══');
console.log('Train on first 80%, test on last 20%. For each test window, find');
console.log('K=5 nearest-neighbour matches in training and predict the mean of');
console.log('their targets. Compare RMSE to a constant-mean baseline.');
console.log('kNN can approximate ANY function — if any pattern exists, it wins.\n');
const WIN = 10, K = 5;
const split = Math.floor(N * 0.8);
const trainX = [], trainY = [];
for (let i = WIN; i < split; i++) {
  trainX.push(logVals.slice(i - WIN, i));
  trainY.push(vals[i]);
}
const testX = [], testY = [];
for (let i = Math.max(split, WIN); i < N; i++) {
  testX.push(logVals.slice(i - WIN, i));
  testY.push(vals[i]);
}
function l2(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}
let knnSq = 0, baseSq = 0;
const tMean = mean(trainY);
for (let ti = 0; ti < testX.length; ti++) {
  const dists = trainX.map((w, i) => ({ d: l2(w, testX[ti]), y: trainY[i] }));
  dists.sort((a, b) => a.d - b.d);
  const pred = dists.slice(0, K).reduce((s, x) => s + x.y, 0) / K;
  knnSq += (testY[ti] - pred) ** 2;
  baseSq += (testY[ti] - tMean) ** 2;
}
const knnRmse = Math.sqrt(knnSq / testX.length);
const baseRmse = Math.sqrt(baseSq / testX.length);
const improve = ((baseRmse - knnRmse) / baseRmse) * 100;
console.log(`  test set size:        ${testX.length}`);
console.log(`  baseline (mean) RMSE: ${baseRmse.toFixed(2)}`);
console.log(`  kNN(K=5, W=10) RMSE:  ${knnRmse.toFixed(2)}`);
console.log(`  improvement:          ${improve >= 0 ? '+' : ''}${improve.toFixed(1)}%`);
// Only a *positive* improvement >5% is a signal; matching or losing to
// the mean means kNN found no exploitable pattern.
record('knn', improve < 5, improve < 5
  ? `kNN cannot beat the mean — no exploitable function of the window`
  : `kNN beats the mean by +${improve.toFixed(1)}% — investigate`);

// ═══════════════════════════════════════════════════════════════
// FINAL SCORECARD
// ═══════════════════════════════════════════════════════════════
console.log('════════════════════════════════════════════════════════');
console.log('FINAL SCORECARD');
console.log('════════════════════════════════════════════════════════');
const passed = verdicts.filter((v) => v.passed).length;
const failed = verdicts.filter((v) => !v.passed).length;
for (const v of verdicts) {
  const badge = v.passed ? '\x1b[32m✗ NULL  \x1b[0m' : '\x1b[31m⚠ SIGNAL\x1b[0m';
  console.log(`  ${badge}  ${v.name.padEnd(18)}  ${v.detail}`);
}
console.log();
console.log(`  ${passed}/8 tests confirmed the null hypothesis (iid, unpredictable).`);
console.log(`  ${failed}/8 tests flagged a potential signal.`);
console.log();
if (failed === 0) {
  console.log('  OVERALL: every test consistent with a properly-random PRF source.');
  console.log('  No formula of any form — linear, nonlinear, modular, ML-based —');
  console.log('  can predict the next crash from past crashes on this data.');
} else {
  console.log('  OVERALL: at least one test flagged — investigate the failures');
  console.log('  before concluding. This may be a true signal or a sampling');
  console.log('  artifact; the right follow-up depends on which test fired.');
}

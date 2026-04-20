#!/usr/bin/env node
/**
 * Permutation test for the borderline m=100 chi² finding.
 *
 * Chi² against a Monte Carlo null can inflate from small-count cells
 * at df=99 with N=500 (~5 expected per bin). The statistically
 * correct fix is to bootstrap the null distribution: draw many
 * 500-sample blocks from the MC pool, compute chi² for each
 * against the MC expected counts, and see where the observed
 * chi² falls in that empirical distribution.
 *
 * If observed chi² is in the top 5% of bootstrapped chi²s, it's
 * a real deviation. Otherwise it's noise from the sample size.
 */
import { readFileSync } from 'node:fs';

const history = JSON.parse(readFileSync('data/aviator_history.json', 'utf8'));
const vals = history.filter((h) => !h.gapBefore).map((h) => h.multiplier);
const N = vals.length;

function simulateFairCrash() {
  if (Math.random() * 33 < 1) return 1.00;
  const u = Math.random();
  return Math.floor(((100 - u) / (1 - u)) * 100) / 100;
}

const m = 100;
const MC_SIZE = 200_000;
const BOOTSTRAP = 2000;

console.log(`Permutation test on m=${m} residues`);
console.log(`Observed sample size: ${N}`);
console.log(`Monte Carlo pool:     ${MC_SIZE}`);
console.log(`Bootstrap iterations: ${BOOTSTRAP}\n`);

// Build the large MC pool
const mcPool = new Array(MC_SIZE);
for (let i = 0; i < MC_SIZE; i++) mcPool[i] = simulateFairCrash();

// Residue counts helper
function residues(arr) {
  const c = new Array(m).fill(0);
  for (const v of arr) c[Math.floor(v * 100) % m]++;
  return c;
}

// "Expected" = MC pool residues scaled to sample size N
const mcCounts = residues(mcPool);
const expected = mcCounts.map((c) => (c / MC_SIZE) * N);

// Chi² with small-count merging (standard practice): pool any bin
// whose expected count is < 5 into an "other" bucket.
function chi2(observed, expected) {
  let chi2 = 0;
  let poolObs = 0, poolExp = 0;
  let df = -1;
  for (let i = 0; i < observed.length; i++) {
    if (expected[i] < 5) {
      poolObs += observed[i];
      poolExp += expected[i];
    } else {
      chi2 += ((observed[i] - expected[i]) ** 2) / expected[i];
      df++;
    }
  }
  if (poolExp >= 5) {
    chi2 += ((poolObs - poolExp) ** 2) / poolExp;
    df++;
  }
  return { chi2, df };
}

// Observed chi² on real data
const obsCounts = residues(vals);
const { chi2: obsChi2, df } = chi2(obsCounts, expected);
console.log(`Effective df after merging: ${df}`);
console.log(`Observed chi²:              ${obsChi2.toFixed(2)}\n`);

// Bootstrap: draw BOOTSTRAP samples of size N from the MC pool,
// compute chi² for each, build empirical null distribution
console.log('Running bootstrap...');
const nullChi2s = new Array(BOOTSTRAP);
for (let b = 0; b < BOOTSTRAP; b++) {
  const sample = new Array(N);
  for (let i = 0; i < N; i++) sample[i] = mcPool[Math.floor(Math.random() * MC_SIZE)];
  const c = chi2(residues(sample), expected);
  nullChi2s[b] = c.chi2;
}
nullChi2s.sort((a, b) => a - b);

// Empirical quantiles
const q = (p) => nullChi2s[Math.floor(p * BOOTSTRAP)];
console.log();
console.log('Bootstrapped null distribution of chi²:');
console.log(`  Q05:    ${q(0.05).toFixed(2)}`);
console.log(`  Q25:    ${q(0.25).toFixed(2)}`);
console.log(`  median: ${q(0.50).toFixed(2)}`);
console.log(`  Q75:    ${q(0.75).toFixed(2)}`);
console.log(`  Q95:    ${q(0.95).toFixed(2)}`);
console.log(`  Q99:    ${q(0.99).toFixed(2)}`);
console.log(`  max:    ${nullChi2s[BOOTSTRAP - 1].toFixed(2)}`);

// Empirical p-value: fraction of null chi²s ≥ observed
const pExceed = nullChi2s.filter((x) => x >= obsChi2).length / BOOTSTRAP;
console.log();
console.log(`Fraction of null samples with chi² ≥ observed: ${pExceed.toFixed(3)}`);
console.log(`Empirical p-value: ${pExceed.toFixed(3)}`);
console.log();
if (pExceed >= 0.05) {
  console.log('VERDICT: ✗ observed chi² is consistent with sampling variance');
  console.log('         under a fair RNG. NOT a real deviation.');
} else if (pExceed >= 0.01) {
  console.log('VERDICT: ⚠ borderline (p < 0.05). Could be noise, could be signal.');
  console.log('         Collect more data before drawing conclusions.');
} else {
  console.log('VERDICT: ⚠⚠ observed chi² is significantly higher than the null');
  console.log('         distribution (p < 0.01). This IS a genuine deviation');
  console.log('         from the fair RNG expectation. Investigate.');
}

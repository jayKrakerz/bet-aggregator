/**
 * Fractional Kelly + EV helpers — port of bot-main FootStats core/kelly.py.
 *
 * Full Kelly is f* = (b·p − q) / b where b = odds − 1, q = 1 − p.
 * It's mathematically optimal long-term-growth but very swingy in practice
 * and assumes perfectly calibrated probabilities. We expose fractional
 * Kelly (f* / FRACTION, default 3) plus min/max stake caps to keep the
 * action reasonable on a typical bankroll.
 *
 * No imports, no I/O — pure functions, safe to call from any route.
 */

export interface KellyOptions {
  fraction?: number;     // safety divisor; default 3 (= 1/3 Kelly)
  minStake?: number;     // floor — 0 disables
  maxStake?: number;     // ceiling — Infinity disables
}

const DEFAULTS: Required<KellyOptions> = {
  fraction: 3,
  minStake: 0,
  maxStake: Infinity,
};

export interface KellyStakeResult {
  /** Recommended stake in the bankroll's currency. 0 when no edge. */
  stake: number;
  /** Raw f* (no fractional reduction). Negative → no bet. */
  fullKelly: number;
  /** Stake as a fraction of bankroll (after fraction reduction + caps). */
  fractionOfBankroll: number;
  /** True when min/max stake caps were applied. */
  capped: boolean;
}

/**
 * Recommended stake for a single bet given win prob p and decimal odds.
 * Returns 0 when there's no positive edge.
 */
export function kellyStake(
  p: number,
  odds: number,
  bankroll: number,
  opts: KellyOptions = {},
): KellyStakeResult {
  const o = { ...DEFAULTS, ...opts };

  if (!(bankroll > 0) || !(odds > 1.01) || !(p > 0 && p < 1)) {
    return { stake: 0, fullKelly: 0, fractionOfBankroll: 0, capped: false };
  }

  const b = odds - 1;
  const q = 1 - p;
  const fStar = (b * p - q) / b;

  if (fStar <= 0) {
    return { stake: 0, fullKelly: fStar, fractionOfBankroll: 0, capped: false };
  }

  const fractional = fStar / o.fraction;
  let raw = bankroll * fractional;
  const beforeCap = raw;
  raw = Math.max(o.minStake, Math.min(raw, o.maxStake));

  return {
    stake: round2(raw),
    fullKelly: round4(fStar),
    fractionOfBankroll: round4(raw / bankroll),
    capped: raw !== beforeCap,
  };
}

/**
 * Stake for an accumulator: treat the parlay as one event by multiplying
 * leg probabilities and leg odds. Sensitive to mis-calibrated p — use
 * fractional Kelly aggressively (default fraction=3 here too).
 */
export function kellyAccumulator(
  legs: Array<{ p: number; odds: number }>,
  bankroll: number,
  opts: KellyOptions = {},
): KellyStakeResult {
  if (legs.length === 0) {
    return { stake: 0, fullKelly: 0, fractionOfBankroll: 0, capped: false };
  }
  let pTotal = 1;
  let oddsTotal = 1;
  for (const l of legs) {
    if (!(l.p > 0 && l.p < 1) || !(l.odds > 1.01)) {
      return { stake: 0, fullKelly: 0, fractionOfBankroll: 0, capped: false };
    }
    pTotal *= l.p;
    oddsTotal *= l.odds;
  }
  return kellyStake(pTotal, oddsTotal, bankroll, opts);
}

/**
 * Expected value (decimal, not %). Optional `taxRate` (0–1) discounts the
 * payout — default 0 (no tax, e.g. Ghana). bot-main hard-coded 0.12 for
 * Poland; leaving it caller-supplied keeps the math jurisdiction-neutral.
 */
export function evNet(p: number, odds: number, taxRate = 0): number {
  if (!(p > 0 && p < 1) || !(odds > 1.01)) return 0;
  return round4(p * odds * (1 - taxRate) - 1);
}

/**
 * Simpler confidence-tier stake — useful when you want a recommended
 * size without supplying a probability. Mirrors bot-main's
 * dynamic_stake(): tiered multiplier on a base stake, capped down on
 * high-variance odds.
 */
export function dynamicStake(confidencePct: number, odds: number, baseStake: number): number {
  let mult: number;
  if (confidencePct >= 80) mult = 1.5;
  else if (confidencePct >= 75) mult = 1.2;
  else if (confidencePct >= 70) mult = 1.0;
  else if (confidencePct >= 65) mult = 0.7;
  else mult = 0.5;
  if (odds > 2.5) mult = Math.min(mult, 0.8);
  return round2(baseStake * mult);
}

function round2(x: number): number { return Math.round(x * 100) / 100; }
function round4(x: number): number { return Math.round(x * 10000) / 10000; }

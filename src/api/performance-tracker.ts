/**
 * Performance Tracker
 *
 * Ported from sportybet-instantvirtual/src/strategies.py (SteadyState class).
 *
 * Tracks prediction/bet performance in-memory:
 * - ROI, win rate, total profit
 * - Max drawdown from peak
 * - Per-market breakdown
 * - Streak tracking (current + max losing streak)
 *
 * Usage:
 *   const tracker = new PerformanceTracker();
 *   tracker.startRound();
 *   tracker.recordBet('1X2:Home', 100, true, 190);   // won
 *   tracker.recordBet('O/U:Over2.5', 100, false, 0);  // lost
 *   tracker.endRound();
 *   console.log(tracker.summary());
 */

export interface MarketStats {
  bets: number;
  wins: number;
  staked: number;
  profit: number;
}

export interface PerformanceSummary {
  totalBets: number;
  totalWins: number;
  winRate: number;
  totalStaked: number;
  totalProfit: number;
  roi: number;
  peakProfit: number;
  maxDrawdown: number;
  currentStreak: number;
  maxStreak: number;
  roundsPlayed: number;
  roundsWon: number;
  roundWinRate: number;
  markets: Record<string, MarketStats>;
}

export class PerformanceTracker {
  private totalBets = 0;
  private totalWins = 0;
  private totalStaked = 0;
  private totalProfit = 0;
  private peakProfit = 0;
  private maxDrawdown = 0;
  private currentStreak = 0;
  private maxStreak = 0;
  private roundsPlayed = 0;
  private roundsWon = 0;
  private roundBetsCount = 0;
  private roundProfit = 0;
  private markets: Record<string, MarketStats> = {};

  get winRate(): number {
    return this.totalBets > 0 ? this.totalWins / this.totalBets : 0;
  }

  get roi(): number {
    return this.totalStaked > 0 ? this.totalProfit / this.totalStaked : 0;
  }

  /** Call before placing bets in a new round. */
  startRound(): void {
    this.roundBetsCount = 0;
    this.roundProfit = 0;
  }

  /**
   * Record the outcome of a single bet.
   *
   * @param marketKey  e.g. "1X2:Home", "O/U:Over2.5", "HT/FT:Away/Home"
   * @param stake      amount wagered
   * @param won        whether the bet won
   * @param payout     amount received (0 if lost, odds * stake if won)
   */
  recordBet(
    marketKey: string,
    stake: number,
    won: boolean,
    payout: number,
  ): void {
    const profit = payout - stake;

    this.totalBets++;
    this.totalStaked += stake;
    this.totalProfit += profit;
    this.roundBetsCount++;
    this.roundProfit += profit;

    if (won) {
      this.totalWins++;
      this.currentStreak = 0;
    } else {
      this.currentStreak++;
      this.maxStreak = Math.max(this.maxStreak, this.currentStreak);
    }

    this.peakProfit = Math.max(this.peakProfit, this.totalProfit);
    const drawdown = this.peakProfit - this.totalProfit;
    this.maxDrawdown = Math.max(this.maxDrawdown, drawdown);

    // Per-market tracking
    if (!this.markets[marketKey]) {
      this.markets[marketKey] = { bets: 0, wins: 0, staked: 0, profit: 0 };
    }
    const ms = this.markets[marketKey]!;
    ms.bets++;
    if (won) ms.wins++;
    ms.staked += stake;
    ms.profit += profit;
  }

  /** Call after a round's results are settled. */
  endRound(): void {
    this.roundsPlayed++;
    if (this.roundProfit > 0) {
      this.roundsWon++;
    }
  }

  /** Get a full performance summary. */
  summary(): PerformanceSummary {
    return {
      totalBets: this.totalBets,
      totalWins: this.totalWins,
      winRate: this.winRate,
      totalStaked: this.totalStaked,
      totalProfit: this.totalProfit,
      roi: this.roi,
      peakProfit: this.peakProfit,
      maxDrawdown: this.maxDrawdown,
      currentStreak: this.currentStreak,
      maxStreak: this.maxStreak,
      roundsPlayed: this.roundsPlayed,
      roundsWon: this.roundsWon,
      roundWinRate:
        this.roundsPlayed > 0
          ? this.roundsWon / this.roundsPlayed
          : 0,
      markets: { ...this.markets },
    };
  }

  /** Reset all stats. */
  reset(): void {
    this.totalBets = 0;
    this.totalWins = 0;
    this.totalStaked = 0;
    this.totalProfit = 0;
    this.peakProfit = 0;
    this.maxDrawdown = 0;
    this.currentStreak = 0;
    this.maxStreak = 0;
    this.roundsPlayed = 0;
    this.roundsWon = 0;
    this.roundBetsCount = 0;
    this.roundProfit = 0;
    this.markets = {};
  }
}

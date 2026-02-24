import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * BettingPros adapter.
 *
 * BettingPros is a Vue 3 app with island architecture that aggregates 150+ expert
 * picks into consensus percentages. Requires browser rendering for Vue hydration.
 *
 * Actual structure (as of 2026-02):
 *   - `div.game-picks-module` — container for all games
 *   - `div.game-picks-card--horizontal` — one per game
 *     - `div.game-picks-card-horizontal__side--left` / `--right` — team sides
 *       - `div.team__name` — team name
 *       - `div.team__percentage` — consensus % (e.g. "77% of Bets")
 *       - `button.odds-cell` — odds display
 *         - `span.odds-cell__line` — line value (e.g. "-8.5")
 *         - `span.odds-cell__cost` — juice (e.g. "(-127)")
 */
export class BettingProsAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'bettingpros',
    name: 'BettingPros',
    baseUrl: 'https://www.bettingpros.com',
    fetchMethod: 'browser',
    paths: {
      nba: '/nba/picks/',
      nfl: '/nfl/picks/',
      mlb: '/mlb/picks/',
      nhl: '/nhl/picks/',
      ncaab: '/college-basketball/picks/',
    },
    cron: '0 0 10,14,18,22 * * *',
    rateLimitMs: 5000,
    maxRetries: 2,
    backoff: { type: 'exponential', delay: 10000 },
  };

  async browserActions(page: Page): Promise<void> {
    await page.waitForSelector('.game-picks-module, .game-picks-card', { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(5000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    const gameDate = fetchedAt.toISOString().split('T')[0]!;

    // Each game card has two sides (left=away, right=home)
    $('div.game-picks-card--horizontal, div.game-picks-card').each((_i, el) => {
      const card = $(el);

      const leftSide = card.find('[class*="side--left"]').first();
      const rightSide = card.find('[class*="side--right"]').first();

      const awayTeamRaw = leftSide.find('.team__name').text().trim()
        || leftSide.find('.team__participant').text().trim();
      const homeTeamRaw = rightSide.find('.team__name').text().trim()
        || rightSide.find('.team__participant').text().trim();

      if (!awayTeamRaw || !homeTeamRaw) return;

      // Extract consensus percentages
      const awayPctText = leftSide.find('.team__percentage').text().trim();
      const homePctText = rightSide.find('.team__percentage').text().trim();
      const awayPct = this.parsePercent(awayPctText);
      const homePct = this.parsePercent(homePctText);

      // Extract spread lines from odds cells
      const awayOddsCells = leftSide.find('.odds-cell');
      const homeOddsCells = rightSide.find('.odds-cell');

      // First odds cell is typically spread
      const awaySpreadLine = this.parseLineValue(awayOddsCells.eq(0).find('.odds-cell__line').text());
      const homeSpreadLine = this.parseLineValue(homeOddsCells.eq(0).find('.odds-cell__line').text());

      // Second odds cell is typically moneyline
      const awayMlLine = this.parseLineValue(awayOddsCells.eq(1).find('.odds-cell__line').text());
      const homeMlLine = this.parseLineValue(homeOddsCells.eq(1).find('.odds-cell__line').text());

      // Third odds cell is typically total
      const overLine = this.parseLineValue(awayOddsCells.eq(2).find('.odds-cell__line').text());

      if (awayPct != null && homePct != null) {
        // Moneyline consensus
        const mlSide: Side = awayPct > homePct ? 'away' : 'home';
        const mlPct = Math.max(awayPct, homePct);

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime: null,
          pickType: 'moneyline',
          side: mlSide,
          value: mlSide === 'away' ? awayMlLine : homeMlLine,
          pickerName: 'BettingPros Consensus',
          confidence: this.mapPctToConfidence(mlPct),
          reasoning: `Consensus: ${awayPct}% ${awayTeamRaw} vs ${homePct}% ${homeTeamRaw}`,
          fetchedAt,
        });

        // Spread consensus (same direction as ML consensus)
        if (awaySpreadLine != null || homeSpreadLine != null) {
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw,
            awayTeamRaw,
            gameDate,
            gameTime: null,
            pickType: 'spread',
            side: mlSide,
            value: mlSide === 'away' ? awaySpreadLine : homeSpreadLine,
            pickerName: 'BettingPros Consensus',
            confidence: this.mapPctToConfidence(mlPct),
            reasoning: `Consensus: ${mlPct}% on ${mlSide}`,
            fetchedAt,
          });
        }

        // Over/under — use total line if available
        if (overLine != null) {
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw,
            awayTeamRaw,
            gameDate,
            gameTime: null,
            pickType: 'over_under',
            side: 'over',
            value: overLine,
            pickerName: 'BettingPros Consensus',
            confidence: null,
            reasoning: null,
            fetchedAt,
          });
        }
      }
    });

    return predictions;
  }

  private parsePercent(text: string): number | null {
    const match = text.match(/(\d+)\s*%/);
    return match ? parseInt(match[1]!, 10) : null;
  }

  private parseLineValue(text: string): number | null {
    const cleaned = text.trim();
    if (!cleaned) return null;
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  }

  private mapPctToConfidence(pct: number): Confidence {
    if (pct >= 75) return 'best_bet';
    if (pct >= 65) return 'high';
    if (pct >= 55) return 'medium';
    return 'low';
  }
}

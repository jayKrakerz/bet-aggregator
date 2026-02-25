import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * BettingPros adapter.
 *
 * BettingPros is a Vue 3 app with island architecture that aggregates expert
 * picks into consensus percentages. Requires browser rendering for Vue hydration.
 *
 * The page has two data regions:
 *
 * 1. **Game Picks Card** (`.game-picks-card--horizontal`) — ONE featured game
 *    with a detailed pick view, star rating, and tailing percentage.
 *
 * 2. **Bet Signal Cards** (`.bet-signal` inside `.bet-signals-module__carousel`)
 *    — ALL games in a horizontal carousel. Each card contains:
 *      - Two `.info__team` blocks: first = away, second = home (separated by "@")
 *        - `h3.team__name` — short team name (e.g. "76ers")
 *        - `.participant-image img[alt]` — logo with city in alt (e.g. "Philadelphia Logo")
 *        - `.odds-cell__line` — spread/line value (e.g. "-6.0")
 *        - `.odds-cell__cost` — juice (e.g. "(-116)")
 *        - `.percentage--bets .percentage__heading` — consensus % (e.g. "73% of Bets")
 *      - `.bs-card-footer` — date/time text (e.g. "2/25 12:00am")
 *      - `.bs-card-footer__matchup-link` — href with full team-name slugs
 *
 * The default market is "Spread". A dropdown allows switching to "Total Points"
 * or "Moneyline", but only one market is visible per page load.
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
    // Wait for Vue to hydrate and the bet-signal carousel to render
    await page.waitForSelector('.bet-signal, .game-picks-card', { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(5000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    const gameDate = fetchedAt.toISOString().split('T')[0]!;

    // --- Strategy A: Parse bet-signal carousel cards (contains ALL games) ---
    const betSignals = $('div.bet-signal');
    if (betSignals.length > 0) {
      betSignals.each((_i, el) => {
        const card = $(el);
        const teamEls = card.find('.info__team');
        if (teamEls.length < 2) return;

        const awayTeamEl = $(teamEls[0]!);
        const homeTeamEl = $(teamEls[1]!);

        // Build full team name: city from logo alt + short name from h3
        const awayTeamRaw = this.buildTeamName(
          awayTeamEl.find('.participant-image img').first().attr('alt') || '',
          awayTeamEl.find('.team__name').text().trim(),
        );
        const homeTeamRaw = this.buildTeamName(
          homeTeamEl.find('.participant-image img').first().attr('alt') || '',
          homeTeamEl.find('.team__name').text().trim(),
        );

        if (!awayTeamRaw || !homeTeamRaw) return;

        // Extract consensus percentages from "X% of Bets"
        const awayPctText = awayTeamEl.find('.percentage--bets .percentage__heading').text().trim();
        const homePctText = homeTeamEl.find('.percentage--bets .percentage__heading').text().trim();
        const awayPct = this.parsePercent(awayPctText);
        const homePct = this.parsePercent(homePctText);

        // Extract spread lines from odds cells
        const awaySpreadLine = this.parseLineValue(awayTeamEl.find('.odds-cell__line').first().text());
        const homeSpreadLine = this.parseLineValue(homeTeamEl.find('.odds-cell__line').first().text());

        // Extract game time from footer
        const gameTime = card.find('.bs-card-footer .typography').text().trim() || null;

        if (awayPct != null && homePct != null) {
          const side: Side = awayPct > homePct ? 'away' : 'home';
          const pct = Math.max(awayPct, homePct);

          // Spread consensus pick
          if (awaySpreadLine != null || homeSpreadLine != null) {
            predictions.push({
              sourceId: this.config.id,
              sport,
              homeTeamRaw,
              awayTeamRaw,
              gameDate,
              gameTime,
              pickType: 'spread',
              side,
              value: side === 'away' ? awaySpreadLine : homeSpreadLine,
              pickerName: 'BettingPros Consensus',
              confidence: this.mapPctToConfidence(pct),
              reasoning: `Consensus: ${awayPct}% ${awayTeamRaw} vs ${homePct}% ${homeTeamRaw}`,
              fetchedAt,
            });
          }
        }
      });
    }

    // --- Strategy B: Fallback to game-picks-card (old layout or featured card) ---
    if (predictions.length === 0) {
      $('div.game-picks-card--horizontal, div.game-picks-card').each((_i, el) => {
        const card = $(el);

        // Old layout: left/right sides with team__name and team__percentage
        const leftSide = card.find('[class*="side--left"]').first();
        const rightSide = card.find('[class*="side--right"]').first();

        const awayTeamRaw = leftSide.find('.team__name').text().trim()
          || leftSide.find('.team__participant').text().trim();
        const homeTeamRaw = rightSide.find('.team__name').text().trim()
          || rightSide.find('.team__participant').text().trim();

        if (!awayTeamRaw || !homeTeamRaw) return;

        // Try old-style percentage elements first
        let awayPctText = leftSide.find('.team__percentage').text().trim();
        let homePctText = rightSide.find('.team__percentage').text().trim();

        // Fall back to new-style percentage elements
        if (!awayPctText) {
          awayPctText = leftSide.find('.percentage--bets .percentage__heading').text().trim();
        }
        if (!homePctText) {
          homePctText = rightSide.find('.percentage--bets .percentage__heading').text().trim();
        }

        const awayPct = this.parsePercent(awayPctText);
        const homePct = this.parsePercent(homePctText);

        // Extract spread lines from odds cells
        const awayOddsCells = leftSide.find('.odds-cell');
        const homeOddsCells = rightSide.find('.odds-cell');

        const awaySpreadLine = this.parseLineValue(awayOddsCells.eq(0).find('.odds-cell__line').text());
        const homeSpreadLine = this.parseLineValue(homeOddsCells.eq(0).find('.odds-cell__line').text());

        const awayMlLine = this.parseLineValue(awayOddsCells.eq(1).find('.odds-cell__line').text());
        const homeMlLine = this.parseLineValue(homeOddsCells.eq(1).find('.odds-cell__line').text());

        const overLine = this.parseLineValue(awayOddsCells.eq(2).find('.odds-cell__line').text());

        if (awayPct != null && homePct != null) {
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
    }

    return predictions;
  }

  /** Combine city from logo alt text with short team name. */
  private buildTeamName(logoAlt: string, shortName: string): string {
    const city = logoAlt.replace(/\s*Logo$/i, '').trim();
    if (city && shortName) return `${city} ${shortName}`;
    return shortName || city || '';
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

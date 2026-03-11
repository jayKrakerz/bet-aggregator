import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * OddsChecker Tennis adapter (oddschecker.com/tennis).
 *
 * OddsChecker is a major odds comparison site. The tennis section shows
 * upcoming matches with best available odds from multiple bookmakers.
 * Requires browser rendering as odds are loaded dynamically.
 *
 * Actual page structure (verified from snapshot 2026-03-10):
 *   - Tournament headers: `tr.hda-header` with `.beta-headline` for tournament name
 *   - Match rows: `tr.match-on[data-mid]`
 *   - Player names: `p.fixtures-bet-name` (player1 first, player2 second)
 *   - Odds cells: `td.basket-add[data-best-dig]` (player1 odds first, player2 odds second)
 *   - Event time: `.time-digits` inside `td.time`
 *   - Event name: `a[data-event-name]` with "Player1 v Player2" format
 */
export class OddsCheckerTennisAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'oddschecker-tennis',
    name: 'OddsChecker Tennis',
    baseUrl: 'https://www.oddschecker.com',
    fetchMethod: 'browser',
    paths: {
      tennis: '/tennis',
    },
    cron: '0 0 6,12,18 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 8000 },
  };

  async browserActions(page: Page): Promise<void> {
    await page.waitForSelector('tr.match-on, tr.hda-header', {
      timeout: 15000,
    }).catch(() => {});
    await page.waitForTimeout(3000);
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const todayStr = fetchedAt.toISOString().split('T')[0]!;

    // Track current tournament from section headers
    let currentTournament = '';

    // Iterate all table rows in order to track tournament context
    $('table.standard-list tr').each((_i, el) => {
      const $row = $(el);

      // Update tournament from header rows
      if ($row.hasClass('hda-header')) {
        const tournamentText = $row.find('.beta-headline').text().trim();
        if (tournamentText) {
          currentTournament = tournamentText;
        }
        return;
      }

      // Only process match rows
      if (!$row.hasClass('match-on')) return;

      // Extract player names from p.fixtures-bet-name
      const nameEls = $row.find('p.fixtures-bet-name');
      if (nameEls.length < 2) return;

      const player1 = nameEls.eq(0).text().trim();
      const player2 = nameEls.eq(1).text().trim();
      if (!player1 || !player2) return;

      // Extract best decimal odds from data-best-dig attributes
      const oddsCells = $row.find('td.basket-add[data-best-dig]');
      let player1Odds = 0;
      let player2Odds = 0;
      if (oddsCells.length >= 2) {
        player1Odds = this.parseDecimalOdds(oddsCells.eq(0).attr('data-best-dig') || '');
        player2Odds = this.parseDecimalOdds(oddsCells.eq(1).attr('data-best-dig') || '');
      }

      // Extract game time
      const timeText = $row.find('.time-digits').text().trim();
      const gameTime = timeText || null;

      // Lower decimal odds = more likely winner
      // Player1 = "home", Player2 = "away" for consistency
      let side: Side = 'home';
      if (player1Odds > 0 && player2Odds > 0) {
        side = player1Odds <= player2Odds ? 'home' : 'away';
      }

      const confidence = this.oddsToConfidence(player1Odds, player2Odds);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: player1,
        awayTeamRaw: player2,
        gameDate: todayStr,
        gameTime,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'OddsChecker Best Odds',
        confidence,
        reasoning: [
          currentTournament || null,
          player1Odds > 0 && player2Odds > 0
            ? `Best odds: ${player1} ${player1Odds.toFixed(2)} / ${player2} ${player2Odds.toFixed(2)}`
            : null,
        ].filter(Boolean).join(' | ') || null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseDecimalOdds(text: string): number {
    if (!text) return 0;
    // Handle fractional odds like "3/1"
    const fracMatch = text.match(/^(\d+)\/(\d+)$/);
    if (fracMatch) {
      return (parseFloat(fracMatch[1]!) / parseFloat(fracMatch[2]!)) + 1;
    }
    const dec = parseFloat(text);
    return Number.isNaN(dec) ? 0 : dec;
  }

  private oddsToConfidence(odds1: number, odds2: number): RawPrediction['confidence'] {
    if (odds1 <= 0 || odds2 <= 0) return null;
    const favoriteOdds = Math.min(odds1, odds2);
    if (favoriteOdds >= 1.0 && favoriteOdds <= 1.5) return 'best_bet';
    if (favoriteOdds > 1.5 && favoriteOdds <= 2.0) return 'high';
    if (favoriteOdds > 2.0 && favoriteOdds <= 3.0) return 'medium';
    return 'low';
  }
}

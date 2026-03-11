import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * OddsChecker NBA adapter (oddschecker.com/basketball/nba).
 *
 * OddsChecker is a major odds comparison site. The NBA section shows
 * upcoming games with best available odds from multiple bookmakers.
 * Requires browser rendering as odds are loaded dynamically.
 *
 * Actual page structure (verified from snapshot 2026-03-10):
 *   - Match rows: `tr.match-on[data-mid]`
 *   - Team names: `p.fixtures-bet-name` (first = away, second = home)
 *   - Odds cells: `td.basket-add[data-best-dig]` (first = away odds, second = home odds)
 *   - Event time: `.time-digits` inside `td.time`
 *   - Date headers: `tr.hda-header` with `.event-date` text and `data-day` attr
 *   - Event name: `a[data-event-name]` with "Away at Home" format
 */
export class OddsCheckerNbaAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'oddschecker-nba',
    name: 'OddsChecker NBA',
    baseUrl: 'https://www.oddschecker.com',
    fetchMethod: 'browser',
    paths: {
      nba: '/basketball/nba',
    },
    cron: '0 0 9,15,21 * * *',
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
    const processedGames = new Set<string>();

    // Parse match rows - each tr.match-on has two teams and two odds cells
    $('tr.match-on').each((_i, el) => {
      const $row = $(el);

      // Extract team names from p.fixtures-bet-name (away first, home second)
      const nameEls = $row.find('p.fixtures-bet-name');
      if (nameEls.length < 2) return;

      const awayTeam = nameEls.eq(0).text().trim();
      const homeTeam = nameEls.eq(1).text().trim();
      if (!homeTeam || !awayTeam) return;

      // Dedup
      const gameKey = `${awayTeam}|${homeTeam}`;
      if (processedGames.has(gameKey)) return;
      processedGames.add(gameKey);

      // Extract best decimal odds from data-best-dig attributes on td.basket-add
      const oddsCells = $row.find('td.basket-add[data-best-dig]');
      let awayOdds = 0;
      let homeOdds = 0;
      if (oddsCells.length >= 2) {
        awayOdds = this.parseDecimalOdds(oddsCells.eq(0).attr('data-best-dig') || '');
        homeOdds = this.parseDecimalOdds(oddsCells.eq(1).attr('data-best-dig') || '');
      }

      // Extract game time from .time-digits
      const timeText = $row.find('.time-digits').text().trim();
      const gameTime = timeText || null;

      // Lower decimal odds = more likely winner
      let side: Side = 'home';
      if (homeOdds > 0 && awayOdds > 0) {
        side = homeOdds <= awayOdds ? 'home' : 'away';
      }

      const confidence = this.oddsToConfidence(homeOdds, awayOdds);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: homeTeam,
        awayTeamRaw: awayTeam,
        gameDate: todayStr,
        gameTime,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'OddsChecker Best Odds',
        confidence,
        reasoning: homeOdds > 0 && awayOdds > 0
          ? `Best odds: ${awayTeam} ${awayOdds.toFixed(2)} / ${homeTeam} ${homeOdds.toFixed(2)}`
          : null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseDecimalOdds(text: string): number {
    if (!text) return 0;
    // Handle fractional odds like "11/8"
    const fracMatch = text.match(/^(\d+)\/(\d+)$/);
    if (fracMatch) {
      return (parseFloat(fracMatch[1]!) / parseFloat(fracMatch[2]!)) + 1;
    }
    const dec = parseFloat(text);
    return Number.isNaN(dec) ? 0 : dec;
  }

  private oddsToConfidence(homeOdds: number, awayOdds: number): RawPrediction['confidence'] {
    if (homeOdds <= 0 || awayOdds <= 0) return null;
    const favoriteOdds = Math.min(homeOdds, awayOdds);
    if (favoriteOdds >= 1.0 && favoriteOdds <= 1.5) return 'best_bet';
    if (favoriteOdds > 1.5 && favoriteOdds <= 2.0) return 'high';
    if (favoriteOdds > 2.0 && favoriteOdds <= 3.0) return 'medium';
    return 'low';
  }
}

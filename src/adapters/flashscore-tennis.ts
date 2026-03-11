import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * FlashScore Tennis adapter (flashscore.com/tennis).
 *
 * FlashScore is an SPA that renders match data via JavaScript. Requires
 * browser rendering to capture the fully hydrated DOM.
 *
 * Expected page structure (after browser render):
 *   - Match rows: `.event__match`, `div[class*="event__match"]`
 *   - Player names: `.event__participant--home`, `.event__participant--away`
 *     or `div[class*="participant"]` elements
 *   - Start time: `.event__time` with "HH:MM" format
 *   - Odds: `.event__odds span` or `[class*="odds"]` cells
 *   - Date headers: `.event__header` grouping matches by date
 *   - Tournament: `.event__title` or header with tournament name
 */
export class FlashscoreTennisAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'flashscore-tennis',
    name: 'FlashScore Tennis',
    baseUrl: 'https://www.flashscore.com',
    fetchMethod: 'browser',
    paths: {
      tennis: '/tennis/',
    },
    cron: '0 0 6,12,18 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 8000 },
  };

  async browserActions(page: Page): Promise<void> {
    // Wait for match rows to render
    await page.waitForSelector('.event__match, [class*="event__match"]', {
      timeout: 15000,
    }).catch(() => {});
    await page.waitForTimeout(3000);
    // Scroll to load more matches
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    let currentDate = fetchedAt.toISOString().split('T')[0]!;
    let currentTournament = '';

    // Process all event elements in order
    $('.sportName.tennis .event__header, .event__match, [class*="event__header"], [class*="event__match"]').each((_i, el) => {
      const $el = $(el);
      const cls = $el.attr('class') || '';

      // Date/tournament headers
      if (cls.includes('header')) {
        const headerText = $el.text().trim();
        const dateMatch = headerText.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        if (dateMatch) {
          currentDate = `${dateMatch[3]}-${dateMatch[2]!.padStart(2, '0')}-${dateMatch[1]!.padStart(2, '0')}`;
        }
        const tourEl = $el.find('.event__title--name, [class*="title"]').text().trim();
        if (tourEl) currentTournament = tourEl;
        return;
      }

      // Match rows
      const homeEl = $el.find('.event__participant--home, [class*="participant--home"], .event__participant:first-child');
      const awayEl = $el.find('.event__participant--away, [class*="participant--away"], .event__participant:last-child');

      const player1 = homeEl.text().trim();
      const player2 = awayEl.text().trim();
      if (!player1 || !player2) return;

      // Extract time
      const timeText = $el.find('.event__time, [class*="event__time"]').first().text().trim();
      const timeMatch = timeText.match(/(\d{1,2}:\d{2})/);
      const gameTime = timeMatch ? timeMatch[1]! : null;

      // Extract odds to determine favorite
      const oddsEls = $el.find('.event__odds span, [class*="odds"] span, .odds-value');
      let homeOdds = 0;
      let awayOdds = 0;
      if (oddsEls.length >= 2) {
        homeOdds = parseFloat($(oddsEls[0]).text().trim()) || 0;
        awayOdds = parseFloat($(oddsEls[1]).text().trim()) || 0;
      }

      // Lower decimal odds = more likely winner
      let side: Side = 'home';
      if (homeOdds > 0 && awayOdds > 0) {
        side = homeOdds <= awayOdds ? 'home' : 'away';
      }

      const confidence = this.oddsToConfidence(homeOdds, awayOdds);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: player1,
        awayTeamRaw: player2,
        gameDate: currentDate,
        gameTime,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'FlashScore Odds',
        confidence,
        reasoning: currentTournament
          ? `${currentTournament} | Odds: ${homeOdds || '?'} - ${awayOdds || '?'}`
          : (homeOdds > 0 ? `Odds: ${homeOdds} - ${awayOdds}` : null),
        fetchedAt,
      });
    });

    return predictions;
  }

  private oddsToConfidence(homeOdds: number, awayOdds: number): RawPrediction['confidence'] {
    if (homeOdds <= 0 || awayOdds <= 0) return null;
    const favoriteOdds = Math.min(homeOdds, awayOdds);
    // Decimal odds to implied probability: 1/odds
    const impliedProb = (1 / favoriteOdds) * 100;
    if (impliedProb >= 80) return 'best_bet';
    if (impliedProb >= 65) return 'high';
    if (impliedProb >= 50) return 'medium';
    return 'low';
  }
}

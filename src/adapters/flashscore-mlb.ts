import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * FlashScore MLB adapter (flashscore.com/baseball/usa/mlb/).
 *
 * FlashScore is an SPA that renders match data via JavaScript. Requires
 * browser rendering to capture the fully hydrated DOM.
 *
 * Actual page structure (2026 DOM):
 *   - Match rows: `div.event__match` (with modifiers --scheduled, --static, --twoLine)
 *   - Team names: `div.event__participant--home`, `div.event__participant--away`
 *   - Start time: `div.event__time` — "HH:MM" for today, "DD.MM. HH:MM" for future
 *   - Scores: `span.event__score--home`, `span.event__score--away`
 *   - Match stage: `div.event__stage` — "Finished", empty for scheduled
 *   - Sections: `div.leagues--static.summary-fixtures` (upcoming)
 *   - No odds data in match rows; no date header elements
 */
export class FlashscoreMlbAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'flashscore-mlb',
    name: 'FlashScore MLB',
    baseUrl: 'https://www.flashscore.com',
    fetchMethod: 'browser',
    paths: {
      mlb: '/baseball/usa/mlb/',
    },
    cron: '0 0 9,15,21 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 8000 },
  };

  async browserActions(page: Page): Promise<void> {
    // Wait for match rows to render
    await page.waitForSelector('div.event__match', {
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
    const todayStr = fetchedAt.toISOString().split('T')[0]!;

    // Only process scheduled/upcoming matches, not finished results.
    // Scheduled matches have the event__match--scheduled class modifier.
    $('div.event__match[class*="--scheduled"]').each((_i, el) => {
      const $el = $(el);

      // Extract team names
      const homeTeam = $el.find('.event__participant--home').text().trim();
      const awayTeam = $el.find('.event__participant--away').text().trim();
      if (!homeTeam || !awayTeam) return;

      // Skip matches in the past results section
      const parentSection = $el.closest('[class*="summary-results"]');
      if (parentSection.length > 0) return;

      // Extract time — "HH:MM" for today or "DD.MM. HH:MM" for future dates
      const timeText = $el.find('.event__time').first().text().trim();
      let gameDate = todayStr;
      let gameTime: string | null = null;

      const futureDateMatch = timeText.match(/(\d{1,2})\.(\d{1,2})\.\s*(\d{1,2}:\d{2})/);
      if (futureDateMatch) {
        // DD.MM. HH:MM format — derive year from fetchedAt
        const day = futureDateMatch[1]!.padStart(2, '0');
        const month = futureDateMatch[2]!.padStart(2, '0');
        const year = fetchedAt.getFullYear();
        gameDate = `${year}-${month}-${day}`;
        gameTime = futureDateMatch[3]!;
      } else {
        const timeMatch = timeText.match(/(\d{1,2}:\d{2})/);
        if (timeMatch) {
          gameTime = timeMatch[1]!;
        }
      }

      // No odds data available in match rows — default to home with null confidence
      const side: Side = 'home';

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: homeTeam,
        awayTeamRaw: awayTeam,
        gameDate,
        gameTime,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'FlashScore Listing',
        confidence: null,
        reasoning: null,
        fetchedAt,
      });
    });

    return predictions;
  }
}

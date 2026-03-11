import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * FlashScore Soccer adapter (flashscore.com/football).
 *
 * SPA that renders match data via JavaScript. Requires browser rendering.
 * Same site structure as flashscore-tennis but for football/soccer matches.
 *
 * Expected page structure (after browser render):
 *   - Match rows: `.event__match`, `div[class*="event__match"]`
 *   - Home team: `.event__participant--home`, `.event__participant:first-child`,
 *     `div[class*="participant--home"]`
 *   - Away team: `.event__participant--away`, `.event__participant:last-child`,
 *     `div[class*="participant--away"]`
 *   - Start time: `.event__time` with "HH:MM" format
 *   - Odds: `.event__odds span`, `[class*="odds"]` cells (1 X 2)
 *   - Date headers: `.event__header` grouping matches by date
 *   - Tournament: `.event__title--name`, `[class*="title"]`
 */
export class FlashscoreSoccerAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'flashscore-soccer',
    name: 'FlashScore Soccer',
    baseUrl: 'https://www.flashscore.com',
    fetchMethod: 'browser',
    paths: {
      football: '/football/',
    },
    cron: '0 0 6,12,18 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 8000 },
  };

  async browserActions(page: Page): Promise<void> {
    // Wait for match rows to render - FlashScore uses event__match divs
    await page.waitForSelector(
      'div[class*="event__match"], [class*="sportName"]',
      { timeout: 15000 },
    ).catch(() => {});
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

    // FlashScore renders match data as divs with class containing "event__match"
    // Team names use "homeParticipant" / "awayParticipant" class fragments
    // Headers use "header__" class fragments for tournament grouping
    // Time elements use "event__time" class fragment

    // Process all elements that look like headers or matches
    $('div[class*="sportName"] div, div[class*="leagues--live"] div, div[class*="event__"]').each((_i, el) => {
      const $el = $(el);
      const cls = $el.attr('class') || '';

      // Tournament/date headers
      if (cls.includes('header__')) {
        const headerText = $el.text().trim();
        const dateMatch = headerText.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        if (dateMatch) {
          currentDate = `${dateMatch[3]}-${dateMatch[2]!.padStart(2, '0')}-${dateMatch[1]!.padStart(2, '0')}`;
        }
        // Extract tournament name from header
        if (headerText && headerText.length > 3 && headerText.length < 200) {
          currentTournament = headerText.split('\n')[0]?.trim() || currentTournament;
        }
        return;
      }

      // Match rows - look for event__match class
      if (!cls.includes('event__match')) return;

      // Parse teams using homeParticipant / awayParticipant class patterns
      const homeEl = $el.find(
        '[class*="homeParticipant"], [class*="participant--home"], .event__participant--home',
      );
      const awayEl = $el.find(
        '[class*="awayParticipant"], [class*="participant--away"], .event__participant--away',
      );

      let home = homeEl.first().text().trim();
      let away = awayEl.first().text().trim();

      // Fallback: look for participant divs by position
      if (!home || !away) {
        const participants = $el.find('[class*="participant"]');
        if (participants.length >= 2) {
          home = $(participants[0]).text().trim();
          away = $(participants[1]).text().trim();
        }
      }

      if (!home || !away || home === away) return;

      // Extract time
      const timeEl = $el.find('[class*="event__time"]');
      const timeText = timeEl.first().text().trim();
      const timeMatch = timeText.match(/(\d{1,2}:\d{2})/);
      const gameTime = timeMatch ? timeMatch[1]! : null;

      // Extract odds - FlashScore shows odds in span/div elements
      const oddsValues: number[] = [];
      $el.find('[class*="odds"] span, [class*="odds"] div, [class*="odds__"]').each((_j, oe) => {
        const t = $(oe).text().trim();
        const val = parseFloat(t);
        if (!isNaN(val) && val >= 1.01 && val <= 100 && /^\d+\.\d{2}$/.test(t)) {
          oddsValues.push(val);
        }
      });

      let odds1 = 0;
      let oddsX = 0;
      let odds2 = 0;

      if (oddsValues.length >= 3) {
        odds1 = oddsValues[0]!;
        oddsX = oddsValues[1]!;
        odds2 = oddsValues[2]!;
      } else if (oddsValues.length >= 2) {
        odds1 = oddsValues[0]!;
        odds2 = oddsValues[1]!;
      }

      // Determine side from odds (lowest = most likely)
      const side = this.oddsToSide(odds1, oddsX, odds2);
      const confidence = this.oddsToConfidence(odds1, oddsX, odds2);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: home,
        awayTeamRaw: away,
        gameDate: currentDate,
        gameTime,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'FlashScore Odds',
        confidence,
        reasoning: currentTournament
          ? `${currentTournament} | Odds: ${odds1 || '?'} / ${oddsX || '?'} / ${odds2 || '?'}`
          : (odds1 > 0 ? `Odds: ${odds1} / ${oddsX} / ${odds2}` : null),
        fetchedAt,
      });
    });

    return predictions;
  }

  private oddsToSide(odds1: number, oddsX: number, odds2: number): Side {
    const min = Math.min(
      odds1 > 0 ? odds1 : Infinity,
      oddsX > 0 ? oddsX : Infinity,
      odds2 > 0 ? odds2 : Infinity,
    );
    if (min === odds1) return 'home';
    if (min === odds2) return 'away';
    if (min === oddsX) return 'draw';
    return 'home';
  }

  private oddsToConfidence(odds1: number, oddsX: number, odds2: number): Confidence | null {
    const min = Math.min(
      odds1 > 0 ? odds1 : Infinity,
      oddsX > 0 ? oddsX : Infinity,
      odds2 > 0 ? odds2 : Infinity,
    );
    if (min === Infinity) return null;
    const impliedProb = (1 / min) * 100;
    if (impliedProb >= 75) return 'best_bet';
    if (impliedProb >= 60) return 'high';
    if (impliedProb >= 45) return 'medium';
    return 'low';
  }
}

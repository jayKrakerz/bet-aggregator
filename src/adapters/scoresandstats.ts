import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * ScoresAndStats adapter.
 *
 * WordPress site with picks loaded via AJAX (rdg-blocks plugin).
 * Requires Playwright for rendering. Pick structure:
 *   div.pick.has-background       - pick card container
 *   div.team-name                 - team names (in .team-a / .team-b)
 *   div.date-time                 - game date/time
 *   div.pick-header               - pick header info
 *   div.pick-body                 - pick body with prediction
 */
export class ScoresAndStatsAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'scoresandstats',
    name: 'Scores & Stats',
    baseUrl: 'https://www.scoresandstats.com',
    fetchMethod: 'browser',
    paths: {
      nba: '/picks/nba/',
      nfl: '/picks/nfl/',
      mlb: '/picks/mlb/',
      nhl: '/picks/nhl/',
    },
    cron: '0 0 10,14,18 * * *',
    rateLimitMs: 5000,
    maxRetries: 2,
    backoff: { type: 'exponential', delay: 10000 },
  };

  async browserActions(page: Page): Promise<void> {
    // Wait for GenerateBlocks loop items (new structure) or legacy pick cards
    await page.waitForSelector('.gb-loop-item, div.pick, div.team-name', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // --- New structure: GenerateBlocks .gb-loop-item cards ---
    // Each card has:
    //   span.posttitlelink — "{Away} VS {Home}" text
    //   span (date) — "YYYY-MM-DD" date text
    //   a[href*="/previews/"] — link to full preview
    //   p (teaser) — preview paragraph
    const loopItems = $('.gb-loop-item');
    if (loopItems.length > 0) {
      loopItems.each((_i, el) => {
        const $item = $(el);

        // Extract matchup from the title span (class contains "posttitlelink")
        const titleText = $item.find('.posttitlelink, [class*="posttitlelink"]').text().trim();
        if (!titleText) return;

        // Parse "{TeamA} VS {TeamB}" — TeamA is listed first (home in SAS convention)
        const vsMatch = titleText.match(/^(.+?)\s+VS\s+(.+)$/i);
        if (!vsMatch) return;

        const homeTeamRaw = vsMatch[1]!.trim();
        const awayTeamRaw = vsMatch[2]!.trim();

        // Extract date (looks for YYYY-MM-DD text in the card)
        let gameDate = fetchedAt.toISOString().split('T')[0]!;
        $item.find('span').each((_j, span) => {
          const spanText = $(span).text().trim();
          const dateMatch = spanText.match(/^(\d{4}-\d{2}-\d{2})$/);
          if (dateMatch) {
            gameDate = dateMatch[1]!;
            return false; // break
          }
        });

        // Fallback date parsing from longer text
        if (gameDate === fetchedAt.toISOString().split('T')[0]!) {
          const allText = $item.text();
          const altDate = this.parseDateText(allText);
          if (altDate) gameDate = altDate;
        }

        // Extract teaser text for reasoning
        const teaser = $item.find('p').first().text().trim().slice(0, 300);

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime: null,
          pickType: 'moneyline',
          side: 'home',
          value: null,
          pickerName: 'Scores & Stats',
          confidence: 'medium',
          reasoning: teaser || null,
          fetchedAt,
        });
      });

      return predictions;
    }

    // --- Legacy structure: div.pick cards ---
    $('div.pick').each((_i, el) => {
      const $pick = $(el);

      const teamA = $pick.find('.team-a .team-name').text().trim();
      const teamB = $pick.find('.team-b .team-name').text().trim();
      if (!teamA || !teamB) return;

      const dateTime = $pick.find('.date-time').text().trim();
      const gameDate = this.parseDateText(dateTime) || fetchedAt.toISOString().split('T')[0]!;

      const pickBody = $pick.find('.pick-body').text().trim();
      const pickHeader = $pick.find('.pick-header').text().trim();

      const scores = $pick.find('.score-score');
      let scoreA = 0;
      let scoreB = 0;
      if (scores.length >= 2) {
        scoreA = parseInt($(scores[0]).text().trim(), 10) || 0;
        scoreB = parseInt($(scores[1]).text().trim(), 10) || 0;
      }

      let side: Side = 'home';
      if (scoreA > 0 && scoreB > 0) {
        side = scoreB >= scoreA ? 'home' : 'away';
      }

      const pickType = this.inferPickType(pickBody + ' ' + pickHeader);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: teamB,
        awayTeamRaw: teamA,
        gameDate,
        gameTime: dateTime || null,
        pickType,
        side,
        value: null,
        pickerName: 'Scores & Stats',
        confidence: 'medium',
        reasoning: scoreA && scoreB ? `Predicted: ${teamA} ${scoreA} - ${teamB} ${scoreB}` : null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseDateText(text: string): string | null {
    // Various date formats
    const match = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (match) {
      return `${match[3]}-${match[1]!.padStart(2, '0')}-${match[2]!.padStart(2, '0')}`;
    }

    const months: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const mMatch = text.match(/(\w{3,})\s+(\d{1,2}),?\s+(\d{4})/i);
    if (mMatch) {
      const m = months[mMatch[1]!.toLowerCase().slice(0, 3)];
      if (m) return `${mMatch[3]}-${m}-${mMatch[2]!.padStart(2, '0')}`;
    }

    return null;
  }
}
